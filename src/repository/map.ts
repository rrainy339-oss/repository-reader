import { createHash } from 'node:crypto';
import { z } from 'zod';

const savedCitation = z.object({
  path: z.string().trim().min(1).max(1024),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).refine((ref) => ref.endLine >= ref.startLine);

export const mapRecordSchema = z.object({
  kind: z.enum(['module', 'entry', 'relationship', 'file']),
  subject: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(600),
  basis: z.enum(['observed', 'inferred']),
  anchor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path: z.string().trim().min(1).max(1024) }),
    z.object({ kind: z.enum(['symbol', 'entry']), id: z.string().trim().min(1).max(80) }),
  ]).optional(),
});

export const mapSchema = z.object({
  version: z.literal(1),
  root: z.string().min(1),
  summary: z.string().trim().min(1).max(3000).optional(),
  unresolved: z.array(z.string().trim().min(1).max(600)).max(20).optional(),
  records: z.array(mapRecordSchema.extend({ evidence: z.array(savedCitation).min(1).max(5) })),
});

export type RepositoryMap = z.infer<typeof mapSchema>;
export type MapRecord = RepositoryMap['records'][number];

export function repositoryRecordId(record: Pick<MapRecord, 'kind' | 'subject' | 'anchor'>): string {
  if (record.anchor) {
    const value = record.anchor.kind === 'file'
      ? createHash('sha256').update(record.anchor.path).digest('hex').slice(0, 32)
      : record.anchor.id;
    return `${record.kind}:${record.anchor.kind}:${value}`;
  }
  return `${record.kind}:${record.subject}`;
}
