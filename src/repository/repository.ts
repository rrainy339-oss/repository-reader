import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_FILES = 800;
const MAX_SEARCH_BYTES = 12 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function excluded(name: string): boolean {
  const lower = name.toLowerCase();
  return ['.git', 'node_modules', '.npm-cache', '.ssh', '.aws', '.npmrc'].includes(lower)
    || /^\.env(?:\.|$)/.test(lower)
    || /\.(?:key|pem|p12|pfx)$/.test(lower);
}

function normalizePath(input: string): string {
  const path = input.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (input === '.' || input === './') return '.';
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..'
    || /[:\x00-\x1f]/.test(part) || excluded(part))) {
    throw new Error('Use an in-scope, repository-relative path.');
  }
  return path;
}

function childPath(directory: string, name: string): string {
  return directory === '.' ? name : `${directory}/${name}`;
}

class UnsupportedFile extends Error {}

export type SourceLines = {
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
};

export class Repository {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(directory: string): Promise<Repository> {
    const root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) throw new Error('Repository path must be a directory.');
    return new Repository(root);
  }

  private async resolvePath(input: string) {
    const path = normalizePath(input);
    const absolute = resolve(this.root, path);
    const canonical = await realpath(absolute);
    const fromRoot = relative(this.root, canonical);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
      || relative(absolute, canonical) !== '') {
      throw new Error('Linked paths and paths outside the repository are excluded.');
    }
    const info = await lstat(absolute);
    if (!info.isDirectory() && !info.isFile()) throw new UnsupportedFile('Not a regular file or directory.');
    return { path, absolute: canonical, info };
  }

  private async entries(directory: string) {
    const { absolute, info } = await this.resolvePath(directory);
    if (!info.isDirectory()) throw new Error('Expected a directory.');
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries.filter((entry) => !excluded(entry.name) && (entry.isDirectory() || entry.isFile()))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  async listFiles(directory = '.', offset = 0, limit = 100) {
    const path = normalizePath(directory);
    const entries = await this.entries(path);
    return {
      path,
      entries: entries.slice(offset, offset + limit).map((entry) => ({
        path: childPath(path, entry.name),
        type: entry.isDirectory() ? 'directory' : 'file',
      })),
      nextOffset: offset + limit < entries.length ? offset + limit : null,
    };
  }

  private async readText(input: string) {
    const { path, absolute, info } = await this.resolvePath(input);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      throw new UnsupportedFile('Only regular text files up to 512 KiB are supported.');
    }
    const file = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_FILE_BYTES + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== info.size) throw new UnsupportedFile('File size changed while reading.');
      const bytes = buffer.subarray(0, offset);
      if (bytes.includes(0)) throw new UnsupportedFile('Binary file.');
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        throw new UnsupportedFile('File is not UTF-8 text.');
      }
      const lines = text ? text.split(/\r\n|\n|\r/) : [];
      if (lines.at(-1) === '') lines.pop();
      return { path, lines, bytes };
    } finally {
      await file.close();
    }
  }

  async readLines(path: string, startLine: number, endLine: number) {
    const source = await this.readText(path);
    if (startLine > source.lines.length || endLine < startLine) {
      throw new Error(`Invalid line range. The file has ${source.lines.length} lines.`);
    }
    const lastLine = Math.min(endLine, startLine + 79, source.lines.length);
    const lines: { line: number; text: string; truncated?: boolean }[] = [];
    let characters = 0;
    for (let line = startLine; line <= lastLine && characters < 10_000; line++) {
      const text = source.lines[line - 1];
      const cap = Math.min(800, 10_000 - characters);
      lines.push({ line, text: text.slice(0, cap), ...(text.length > cap ? { truncated: true } : {}) });
      characters += Math.min(text.length, cap);
    }
    return {
      path: source.path,
      startLine,
      endLine: lines.at(-1)!.line,
      totalLines: source.lines.length,
      sha256: createHash('sha256').update(source.bytes).digest('hex'),
      lines,
    };
  }

  async isCurrent(source: SourceLines): Promise<boolean> {
    try {
      const file = await this.readText(source.path);
      return source.startLine <= source.endLine && source.endLine <= file.lines.length
        && createHash('sha256').update(file.bytes).digest('hex') === source.sha256;
    } catch {
      return false;
    }
  }

  private async *files(path: string): AsyncGenerator<string> {
    for (const entry of await this.entries(path)) {
      const child = childPath(path, entry.name);
      if (entry.isDirectory()) yield* this.files(child);
      else yield child;
    }
  }

  async searchText(query: string, scope = '.', limit = 30, signal?: AbortSignal) {
    const { path, info } = await this.resolvePath(scope);
    const paths = info.isDirectory() ? this.files(path) : [path];
    const matches: { path: string; line: number; text: string }[] = [];
    let examinedFiles = 0;
    let skippedFiles = 0;
    let bytesRead = 0;
    for await (const file of paths) {
      signal?.throwIfAborted();
      if (examinedFiles >= MAX_SEARCH_FILES || bytesRead >= MAX_SEARCH_BYTES) {
        return { matches, examinedFiles, skippedFiles, truncated: true };
      }
      examinedFiles++;
      let source;
      try {
        source = await this.readText(file);
      } catch (error) {
        if (!(error instanceof UnsupportedFile)) throw error;
        skippedFiles++;
        continue;
      }
      bytesRead += source.bytes.length;
      for (const [index, text] of source.lines.entries()) {
        const at = text.indexOf(query);
        if (at < 0) continue;
        const start = Math.max(0, at - 100);
        if (matches.length === limit) return { matches, examinedFiles, skippedFiles, truncated: true };
        matches.push({ path: source.path, line: index + 1, text: text.slice(start, start + 400) });
      }
    }
    return { matches, examinedFiles, skippedFiles, truncated: false };
  }
}
