import { posix } from 'node:path';
import { collectEntryPoints, wxmlBindings, type EntryPointRecord } from './entry-points.ts';
import { createSourceParser, grammarFor, type EntryHint, type SymbolRecord } from './source-symbols.ts';
import type { SourceLines } from './repository.ts';

export type ParseStatus = 'parsed' | 'unsupported' | 'failed' | 'skipped';
export type FileRecord = {
  path: string;
  language?: string;
  size: number | null;
  contentHash: string | null;
  parseStatus: ParseStatus;
};

export type IndexSource = {
  path: string;
  size: number | null;
  contentHash: string | null;
  text?: string;
};

function byFile<T extends { filePath: string }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.filePath);
    if (group) group.push(item);
    else groups.set(item.filePath, [item]);
  }
  return groups;
}

const otherLanguages: Record<string, string> = {
  '.json': 'json', '.wxml': 'wxml', '.wxss': 'css', '.css': 'css', '.html': 'html',
  '.md': 'markdown', '.py': 'python', '.go': 'go', '.java': 'java', '.yaml': 'yaml', '.yml': 'yaml',
};

export async function buildRepositoryIndex(sources: AsyncIterable<IndexSource>, signal?: AbortSignal) {
  const files: FileRecord[] = [];
  const symbols: SymbolRecord[] = [];
  const hints = new Map<string, EntryHint[]>();
  const configs = new Map<string, unknown>();
  const markup = new Map<string, ReturnType<typeof wxmlBindings>>();
  let parser: Awaited<ReturnType<typeof createSourceParser>> | undefined;
  try {
    for await (const { path, size, contentHash, text } of sources) {
      signal?.throwIfAborted();
      const grammar = grammarFor(path);
      const language = grammar === 'tsx' ? 'typescript' : grammar ?? otherLanguages[posix.extname(path).toLowerCase()];
      const file: FileRecord = { path, size, contentHash, ...(language ? { language } : {}),
        parseStatus: text === undefined ? 'skipped' : 'unsupported' };
      files.push(file);
      if (text === undefined) continue;
      if (grammar) {
        parser ??= await createSourceParser();
        try {
          const parsed = parser.parse(path, grammar, text);
          for (const symbol of parsed.symbols) symbols.push(symbol);
          if (parsed.hints.length) hints.set(path, parsed.hints);
          file.parseStatus = 'parsed';
        } catch {
          file.parseStatus = 'failed';
        }
      } else if (['app.json', 'project.config.json'].includes(posix.basename(path))) {
        try {
          configs.set(path, JSON.parse(text));
          file.parseStatus = 'parsed';
        } catch {
          file.parseStatus = 'failed';
        }
      } else if (language === 'wxml') {
        const bindings = wxmlBindings(text);
        if (bindings.length) markup.set(path, bindings);
      }
    }
  } finally {
    parser?.close();
  }
  signal?.throwIfAborted();
  const readable = new Set(files.filter(({ parseStatus }) => parseStatus !== 'skipped').map(({ path }) => path));
  return new RepositoryIndex(files, symbols, collectEntryPoints(readable, configs, hints, markup));
}

export class RepositoryIndex {
  readonly files: ReadonlyMap<string, FileRecord>;
  readonly symbols: ReadonlyMap<string, SymbolRecord>;
  readonly entries: ReadonlyMap<string, EntryPointRecord>;
  readonly symbolsByFile: ReadonlyMap<string, readonly SymbolRecord[]>;
  readonly entriesByFile: ReadonlyMap<string, readonly EntryPointRecord[]>;
  private readonly names: ReadonlyMap<string, readonly SymbolRecord[]>;
  private readonly readEntries = new Set<string>();
  readonly summary: ReturnType<typeof indexSummary>;

  constructor(files: FileRecord[], symbols: SymbolRecord[], entries: EntryPointRecord[]) {
    this.files = new Map(files.map((file) => [file.path, file]));
    this.symbols = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.symbolsByFile = byFile(symbols);
    this.entriesByFile = byFile(entries);
    const names = new Map<string, SymbolRecord[]>();
    for (const symbol of symbols) {
      for (const name of new Set([symbol.name, symbol.qualifiedName, symbol.name.split('.').at(-1)!])) {
        const matches = names.get(name);
        if (matches) matches.push(symbol);
        else names.set(name, [symbol]);
      }
    }
    this.names = names;
    this.summary = indexSummary(files, symbols, entries);
  }

  searchSymbols(name: string, match: 'exact' | 'fuzzy') {
    const exact = this.names.get(name) ?? [];
    if (match === 'exact') return exact;
    const needle = name.toLowerCase();
    const exactIds = new Set(exact.map(({ id }) => id));
    return [...exact, ...[...this.symbols.values()].filter((symbol) => !exactIds.has(symbol.id)
      && symbol.qualifiedName.toLowerCase().includes(needle))];
  }

  observeEntryRead(source: SourceLines) {
    if (this.files.get(source.path)?.contentHash !== source.sha256) return;
    for (const entry of this.entriesByFile.get(source.path) ?? []) {
      if (entryOverlaps(entry, source)) this.readEntries.add(entry.id);
    }
  }

  hasEntryRead(id: string) {
    return this.readEntries.has(id);
  }
}

export function entryOverlaps(entry: EntryPointRecord, source: Pick<SourceLines, 'path' | 'startLine' | 'endLine'>) {
  return source.path === entry.filePath && (entry.startLine === undefined
    || (entry.startLine <= source.endLine && entry.endLine! >= source.startLine));
}

function indexSummary(files: FileRecord[], symbols: SymbolRecord[], entries: EntryPointRecord[]) {
  const directories = new Map<string, number>();
  for (const { path } of files) {
    const top = path.includes('/') ? path.split('/')[0] : '.';
    directories.set(top, (directories.get(top) ?? 0) + 1);
  }
  function counts<T>(items: T[], key: (item: T) => string) {
    const totals = new Map<string, number>();
    for (const item of items) {
      const name = key(item);
      totals.set(name, (totals.get(name) ?? 0) + 1);
    }
    return Object.fromEntries(totals);
  }
  const overviewFiles = files.filter(({ path, parseStatus }) => parseStatus !== 'skipped'
    && /^(readme(?:\..+)?|package\.json|app\.json|project\.config\.json|tsconfig\.json)$/i.test(posix.basename(path)))
    .map(({ path }) => path).sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  return {
    totalFiles: files.length, totalSymbols: symbols.length, totalEntries: entries.length,
    parseStatuses: counts(files, (file) => file.parseStatus), languages: counts(files, (file) => file.language ?? 'other'),
    entryKinds: counts(entries, (entry) => entry.kind),
    topDirectories: [...directories].sort((left, right) => right[1] - left[1]).slice(0, 16)
      .map(([path, fileCount]) => ({ path, fileCount })),
    topDirectoryCount: directories.size, overviewFiles: overviewFiles.slice(0, 16),
  };
}
