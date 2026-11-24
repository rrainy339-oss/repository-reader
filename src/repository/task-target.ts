import { z } from 'zod';
import { normalizePath, type Repository, type SourceLines } from './repository.ts';
import { savedSourceRangeSchema, sourceRangeSchema, verifyReadRange } from './repository-tools.ts';
import { stableId } from './source-symbols.ts';

export const nonempty = z.string().trim().min(1);
export const auditGoalSchema = z.object({ id: nonempty, title: nonempty, description: nonempty });
export const proposedGoalSchema = auditGoalSchema.partial({ id: true });

const sourceKinds = ['file', 'source'] as const;
export const sourceTargetProposalSchema = z.object({ kind: z.enum(sourceKinds), source: sourceRangeSchema });
export const taskTargetSchema = z.object({
  kind: z.enum(['entry', 'symbol', ...sourceKinds]), id: nonempty, source: savedSourceRangeSchema,
});
export type TaskTarget = z.infer<typeof taskTargetSchema>;
type SourceTargetProposal = z.infer<typeof sourceTargetProposalSchema>;

function sourceTargetId(kind: 'file' | 'source', source: Pick<SourceLines, 'path' | 'startLine' | 'endLine'>) {
  return stableId(kind, kind === 'file' ? [source.path] : [source.path, source.startLine, source.endLine]);
}

async function indexedTarget(repository: Repository, id: string, source: SourceLines) {
  const index = await repository.index;
  const entry = index.entries.get(id);
  const symbol = index.symbols.get(id);
  const entity = entry ?? symbol;
  if (!entity) throw new Error('Unknown repository entry or symbol ID: ' + id);
  const associatedFile = entity.filePath === source.path || (entry?.startLine === undefined && entry?.sourcePath === source.path);
  const coversDeclaration = entity.startLine === undefined || (source.startLine <= entity.startLine && entity.startLine <= source.endLine);
  if (!associatedFile || !coversDeclaration || index.files.get(source.path)?.contentHash !== source.sha256) {
    throw new Error('The current evidence must cover the indexed target declaration or its associated file.');
  }
  return entry ? 'entry' : 'symbol';
}

export async function groundTaskTarget(repository: Repository, observed: SourceLines[], proposal: {
  targetId?: string; target?: SourceTargetProposal; source?: z.infer<typeof sourceRangeSchema>;
}): Promise<TaskTarget> {
  const reference = proposal.target?.source ?? proposal.source;
  if (!reference) throw new Error('An indexed or source target requires a source range read in this planning session.');
  const source = await verifyReadRange(repository, observed, { ...reference, path: normalizePath(reference.path) });
  if (!source) throw new Error('The proposed target source was not fully read or has changed.');
  if (proposal.target) {
    const kind = proposal.target.kind;
    const id = sourceTargetId(kind, source);
    if (proposal.targetId && id !== proposal.targetId) throw new Error('The supplied target ID does not match its source.');
    return { kind, id, source };
  }
  if (!proposal.targetId) throw new Error('Supply an existing entry or symbol ID or a file/source target.');
  return { kind: await indexedTarget(repository, proposal.targetId, source), id: proposal.targetId, source };
}

export async function verifyTaskTarget(repository: Repository, id: string, target: TaskTarget) {
  if (id !== target.id || normalizePath(target.source.path) !== target.source.path) {
    throw new Error('The target ID or repository-relative path does not match the source target.');
  }
  if (!await repository.isCurrent(target.source)) throw new Error('The task target source changed or is unavailable. Refresh its source evidence.');
  if (target.kind === 'file' || target.kind === 'source') {
    if (target.id !== sourceTargetId(target.kind, target.source)) throw new Error('The task target ID does not match its source.');
  } else if (target.kind !== await indexedTarget(repository, target.id, target.source)) {
    throw new Error('The indexed task target kind does not match its source.');
  }
}
