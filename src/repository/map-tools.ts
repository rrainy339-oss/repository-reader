import type { AgentTool } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { toolResult } from '../runtime/agent-runtime.ts';
import type { MapRecord } from './map.ts';

export function createQueryMapTool(records: ReadonlyMap<string, MapRecord>, changed: ReadonlySet<string> = new Set()): AgentTool {
  return {
    name: 'query_map', label: 'Query repository map',
    description: 'Find repository records and citation locations. Use nextOffset to continue. Treat the map as navigation, then read the source.',
    parameters: { type: 'object', properties: { query: { type: 'string' },
      kind: { type: 'string', enum: ['entry', 'module', 'relationship', 'file'] },
      onlyChanged: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    async execute(_id, params) {
      const { query, kind, onlyChanged, offset } = z.object({ query: z.string().trim().min(1).max(240).optional(),
        kind: z.enum(['entry', 'module', 'relationship', 'file']).optional(),
        onlyChanged: z.boolean().default(false), offset: z.number().int().nonnegative().default(0) }).parse(params);
      const needle = query?.toLowerCase();
      const matched = [...records].filter(([recordId, record]) => (!kind || record.kind === kind)
        && (!onlyChanged || changed.has(recordId))
        && (!needle || [record.subject, record.description, ...record.evidence.map((ref) => ref.path)]
          .some((value) => value.toLowerCase().includes(needle))));
      const end = offset + 12;
      return toolResult({ total: matched.length, nextOffset: end < matched.length ? end : null,
        items: matched.slice(offset, end).map(([targetId, { evidence, ...record }]) => ({ ...record, targetId,
          changed: changed.has(targetId), evidence: evidence.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })),
        })) });
    },
  };
}
