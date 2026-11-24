import type { AgentTool } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { toolResult } from '../runtime/agent-runtime.ts';
import { createIndexTools } from './index-tools.ts';
import type { MapRecord } from './map.ts';
import type { Repository, SourceLines } from './repository.ts';

export const sourceRangeSchema = z.object({
  path: z.string().trim().min(1).max(1024),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).refine((range) => range.endLine >= range.startLine);

export const savedSourceRangeSchema = sourceRangeSchema.safeExtend({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export function createReadLinesTool(repository: Repository, onRead?: (source: SourceLines) => void): AgentTool {
  return {
    name: 'read_lines', label: 'Read source lines',
    description: 'Read a 1-based inclusive range in a repository-relative UTF-8 file. Each response is bounded.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
    }, required: ['path', 'startLine', 'endLine'], additionalProperties: false },
    async execute(_id, params) {
      const { path, startLine, endLine } = sourceRangeSchema.parse(params);
      const { lines, sha256, totalLines, ...range } = await repository.readLines(path, startLine, endLine);
      onRead?.({ ...range, sha256 });
      return toolResult({ ...range, totalLines, lines });
    },
  };
}

export function createRepositoryTools(repository: Repository, onRead?: (source: SourceLines) => void,
  mapRecords?: () => Iterable<MapRecord>): AgentTool[] {
  const path = z.string().trim().min(1).max(1024);
  return [
    {
      name: 'list_files', label: 'List files',
      description: 'List one directory, including subdirectory names. Use nextOffset to continue.',
      parameters: { type: 'object', properties: {
        directory: { type: 'string', description: 'Repository-relative directory, or . for root.' },
        offset: { type: 'integer', minimum: 0 },
      }, additionalProperties: false },
      async execute(_id, params) {
        const { directory, offset } = z.object({ directory: path.optional(),
          offset: z.number().int().nonnegative().optional() }).parse(params);
        return toolResult(await repository.listFiles(directory, offset));
      },
    },
    {
      name: 'search_text', label: 'Search source',
      description: 'Search for a literal, case-sensitive string. If truncated, pass nextCursor as cursor with the same query and scope, or narrow the scope.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        scope: { type: 'string', description: 'Optional repository-relative file or directory.' },
        cursor: { type: 'object', properties: { path: { type: 'string' },
          line: { type: 'integer', minimum: 1 } }, required: ['path', 'line'], additionalProperties: false },
      }, required: ['query'], additionalProperties: false },
      async execute(_id, params, signal) {
        const { query, scope, cursor } = z.object({ query: z.string().min(1).max(200), scope: path.optional(),
          cursor: z.strictObject({ path, line: z.number().int().positive() }).optional() }).parse(params);
        return toolResult(await repository.searchText(query, scope, 30, signal, cursor));
      },
    },
    createReadLinesTool(repository, onRead),
    ...createIndexTools(repository, onRead, mapRecords),
  ];
}

export async function verifyReadRange(repository: Repository, observed: SourceLines[], range: z.infer<typeof sourceRangeSchema>) {
  const read = observed.findLast((item) => item.path === range.path
    && item.startLine <= range.startLine && item.endLine >= range.endLine);
  if (!read) return undefined;
  const current = { ...range, sha256: read.sha256 };
  return await repository.isCurrent(current) ? current : undefined;
}
