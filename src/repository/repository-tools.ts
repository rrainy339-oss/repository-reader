import type { AgentTool } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { toolResult } from '../runtime/agent-runtime.ts';
import { createIndexTools } from './index-tools.ts';
import type { MapRecord } from './map.ts';
import type { Repository, SourceLines } from './repository.ts';
import { sourcePage } from './source-page.ts';

export const sourceRangeSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).refine((range) => range.endLine >= range.startLine);

export const savedSourceRangeSchema = sourceRangeSchema.safeExtend({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export function createReadLinesTool(repository: Repository, onRead?: (source: SourceLines) => void, pageBytes?: number): AgentTool {
  return {
    name: 'read_lines', label: 'Read source lines',
    description: 'Read complete 1-based inclusive lines. If nextCursor is returned, use its line/column as startLine/startColumn with the same endLine. Only complete lines are evidence.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
      startColumn: { type: 'integer', minimum: 1, description: 'UTF-16 column for continuation of a long line.' },
      maxBytes: { type: 'integer', minimum: 256, description: 'Request a smaller response page.' },
    }, required: ['path', 'startLine', 'endLine'], additionalProperties: false },
    async execute(_id, params, signal) {
      const { path, startLine, endLine, startColumn, maxBytes } = sourceRangeSchema.safeExtend({
        startColumn: z.number().int().positive().optional(), maxBytes: z.number().int().min(256).optional(),
      }).parse(params);
      const limit = maxBytes === undefined ? pageBytes : Math.min(maxBytes, pageBytes ?? Infinity);
      const { evidence, sha256: _hash, ...page } = sourcePage(await repository.readLines(path, startLine, endLine, signal), limit, startColumn);
      if (evidence) onRead?.(evidence);
      return toolResult({ ...page, evidence });
    },
  };
}

export function createRepositoryTools(repository: Repository, onRead?: (source: SourceLines) => void,
  mapRecords?: () => Iterable<MapRecord>, pageBytes?: number): AgentTool[] {
  const path = z.string().min(1);
  return [
    {
      name: 'list_files', label: 'List files',
      description: 'List one directory, including subdirectory names. Use nextOffset to continue.',
      parameters: { type: 'object', properties: {
        directory: { type: 'string', description: 'Repository-relative directory, or . for root.' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      }, additionalProperties: false },
      async execute(_id, params) {
        const { directory, offset, limit } = z.object({ directory: path.optional(), limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional() }).parse(params);
        return toolResult(await repository.listFiles(directory, offset, limit));
      },
    },
    {
      name: 'search_text', label: 'Search source',
      description: 'Search for a literal, case-sensitive string. If truncated, pass nextCursor as cursor with the same query and scope, or narrow the scope.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', minLength: 1 },
        scope: { type: 'string', description: 'Optional repository-relative file or directory.' },
        limit: { type: 'integer', minimum: 1 },
        cursor: { type: 'object', properties: { path: { type: 'string' },
          line: { type: 'integer', minimum: 1 } }, required: ['path', 'line'], additionalProperties: false },
      }, required: ['query'], additionalProperties: false },
      async execute(_id, params, signal) {
        const { query, scope, cursor, limit } = z.object({ query: z.string().min(1), scope: path.optional(),
          limit: z.number().int().positive().optional(),
          cursor: z.strictObject({ path, line: z.number().int().positive() }).optional() }).parse(params);
        return toolResult(await repository.searchText(query, scope, limit, signal, cursor));
      },
    },
    createReadLinesTool(repository, onRead, pageBytes),
    ...createIndexTools(repository, onRead, mapRecords, pageBytes),
  ];
}

export async function verifyReadRange(repository: Repository, observed: SourceLines[], range: z.infer<typeof sourceRangeSchema>) {
  const read = observed.findLast((item) => item.path === range.path
    && item.startLine <= range.startLine && item.endLine >= range.endLine);
  if (!read) return undefined;
  const current = { ...range, sha256: read.sha256 };
  return await repository.isCurrent(current) ? current : undefined;
}
