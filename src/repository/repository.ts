import { createHash } from 'node:crypto';
import { constants as bufferLimits } from 'node:buffer';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { searchPageByteLimit, sourceFileByteLimit } from '../runtime/budget.ts';
import { buildRepositoryIndex, type IndexSource, type RepositoryIndex } from './repository-index.ts';

const INDEX_READ_BATCH = 16;
const decoder = new TextDecoder('utf-8', { fatal: true });

function excluded(name: string): boolean {
  const lower = name.toLowerCase();
  return ['.git', 'node_modules', '.npm-cache', '.ssh', '.aws', '.npmrc'].includes(lower)
    || /^\.env(?:\.|$)/.test(lower)
    || /\.(?:key|pem|p12|pfx)$/.test(lower);
}

function validPathPart(part: string) {
  return part && part !== '.' && part !== '..' && !/[:\\\x00-\x1f]/.test(part) && !excluded(part);
}

export function normalizePath(input: string): string {
  const path = input.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (input === '.' || input === './') return '.';
  if (!path.split('/').every(validPathPart)) {
    throw new Error('Use an in-scope, repository-relative path.');
  }
  return path;
}

const excludedDirectories = new Set(['.local-bench', 'dist', 'build', 'coverage', 'vendor', 'miniprogram_npm', '.next', '.nuxt']);

function childPath(directory: string, name: string): string {
  return directory === '.' ? name : `${directory}/${name}`;
}

class UnsupportedFile extends Error {
  readonly size?: number;

  constructor(message: string, size?: number) {
    super(message);
    this.size = size;
  }
}

function unavailable(error: unknown) {
  return error instanceof UnsupportedFile || (error instanceof Error
    && ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? ''));
}

function fingerprint(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export type SourceLines = {
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
};

export type SearchCursor = { path: string; line: number };

export class Repository {
  readonly root: string;
  readonly index: Promise<RepositoryIndex>;
  private readonly maxFileBytes = sourceFileByteLimit();
  private readonly maxSearchPageBytes = searchPageByteLimit();

  private constructor(root: string, signal?: AbortSignal) {
    this.root = root;
    this.index = buildRepositoryIndex(this.indexSources(signal), signal);
  }

  static async open(directory: string, shared?: Repository, signal?: AbortSignal): Promise<Repository> {
    signal?.throwIfAborted();
    const root = await realpath(directory);
    if (shared) {
      if (root !== shared.root) throw new Error('The shared repository index belongs to a different directory.');
      return shared;
    }
    if (!(await stat(root)).isDirectory()) throw new Error('Repository path must be a directory.');
    const repository = new Repository(root, signal);
    await repository.index;
    return repository;
  }

  private async resolvePath(input: string) {
    const path = normalizePath(input);
    const absolute = resolve(this.root, path);
    const canonical = await realpath(absolute);
    const fromRoot = relative(this.root, canonical);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
      || relative(absolute, canonical) !== '') {
      throw new UnsupportedFile('Linked paths and paths outside the repository are excluded.');
    }
    const info = await lstat(absolute);
    if (!info.isDirectory() && !info.isFile()) throw new UnsupportedFile('Not a regular file or directory.');
    const parts = path.toLowerCase().split('/');
    if (parts.slice(0, info.isDirectory() ? parts.length : -1).some((part) => excludedDirectories.has(part))) {
      throw new UnsupportedFile('Dependency and generated directories are excluded.');
    }
    return { path, absolute: canonical, info };
  }

  private async entries(directory: string) {
    const { absolute, info } = await this.resolvePath(directory);
    if (!info.isDirectory()) throw new Error('Expected a directory.');
    const entries = await readdir(absolute, { withFileTypes: true });
    return entries.filter((entry) => validPathPart(entry.name)
      && (entry.isFile() || (entry.isDirectory() && !excludedDirectories.has(entry.name.toLowerCase()))))
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

  private async readText(input: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { path, absolute, info } = await this.resolvePath(input);
    if (!info.isFile()) throw new UnsupportedFile('Only regular text files are supported.', info.size);
    if (this.maxFileBytes && info.size > this.maxFileBytes) {
      throw new UnsupportedFile('The file exceeds REPO_READER_MAX_FILE_BYTES (' + this.maxFileBytes + ' bytes).', info.size);
    }
    if (info.size >= bufferLimits.MAX_LENGTH) throw new UnsupportedFile('The file exceeds Node.js buffer capacity.', info.size);
    const file = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== info.size) throw new UnsupportedFile('File size changed while reading.', info.size);
      const bytes = buffer.subarray(0, offset);
      if (bytes.includes(0)) throw new UnsupportedFile('Binary file.', info.size);
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        throw new UnsupportedFile('File is not UTF-8 text.', info.size);
      }
      const lines = text ? text.split(/\r\n|\n|\r/) : [];
      if (lines.at(-1) === '') lines.pop();
      return { path, lines, bytes };
    } finally {
      await file.close();
    }
  }

  async readLines(path: string, startLine: number, endLine: number, signal?: AbortSignal) {
    const source = await this.readText(path, signal);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
      || startLine < 1 || startLine > source.lines.length || endLine < startLine) {
      throw new Error(`Invalid line range. The file has ${source.lines.length} lines.`);
    }
    const lastLine = Math.min(endLine, source.lines.length);
    const lines = source.lines.slice(startLine - 1, lastLine).map((text, index) => ({ line: startLine + index, text }));
    return {
      path: source.path,
      startLine,
      endLine: lastLine,
      totalLines: source.lines.length,
      sha256: fingerprint(source.bytes),
      lines,
    };
  }

  async isCurrent(source: SourceLines): Promise<boolean> {
    try {
      const file = await this.readText(source.path);
      return source.startLine <= source.endLine && source.endLine <= file.lines.length
        && fingerprint(file.bytes) === source.sha256;
    } catch {
      return false;
    }
  }

  private async *files(path: string, signal?: AbortSignal, isRoot = true): AsyncGenerator<string> {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await this.entries(path);
    } catch (error) {
      if (isRoot || !unavailable(error)) throw error;
      return;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      const child = childPath(path, entry.name);
      if (entry.isDirectory()) yield* this.files(child, signal, false);
      else yield child;
    }
  }

  private async *indexSources(signal?: AbortSignal): AsyncGenerator<IndexSource> {
    let batch: string[] = [];
    for await (const path of this.files('.', signal)) {
      batch.push(path);
      if (batch.length === INDEX_READ_BATCH) {
        yield* await Promise.all(batch.map((file) => this.indexSource(file, signal)));
        batch = [];
      }
    }
    yield* await Promise.all(batch.map((file) => this.indexSource(file, signal)));
  }

  private async indexSource(path: string, signal?: AbortSignal): Promise<IndexSource> {
    try {
      const { bytes, lines } = await this.readText(path, signal);
      return { path, size: bytes.length, contentHash: fingerprint(bytes), text: lines.join('\n') };
    } catch (error) {
      if (!unavailable(error)) throw error;
      return { path, size: error instanceof UnsupportedFile ? error.size ?? null : null, contentHash: null };
    }
  }

  async searchText(query: string, scope = '.', limit = 30, signal?: AbortSignal, cursor?: SearchCursor) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Search result limit must be a positive integer.');
    const { path, info } = await this.resolvePath(scope);
    const paths = info.isDirectory() ? this.files(path, signal) : [path];
    const resumeAt = cursor ? normalizePath(cursor.path) : undefined;
    const cursorInScope = !resumeAt || path === '.' || resumeAt === path
      || (info.isDirectory() && resumeAt.startsWith(path + '/'));
    if (!cursorInScope || (cursor && (!Number.isSafeInteger(cursor.line) || cursor.line < 1))) {
      throw new Error('Use a valid search cursor within the current scope.');
    }
    let reachedCursor = resumeAt === undefined;
    const matches: { path: string; line: number; text: string; matchColumn?: number;
      excerptStartColumn?: number; truncated?: boolean }[] = [];
    let examinedFiles = 0;
    let skippedFiles = 0;
    let bytesRead = 0;
    for await (const file of paths) {
      signal?.throwIfAborted();
      if (!reachedCursor) {
        if (file !== resumeAt) continue;
        reachedCursor = true;
      }
      if (this.maxSearchPageBytes && bytesRead >= this.maxSearchPageBytes) {
        return { matches, examinedFiles, skippedFiles, truncated: true,
          limitReason: 'scan_budget', nextCursor: { path: file, line: 1 } };
      }
      examinedFiles++;
      let source;
      try {
        source = await this.readText(file, signal);
      } catch (error) {
        if (!unavailable(error)) throw error;
        skippedFiles++;
        continue;
      }
      bytesRead += source.bytes.length;
      const first = file === resumeAt ? cursor!.line - 1 : 0;
      for (let index = first; index < source.lines.length; index++) {
        const text = source.lines[index];
        const at = text.indexOf(query);
        if (at < 0) continue;
        const start = Math.max(0, at - 100);
        if (matches.length === limit) return { matches, examinedFiles, skippedFiles, truncated: true,
          limitReason: 'match_limit', nextCursor: { path: source.path, line: index + 1 } };
        const excerpt = text.slice(start, start + 400);
        matches.push({ path: source.path, line: index + 1, text: excerpt,
          ...(start || excerpt.length < text.length ? { matchColumn: at + 1, excerptStartColumn: start + 1, truncated: true } : {}) });
      }
    }
    if (!reachedCursor) throw new Error('The search cursor is outside the current scope or its file disappeared. Restart without it.');
    return { matches, examinedFiles, skippedFiles, truncated: false, nextCursor: null };
  }
}
