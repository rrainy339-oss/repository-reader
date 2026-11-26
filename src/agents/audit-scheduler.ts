import type { Api, Model, Models } from '@earendil-works/pi-ai';
import type { z } from 'zod';
import { repositoryRecordId, type RepositoryMap } from '../repository/map.ts';
import type { Repository, SourceLines } from '../repository/repository.ts';
import { stableId } from '../repository/source-symbols.ts';
import { RunStopped, type RunBudget } from '../runtime/budget.ts';
import { detectTask } from './detection.ts';
import { mergeDiscoverySources, type discoverStateSchema, type discoverTasks } from './discover.ts';
import { validateCandidate, type validationContextSchema } from './validator.ts';

type State = z.output<typeof discoverStateSchema>;
type Feedback = State['feedback'][number] & {
  status: 'pending' | 'processed' | 'resolved' | 'unresolved';
  candidateId?: string;
  reasonUnresolved?: string;
};
type Action = Awaited<ReturnType<typeof discoverTasks>>['actions'][number];
type Detection = Awaited<ReturnType<typeof detectTask>>;
type Validation = Awaited<ReturnType<typeof validateCandidate>>;
type Attempt = { detection: Detection; validations: Validation[] };
type Candidate = {
  id: string;
  attempt: Attempt;
  index: number;
  signature: string;
  seenEvidence: Set<string>;
  status: 'pending' | Validation['verdict'] | 'blocked' | 'stale';
  validation?: Validation;
  reason?: string;
};
type AuditTask = {
  id: string;
  action: Extract<Action, { kind: 'create_task' }>;
  status: State['tasks'][number]['status'];
  coverage: State['coverage'][number]['status'];
  followUp: string[];
  usedFeedback: string[];
  starts: number;
  attempts: Attempt[];
  candidates: Candidate[];
  reason?: string;
};
type BatchSelector = { taskIds?: string[]; targetId?: string; module?: string; goalId?: string; limit?: number };

const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const citationKey = ({ path, startLine, endLine, sha256 }: SourceLines) => JSON.stringify([path, startLine, endLine, sha256]);
const overlaps = (a: SourceLines, b: SourceLines) => a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
const pendingCandidates = (task: AuditTask) => task.candidates.filter(({ status }) => status === 'pending');
const priorityOrder = { high: 0, normal: 1, low: 2 };

function candidateInput(attempt: Attempt, index: number) {
  const candidate = attempt.detection.candidates[index - 1];
  const evidence = (ids: string[]) => attempt.detection.evidence.filter(({ id }) => ids.includes(id)).map(({ source }) => source);
  const supporting = evidence(candidate.evidenceIds);
  const contrary = evidence(candidate.counterevidenceIds);
  const identity = JSON.stringify([normalize(candidate.claim), normalize(candidate.rule)]);
  const evidenceSignature = JSON.stringify([supporting.map(citationKey).sort(), contrary.map(citationKey).sort(),
    attempt.detection.target?.source.sha256]);
  const signature = JSON.stringify([identity, evidenceSignature, [...new Set(candidate.openQuestions.map(normalize))].sort()]);
  return { candidate, identity, supporting, contrary, evidenceSignature, signature };
}

export function createAuditScheduler({
  repository, models, model, budget, context, goals, getMap, startChild, stopReason, recordFailure,
}: {
  repository: Repository; models: Models; model: Model<Api>; budget: RunBudget;
  context: z.output<typeof validationContextSchema>;
  goals: State['goals'];
  getMap: () => RepositoryMap | undefined;
  startChild: () => void;
  stopReason: () => string | undefined;
  recordFailure: (tool: string, input: object, error: unknown) => string;
}) {
  const tasks = new Map<string, AuditTask>();
  const feedback = new Map<string, Feedback>();
  const targets = () => new Map([...tasks.values()].flatMap(({ action }) =>
    action.target ? [[action.targetId, action.target] as const] : []));
  const records = () => new Map(getMap()?.records.map((record) => [repositoryRecordId(record), record]));
  const interrupted = (error: unknown, signal?: AbortSignal) => budget.signal.aborted || signal?.aborted
    || (error instanceof RunStopped && error.reason === budget.exhausted?.reason);

  function applyTask(action: Exclude<Action, { kind: 'request_repository_read' }>) {
    if (action.kind === 'create_task') {
      const id = 'task-' + (tasks.size + 1);
      tasks.set(id, { id, action, status: 'pending', coverage: 'unplanned', followUp: [],
        usedFeedback: [...action.feedbackIds], starts: 0, attempts: [], candidates: [] });
      return id;
    }
    const task = tasks.get(action.taskId)!;
    const refreshed = action.target && action.target.source.sha256 !== task.action.target?.source.sha256;
    const newFeedback = action.feedbackIds.filter((id) => !task.usedFeedback.includes(id));
    if (!refreshed && (task.followUp.includes(action.note) || (task.status !== 'pending' && !newFeedback.length))) return;
    const evidence = new Map([...task.action.evidence, ...action.evidence].map((item) => [item.recordId, item]));
    task.action = { ...task.action, target: action.target ?? task.action.target, evidence: [...evidence.values()],
      discoverySources: mergeDiscoverySources(task.action.discoverySources, action.discoverySources),
      relatedRecordIds: [...new Set([...task.action.relatedRecordIds, ...action.relatedRecordIds])] };
    if (!task.followUp.includes(action.note)) task.followUp.push(action.note);
    task.usedFeedback.push(...newFeedback);
    task.status = 'pending';
    task.coverage = task.starts ? 'needs_evidence' : 'unplanned';
    task.reason = undefined;
    return task.id;
  }

  function routeLeads(task: AuditTask, leads: Detection['leads']) {
    for (const lead of leads) {
      const kind = lead.kind ?? 'discovery_lead';
      const question = normalize(lead.question);
      if (kind === 'discovery_lead' && [...tasks.values()].some(({ action }) =>
        normalize(action.question) === question && action.evidence.some(({ citations }) =>
          citations.some((range) => lead.evidence.some((source) => overlaps(range, source)))))) continue;
      const id = stableId('feedback', [kind, question, lead.evidence.map(citationKey).sort()]);
      if (feedback.has(id)) continue;
      feedback.set(id, { id, kind, status: 'pending', taskId: task.id, question: lead.question,
        reason: lead.reason, note: lead.question + '\n' + lead.reason, evidence: lead.evidence, recordIds: [task.action.targetId] });
    }
  }

  function routeEvidenceRequests(task: AuditTask, candidate: Candidate, validation: Validation) {
    for (const note of validation.neededEvidence) {
      const id = stableId('verification', [candidate.id, normalize(note)]);
      if (feedback.has(id)) continue;
      feedback.set(id, { id, kind: 'verification_gap', status: 'pending', taskId: task.id,
        candidateId: candidate.id, note, recordIds: [task.action.targetId] });
    }
  }

  function evidenceRequests(task: AuditTask) {
    return [...feedback.values()].filter((item) =>
      item.kind === 'verification_gap' && item.taskId === task.id && item.status === 'pending');
  }

  function registerCandidates(task: AuditTask, attempt: Attempt, requested: Set<string>) {
    const existing = new Set(task.candidates);
    for (const [offset] of attempt.detection.candidates.entries()) {
      const index = offset + 1;
      const input = candidateInput(attempt, index);
      const matching = [...existing].find((item) => item.signature === input.signature) ??
        [...existing].find((item) => {
          const prior = candidateInput(item.attempt, item.index);
          return prior.identity === input.identity && prior.supporting.some((range) => input.supporting.some((source) => overlaps(range, source)));
        });
      if (!matching) {
        if (task.candidates.some((item) => item.attempt === attempt && item.signature === input.signature)) continue;
        task.candidates.push({ id: task.id + '-candidate-' + (task.candidates.length + 1), attempt, index,
          signature: input.signature, seenEvidence: new Set([input.evidenceSignature]), status: 'pending' });
        continue;
      }
      existing.delete(matching);
      if (matching.signature === input.signature && matching.status !== 'stale') continue;
      if (requested.has(matching.id) && matching.seenEvidence.has(input.evidenceSignature)) continue;
      matching.seenEvidence.add(input.evidenceSignature);
      Object.assign(matching, { attempt, index, signature: input.signature, status: 'pending', validation: undefined, reason: undefined });
    }
  }

  function updateCoverage(task: AuditTask) {
    if (task.status !== 'completed') return;
    const latest = task.attempts.at(-1)?.detection;
    task.coverage = latest && latest.assessment.status !== 'inconclusive'
      && latest.checks.every(({ status }) => status === 'addressed') && !latest.unresolved.length
      && task.candidates.every(({ status }) => status === 'supported' || status === 'refuted') ? 'evaluated' : 'needs_evidence';
  }

  async function investigate(task: AuditTask, signal?: AbortSignal) {
    const requests = evidenceRequests(task);
    const previous = task.attempts.at(-1)?.detection;
    const related = task.candidates.filter(({ id }) => requests.some(({ candidateId }) => candidateId === id));
    const priorEvidence = [...(previous?.evidence ?? []), ...related.flatMap(({ attempt }) => attempt.detection.evidence)];
    const evidence = [...new Map(priorEvidence.map((item) => [citationKey(item.source), item])).values()];
    const mapRecords = records();
    const taskTargets = targets();
    task.status = 'in_progress';
    task.coverage = 'in_progress';
    task.starts++;
    try {
      startChild();
      const detection = await detectTask({ root: repository.root, repository, map: getMap(), task: { ...task.action,
        taskId: task.id, goal: goals.find(({ id }) => id === task.action.goalId), startingPoints: evidence.map(({ source }) => source),
        evidence: task.action.evidence.flatMap(({ recordId }) => {
          const record = mapRecords.get(recordId);
          const target = taskTargets.get(recordId);
          return record ? [{ recordId, citations: record.evidence }] : target ? [{ recordId, citations: [target.source] }] : [];
        }) }, context: { businessRules: context.rules.map(({ rule }) => rule),
        followUp: [...task.followUp, ...requests.map(({ note }) => note)],
        previousInvestigation: previous && { summary: previous.assessment.summary, evidence,
          requests: related.map((item) => ({ claim: candidateInput(item.attempt, item.index).candidate.claim,
            questions: requests.filter(({ candidateId }) => candidateId === item.id).map(({ note }) => note) })) },
      }, runBudget: budget, signal }, models, model);
      signal?.throwIfAborted();
      const attempt: Attempt = { detection, validations: [] };
      task.attempts.push(attempt);
      registerCandidates(task, attempt, new Set(requests.flatMap(({ candidateId }) => candidateId ? [candidateId] : [])));
      routeLeads(task, detection.leads);
      task.status = detection.coverageProposal.status === 'blocked' ? 'blocked' : 'completed';
      task.reason = task.status === 'blocked' ? detection.assessment.summary : undefined;
      task.coverage = detection.coverageProposal.status;
      let evidenceProgress = false;
      for (const item of requests) {
        const candidate = task.candidates.find(({ id }) => id === item.candidateId);
        if (candidate?.status === 'pending' && candidate.attempt === attempt) {
          item.status = 'processed';
          evidenceProgress = true;
        } else {
          item.status = 'unresolved';
          item.reasonUnresolved = task.reason ?? 'Supplementary investigation did not establish new evidence for this candidate.';
        }
      }
      updateCoverage(task);
      return { taskId: task.id, status: task.status, assessment: detection.assessment.summary,
        evidenceStalled: requests.length > 0 && !evidenceProgress };
    } catch (error) {
      task.reason = recordFailure('run_detection', { taskId: task.id }, error);
      task.status = interrupted(error, signal) ? 'pending' : 'blocked';
      task.coverage = task.status === 'pending' ? 'needs_evidence' : 'blocked';
      if (task.status === 'blocked') {
        for (const item of requests) {
          item.status = 'unresolved';
          item.reasonUnresolved = task.reason;
        }
      }
      return { taskId: task.id, status: task.status, reason: task.reason };
    }
  }

  async function validate(task: AuditTask, item: Candidate, signal?: AbortSignal) {
    try {
      startChild();
      const result = await validateCandidate({ root: repository.root, repository, map: getMap(), detection: item.attempt.detection,
        candidateIndex: item.index, context, runBudget: budget, signal }, models, model);
      signal?.throwIfAborted();
      item.attempt.validations.push(result);
      item.validation = result;
      item.status = result.verdict;
      item.reason = result.verdict === 'needs_evidence' ? result.summary : undefined;
      routeLeads(task, result.leads);
      if (result.verdict === 'needs_evidence') routeEvidenceRequests(task, item, result);
    } catch (error) {
      item.reason = recordFailure('run_validator', { taskId: task.id, candidateId: item.id, candidateIndex: item.index }, error);
      item.status = interrupted(error, signal) ? 'pending' : 'blocked';
    }
    if (item.status !== 'pending') {
      for (const gap of feedback.values()) {
        if (gap.candidateId !== item.id || gap.status === 'pending') continue;
        gap.status = item.status === 'supported' || item.status === 'refuted' ? 'resolved' : 'unresolved';
        gap.reasonUnresolved = gap.status === 'resolved' ? undefined : item.reason ?? 'The requested evidence is still insufficient.';
      }
    }
    updateCoverage(task);
    return { taskId: task.id, candidateId: item.id, status: item.status, summary: item.validation?.summary, reason: item.reason };
  }

  const hasWork = (task: AuditTask) => task.status === 'pending' || pendingCandidates(task).length > 0 || evidenceRequests(task).length > 0;

  function select({ taskIds, targetId, module, goalId, limit }: BatchSelector) {
    const mapRecords = records();
    const requested = taskIds?.map((id) => {
      const task = tasks.get(id);
      if (!task) throw new Error('Unknown task ID: ' + id);
      return task;
    });
    return (requested ? [...new Set(requested)] : [...tasks.values()].sort((a, b) =>
      priorityOrder[a.action.priority ?? 'normal'] - priorityOrder[b.action.priority ?? 'normal']))
      .filter((task) => {
        const { action } = task;
        const target = mapRecords.get(action.targetId);
        return hasWork(task) && (!targetId || action.targetId === targetId) && (!goalId || action.goalId === goalId)
          && (!module || [action.targetId, action.target?.source.path, target?.subject,
            ...target?.evidence.map(({ path }) => path) ?? [], ...action.relatedRecordIds.map((id) => mapRecords.get(id)?.subject)]
            .some((value) => value && normalize(value).includes(normalize(module))));
      }).slice(0, limit);
  }

  function strategySignals() {
    return [...feedback.values()].filter(({ kind, status }) => kind !== 'verification_gap' && status === 'pending');
  }

  async function runBatch(selector: BatchSelector, signal?: AbortSignal) {
    const investigations: Awaited<ReturnType<typeof investigate>>[] = [];
    const validations: Awaited<ReturnType<typeof validate>>[] = [];
    const selected = select(selector);
    const signalCount = strategySignals().length;
    const stopped = () => stopReason() ?? (signal?.aborted ? 'cancelled' : undefined);
    let boundary: 'batch_complete' | 'strategy_signal' = 'batch_complete';
    for (const task of selected) {
      while (hasWork(task) && !stopped()) {
        if (!pendingCandidates(task).length) {
          investigations.push(await investigate(task, signal));
        }
        for (const candidate of pendingCandidates(task)) {
          if (stopped()) break;
          validations.push(await validate(task, candidate, signal));
        }
        if (strategySignals().length > signalCount) { boundary = 'strategy_signal'; break; }
        if (investigations.at(-1)?.taskId === task.id && investigations.at(-1)?.evidenceStalled) break;
      }
      if (stopped() || boundary === 'strategy_signal') break;
    }
    return { stop: stopped() ?? boundary, selected: selected.length,
      investigations: investigations.length, validations: validations.length,
      recentInvestigations: investigations.slice(-6), recentValidations: validations.slice(-6) };
  }

  async function checkFindings() {
    const current = new Map<string, Promise<boolean>>();
    for (const task of tasks.values()) {
      for (const item of task.candidates) {
        if (!item.validation || (item.status !== 'supported' && item.status !== 'refuted')) continue;
        const { supporting, contrary } = candidateInput(item.attempt, item.index);
        const { decisionEvidenceIds, ruleEvidenceIds } = item.validation;
        const used = new Set([...decisionEvidenceIds, ...ruleEvidenceIds]);
        const target = item.attempt.detection.target;
        const ranges = [...supporting, ...contrary, ...(target ? [target.source] : []),
          ...item.validation.evidence.filter(({ id }) => used.has(id)).map(({ source }) => source)];
        for (const range of ranges) {
          const key = citationKey(range);
          if (!current.has(key)) current.set(key, repository.isCurrent(range));
          if (await current.get(key)) continue;
          item.status = 'stale';
          item.reason = 'Previously validated source changed or is unavailable: ' + range.path;
          const id = stableId('feedback', ['stale_coverage', item.id, citationKey(range)]);
          if (!feedback.has(id)) feedback.set(id, { id, kind: 'coverage_gap', status: 'pending',
            taskId: task.id, candidateId: item.id, note: item.reason, recordIds: [task.action.targetId] });
          updateCoverage(task);
          break;
        }
      }
    }
  }

  function describeTask(task: AuditTask) {
    const { action } = task;
    const target = getMap()?.records.find((record) => repositoryRecordId(record) === action.targetId);
    return { id: task.id, targetId: action.targetId, module: target?.subject ?? action.target?.source.path ?? action.targetId,
      goalId: action.goalId, direction: goals.find(({ id }) => id === action.goalId)?.title,
      priority: action.priority ?? 'normal', question: action.question, status: task.status, coverage: task.coverage, reason: task.reason };
  }

  function describeCandidate(item: Candidate) {
    return { candidateId: item.id, taskId: item.attempt.detection.taskId, candidateIndex: item.index,
      attempt: tasks.get(item.attempt.detection.taskId)!.attempts.indexOf(item.attempt) + 1,
      claim: candidateInput(item.attempt, item.index).candidate.claim, status: item.status, reason: item.reason };
  }

  return { tasks, feedback, applyTask, strategySignals, runBatch, checkFindings, hasWork, targets,
    describeTask, describeCandidate };
}
