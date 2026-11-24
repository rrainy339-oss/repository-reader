import { posix } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { toolResult } from '../runtime/agent-runtime.ts';
import { analysisStatuses, entryKinds } from './entry-points.ts';
import type { MapRecord } from './map.ts';
import type { RepositoryIndex } from './repository-index.ts';
import { normalizePath, type Repository, type SourceLines } from './repository.ts';
import { symbolKinds } from './source-symbols.ts';

const pathInput = z.string().trim().min(1).max(1024);
const selector = {
  scope: pathInput.optional().describe('Repository-relative file or directory.'),
  filePattern: pathInput.optional().describe('Repository-relative glob, such as cloudfunctions/**/*.js.'),
  offset: z.number().int().nonnegative().default(0),
};

function fileFilter({ scope, filePattern }: { scope?: string; filePattern?: string }) {
  const directory = scope ? normalizePath(scope) : '.';
  const pattern = filePattern ? normalizePath(filePattern) : undefined;
  return (path: string) => (directory === '.' || path === directory || path.startsWith(directory + '/'))
    && (pattern === undefined || posix.matchesGlob(path, pattern));
}

function page<T>(items: readonly T[], offset: number) {
  const next = offset + 20;
  return { items: items.slice(offset, next), total: items.length, nextOffset: next < items.length ? next : null };
}

function tool<T extends z.ZodObject>(name: string, label: string, description: string, schema: T,
  execute: (input: z.output<T>) => Promise<object>): AgentTool {
  return {
    name, label, description, parameters: z.toJSONSchema(schema, { io: 'input' }),
    async execute(_id, params) { return toolResult(await execute(schema.parse(params))); },
  };
}

function summarizedEntries(index: RepositoryIndex, records: Iterable<MapRecord>) {
  const summarized = new Set<string>();
  for (const { anchor, evidence } of records) {
    if (anchor?.kind !== 'entry') continue;
    const entry = index.entries.get(anchor.id);
    if (!entry) continue;
    const hash = index.files.get(entry.filePath)?.contentHash;
    if (evidence.some((source) => hash === source.sha256 && source.path === entry.filePath
      && (entry.startLine === undefined || (source.startLine <= entry.startLine && entry.startLine <= source.endLine)))) {
      summarized.add(entry.id);
    }
  }
  return summarized;
}

export function createIndexTools(repository: Repository, onRead?: (source: SourceLines) => void,
  mapRecords: () => Iterable<MapRecord> = () => []) {
  return [
    tool('query_files', 'Query file index',
      'List indexed files and parse statuses. Use nextOffset to continue; unsupported and failed text can still be read.',
      z.strictObject({ ...selector, parseStatus: z.enum(['parsed', 'unsupported', 'failed', 'skipped']).optional() }),
      async (input) => {
        const index = await repository.index;
        const matchesFile = fileFilter(input);
        return page([...index.files.values()].filter(({ path, parseStatus }) =>
          matchesFile(path) && (!input.parseStatus || input.parseStatus === parseStatus)), input.offset);
      }),
    tool('query_entries', 'Query entry index',
      'List static server, client, and external-call candidates. Filter by analysisStatus to find unread entries. Use nextOffset to continue.',
      z.strictObject({ ...selector, entryId: z.string().trim().min(1).max(80).optional(),
        kind: z.enum(entryKinds).optional(), analysisStatus: z.enum(analysisStatuses).optional() }),
      async (input) => {
        const index = await repository.index;
        const matchesFile = fileFilter(input);
        const summarized = summarizedEntries(index, mapRecords());
        const entries = [...index.entries.values()]
          .filter((entry) => (!input.entryId || input.entryId === entry.id)
            && matchesFile(entry.filePath) && (!input.kind || entry.kind === input.kind))
          .map((entry) => ({ ...entry, analysisStatus: summarized.has(entry.id) ? 'summarized'
            : index.hasEntryRead(entry.id) ? 'partial' : entry.analysisStatus }))
          .filter((entry) => !input.analysisStatus || entry.analysisStatus === input.analysisStatus);
        return page(entries, input.offset);
      }),
    tool('get_file_symbols', 'List file symbols',
      'List definition locations in one file. Use nextOffset to continue. Read code for evidence.',
      z.strictObject({ filePath: pathInput, offset: selector.offset }),
      async ({ filePath, offset }) => {
        const index = await repository.index;
        const path = normalizePath(filePath);
        const file = index.files.get(path);
        if (!file) throw new Error('The file is not in the repository index: ' + path);
        return { file, ...page(index.symbolsByFile.get(path) ?? [], offset) };
      }),
    tool('search_symbols', 'Search symbol definitions',
      'Find definitions by short or qualified name. Fuzzy mode ranks exact names first. Results are locations, with no call-target resolution. Use nextOffset to continue.',
      z.strictObject({ ...selector, name: z.string().trim().min(1).max(240),
        match: z.enum(['exact', 'fuzzy']).default('fuzzy'), kind: z.enum(symbolKinds).optional() }),
      async (input) => {
        const index = await repository.index;
        const matchesFile = fileFilter(input);
        const symbols = index.searchSymbols(input.name, input.match)
          .filter((symbol) => matchesFile(symbol.filePath) && (!input.kind || symbol.kind === input.kind));
        return page(symbols, input.offset);
      }),
    tool('get_symbol_code', 'Read symbol code',
      'Read current source for an indexed definition, with the same bounds and evidence as read_lines. Optional line numbers are absolute and inclusive. Use nextStartLine to continue.',
      z.strictObject({ symbolId: z.string().trim().min(1).max(80), startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional() }),
      async ({ symbolId, startLine, endLine }) => {
        const index = await repository.index;
        const symbol = index.symbols.get(symbolId);
        if (!symbol) throw new Error('Unknown symbol ID: ' + symbolId);
        const first = startLine ?? symbol.startLine;
        const last = endLine ?? symbol.endLine;
        if (first < symbol.startLine || last > symbol.endLine || first > last) {
          throw new Error('The requested lines must be inside the indexed symbol range.');
        }
        let result;
        try {
          result = await repository.readLines(symbol.filePath, first, last);
        } catch (cause) {
          throw new Error('The indexed source is unavailable. Use read_lines to inspect current source or reopen the repository.', { cause });
        }
        const { lines, totalLines, ...source } = result;
        if (source.sha256 !== index.files.get(symbol.filePath)?.contentHash) {
          throw new Error('The indexed source has changed. Use read_lines or reopen the repository to refresh the index.');
        }
        onRead?.(source);
        return { symbol, source, lines, totalLines,
          truncated: source.startLine > symbol.startLine || source.endLine < symbol.endLine || lines.some((line) => line.truncated),
          nextStartLine: source.endLine < symbol.endLine ? source.endLine + 1 : null };
      }),
  ];
}
