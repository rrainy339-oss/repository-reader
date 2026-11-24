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
});

export const mapSchema = z.object({
  version: z.literal(1),
  root: z.string().min(1),
  records: z.array(mapRecordSchema.extend({ evidence: z.array(savedCitation).min(1).max(5) })),
});

export type RepositoryMap = z.infer<typeof mapSchema>;
export type MapRecord = RepositoryMap['records'][number];

export function repositoryRecordId(record: Pick<MapRecord, 'kind' | 'subject'>): string {
  return `${record.kind}:${record.subject}`;
}
