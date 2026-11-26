import type { Api, Model, Models } from '@earendil-works/pi-ai';
import type { z } from 'zod';
import { repositoryRecordId, type RepositoryMap } from '../repository/map.ts';
import type { Repository, SourceLines } from '../repository/repository.ts';
import { stableId } from '../repository/source-symbols.ts';
import { RunStopped, type RunBudget } from '../runtime/budget.ts';
import { detectTask } from './detection.ts';
import { mergeDiscoverySources, type discoverStateSchema, type discoverTasks } from './discover.ts';
import { validateCandidate, type ValidationRequest, type validationContextSchema } from './validator.ts';

type State = z.output<typeof discoverStateSchema>;
type Feedback = State['feedback'][number] & {
  status: 'pending' | 'processed' | 'resolved' | 'unresolved' | 'not_applicable';
  candidateId?: string;
  reasonUnresolved?: string;
  resolutionReason?: string;
  resolutionEvidence?: SourceLines[];
  workIds?: string[];
};
type Action = Awaited<ReturnType<typeof discoverTasks>>['actions'][number];
type Detection = Awaited<ReturnType<typeof detectTask>>;
type Validation = Awaited<ReturnType<typeof validateCandidate>>;
type Attempt = { detection: Detection; validations: Validation[]; supplementRequestIds?: string[] };
type Supplements = NonNullable<ValidationRequest['supplements']>;
type Candidate = {
  id: string;
  attempt: Attempt;
  index: number;
  signature: string;
  seenConclusions: Set<string>;
  supplementReview?: { attempt: Attempt; answers: Supplements };
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
type BatchSelector = { taskIds?: string[]; targetId?: string; module?: string; goalId?: string;
  priority?: NonNullable<AuditTask['action']['priority']>; limit?: number };

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
  return { candidate, identity, supporting, contrary, signature };
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
    const newFeedback = action.feedbackIds.filter((id) => !task.usedFeedback.includes(id)
      || feedback.get(id)?.remainingQuestions?.length);
    if (!refreshed && (task.followUp.includes(action.note) || (task.status !== 'pending' && !newFeedback.length))) return;
    const evidence = new Map([...task.action.evidence, ...action.evidence].map((item) => [item.recordId, item]));
    task.action = { ...task.action, target: action.target ?? task.action.target, evidence: [...evidence.values()],
      discoverySources: mergeDiscoverySources(task.action.discoverySources, action.discoverySources),
      relatedRecordIds: [...new Set([...task.action.relatedRecordIds, ...action.relatedRecordIds])] };
    if (!task.followUp.includes(action.note)) task.followUp.push(action.note);
    task.usedFeedback = [...new Set([...task.usedFeedback, ...newFeedback])];
    task.status = 'pending';
    task.coverage = task.starts ? 'needs_evidence' : 'unplanned';
    task.reason = undefined;
    return task.id;
  }

  function routeLeads(task: AuditTask, leads: Detection['leads']) {
    for (const lead of leads) {
      const kind = lead.kind ?? 'discovery_lead';
      const question = normalize(lead.question);
      if (kind === 'discovery_lead' && [...tasks.values()].some(({ action, status, coverage }) =>
        (coverage === 'evaluated' || status === 'pending' || status === 'in_progress')
        && normalize(action.question) === question && action.evidence.some(({ citations }) =>
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
      const prior = feedback.get(id);
      if (prior) {
        if (prior.status === 'resolved') {
          prior.status = 'unresolved';
          prior.resolutionEvidence = undefined;
          prior.reasonUnresolved = 'The current independent review raised the same question again.';
        }
        continue;
      }
      feedback.set(id, { id, kind: 'verification_gap', status: 'pending', taskId: task.id,
        candidateId: candidate.id, note, recordIds: [task.action.targetId] });
    }
  }

  function evidenceRequests(task: AuditTask) {
    return [...feedback.values()].filter((item) =>
      item.kind === 'verification_gap' && item.taskId === task.id && item.status === 'pending');
  }

  function registerCandidates(task: AuditTask, attempt: Attempt) {
    const existing = new Set(task.candidates);
    for (const [offset] of attempt.detection.candidates.entries()) {
      const index = offset + 1;
      const input = candidateInput(attempt, index);
      if (input.candidate.priorCandidateId) continue;
      const matching = [...existing].find((item) => item.signature === input.signature) ??
        [...existing].find((item) => {
          const prior = candidateInput(item.attempt, item.index);
          return prior.identity === input.identity && prior.supporting.some((range) => input.supporting.some((source) => overlaps(range, source)));
        });
      if (!matching) {
        if (task.candidates.some((item) => item.attempt === attempt && item.signature === input.signature)) continue;
        task.candidates.push({ id: task.id + '-candidate-' + (task.candidates.length + 1), attempt, index,
          signature: input.signature, seenConclusions: new Set(), status: 'pending' });
        continue;
      }
      existing.delete(matching);
      if (matching.signature === input.signature && matching.status !== 'stale') continue;
      Object.assign(matching, { attempt, index, signature: input.signature, status: 'pending', validation: undefined, reason: undefined });
    }
  }

  function registerSupplements(task: AuditTask, attempt: Attempt, requests: Feedback[]) {
    const results = new Map(attempt.detection.supplementResults.map((result) => [result.requestId, result]));
    for (const item of task.candidates) {
      const answers: Supplements = [];
      const conclusions = new Set<string>();
      for (const gap of requests.filter(({ candidateId }) => candidateId === item.id)) {
        const result = results.get(gap.id);
        const key = result && normalize(result.conclusion).replace(/[。.!?！？]+$/u, '').trim();
        if (!result || result.status === 'unresolved' || !key || item.seenConclusions.has(key)
          || attempt.detection.assessment.status === 'blocked') {
          gap.status = 'unresolved';
          gap.reasonUnresolved = !result ? 'Supplementary investigation returned no grounded answer to this request.'
            : key && item.seenConclusions.has(key) ? 'The supplementary analysis repeats a conclusion already sent for review.'
            : [result.conclusion, ...result.uncertainties].join(' ');
          continue;
        }
        conclusions.add(key);
        gap.status = 'processed';
        gap.reasonUnresolved = undefined;
        answers.push({ requestId: gap.id, question: gap.note, conclusion: result.conclusion,
          evidence: result.evidence, uncertainties: result.uncertainties });
      }
      if (!answers.length) continue;
      const original = candidateInput(item.attempt, item.index);
      const relatedSources = [...original.supporting, ...original.contrary, ...answers.flatMap(({ evidence }) => evidence.map(({ source }) => source))];
      const revisions = attempt.detection.candidates.flatMap((candidate, index) => {
        if (candidate.priorCandidateId !== item.id || normalize(candidate.rule) !== normalize(original.candidate.rule)) return [];
        const { supporting, contrary } = candidateInput(attempt, index + 1);
        return [...supporting, ...contrary].some((source) => relatedSources.some((range) => overlaps(source, range))) ? [index + 1] : [];
      });
      if (revisions.length === 1) {
        item.attempt = attempt;
        item.index = revisions[0];
        item.signature = candidateInput(attempt, item.index).signature;
      }
      for (const conclusion of conclusions) item.seenConclusions.add(conclusion);
      item.supplementReview = { attempt, answers };
      item.status = 'pending';
      item.validation = undefined;
      item.reason = undefined;
    }
  }

  function updateCoverage(task: AuditTask) {
    if (task.status !== 'completed') return;
    const latest = task.attempts.findLast(({ supplementRequestIds }) => !supplementRequestIds)?.detection;
    task.coverage = latest && latest.assessment.status !== 'inconclusive'
      && latest.checks.every(({ status }) => status === 'addressed') && !latest.unresolved.length
      && task.candidates.every(({ status }) => status === 'supported' || status === 'refuted') ? 'evaluated' : 'needs_evidence';
  }

  async function investigate(task: AuditTask, signal?: AbortSignal) {
    const previousStatus = task.status;
    const previousCoverage = task.coverage;
    const requests = task.status === 'pending' ? [] : evidenceRequests(task);
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
        followUp: task.followUp,
        previousInvestigation: previous && { summary: previous.assessment.summary, evidence,
          requests: related.map((item) => {
            const { claim, rule } = candidateInput(item.attempt, item.index).candidate;
            return { candidateId: item.id, claim, rule, evidenceRequests: requests.filter(({ candidateId }) => candidateId === item.id)
              .map(({ id, note }) => ({ id, question: note })) };
          }) },
      }, runBudget: budget, signal }, models, model);
      signal?.throwIfAborted();
      const attempt: Attempt = { detection, validations: [],
        ...(requests.length ? { supplementRequestIds: requests.map(({ id }) => id) } : {}) };
      task.attempts.push(attempt);
      if (requests.length) {
        registerSupplements(task, attempt, requests);
        task.status = previousStatus;
        task.coverage = previousCoverage;
      } else {
        registerCandidates(task, attempt);
        task.status = detection.coverageProposal.status === 'blocked' ? 'blocked' : 'completed';
        task.coverage = detection.coverageProposal.status;
      }
      task.reason = detection.coverageProposal.status === 'blocked' ? detection.assessment.summary : undefined;
      updateCoverage(task);
      routeLeads(task, detection.leads);
      return { taskId: task.id, status: task.status, assessment: detection.assessment.summary };
    } catch (error) {
      task.reason = recordFailure('run_detection', { taskId: task.id }, error);
      const paused = interrupted(error, signal);
      task.status = requests.length ? previousStatus : paused ? 'pending' : 'blocked';
      task.coverage = requests.length ? previousCoverage : paused ? 'needs_evidence' : 'blocked';
      if (!paused) {
        for (const item of requests) {
          item.status = 'unresolved';
          item.reasonUnresolved = task.reason;
        }
      }
      return { taskId: task.id, status: task.status, reason: task.reason };
    }
  }

  async function validate(task: AuditTask, item: Candidate, signal?: AbortSignal) {
    const review = item.supplementReview;
    try {
      startChild();
      const result = await validateCandidate({ root: repository.root, repository, map: getMap(), detection: item.attempt.detection,
        candidateIndex: item.index, context, supplements: review?.answers, runBudget: budget, signal }, models, model);
      signal?.throwIfAborted();
      (review?.attempt ?? item.attempt).validations.push(result);
      item.validation = result;
      item.status = result.verdict;
      item.reason = result.verdict === 'needs_evidence' ? result.summary : undefined;
      routeLeads(task, result.leads);
      if (result.verdict === 'needs_evidence') routeEvidenceRequests(task, item, result);
    } catch (error) {
      item.reason = recordFailure('run_validator', { taskId: task.id, candidateId: item.id, candidateIndex: item.index }, error);
      item.status = interrupted(error, signal) ? 'pending' : 'blocked';
    }
    if (review && item.status !== 'pending') {
      for (const { requestId } of review.answers) {
        const gap = feedback.get(requestId)!;
        const answer = item.validation?.addressedRequests.find((answer) => answer.requestId === requestId);
        gap.status = answer ? 'resolved' : 'unresolved';
        gap.reasonUnresolved = gap.status === 'resolved' ? undefined : item.reason ?? 'The requested evidence is still insufficient.';
        gap.resolutionEvidence = answer && item.validation?.evidence.filter(({ id }) => answer.evidenceIds.includes(id)).map(({ source }) => source);
      }
      item.supplementReview = undefined;
    }
    updateCoverage(task);
    return { taskId: task.id, candidateId: item.id, status: item.status, summary: item.validation?.summary, reason: item.reason };
  }

  const hasWork = (task: AuditTask) => task.status === 'pending' || pendingCandidates(task).length > 0 || evidenceRequests(task).length > 0;

  function select({ taskIds, targetId, module, goalId, priority, limit }: BatchSelector) {
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
          && (!priority || (action.priority ?? 'normal') === priority)
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
    const queue = [...selected];
    for (let cursor = 0; cursor < queue.length && !stopped(); cursor++) {
      const task = queue[cursor];
      if (!hasWork(task)) continue;
      if (!pendingCandidates(task).length) investigations.push(await investigate(task, signal));
      for (const candidate of pendingCandidates(task)) {
        if (stopped()) break;
        validations.push(await validate(task, candidate, signal));
      }
      if (strategySignals().length > signalCount) { boundary = 'strategy_signal'; break; }
      if (hasWork(task)) queue.push(task);
    }
    return { stop: stopped() ?? boundary, selected: selected.length,
      investigations: investigations.length, validations: validations.length,
      recentInvestigations: investigations.slice(-6), recentValidations: validations.slice(-6) };
  }

  async function checkFindings() {
    const current = new Map<string, Promise<boolean>>();
    function isCurrent(range: SourceLines) {
      const key = citationKey(range);
      if (!current.has(key)) current.set(key, repository.isCurrent(range));
      return current.get(key)!;
    }
    for (const task of tasks.values()) {
      for (const item of task.candidates) {
        if (!item.validation || (item.status !== 'supported' && item.status !== 'refuted')) continue;
        const { supporting, contrary } = candidateInput(item.attempt, item.index);
        const { decisionEvidenceIds, ruleEvidenceIds } = item.validation;
        const used = new Set([...decisionEvidenceIds, ...ruleEvidenceIds,
          ...item.validation.addressedRequests.flatMap(({ evidenceIds }) => evidenceIds)]);
        const target = item.attempt.detection.target;
        const ranges = [...supporting, ...contrary, ...(target ? [target.source] : []),
          ...item.validation.evidence.filter(({ id }) => used.has(id)).map(({ source }) => source)];
        for (const range of ranges) {
          if (await isCurrent(range)) continue;
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
    for (const item of feedback.values()) {
      if (item.status !== 'resolved' || !item.resolutionEvidence?.length) continue;
      if ((await Promise.all(item.resolutionEvidence.map(isCurrent))).every(Boolean)) continue;
      item.status = 'unresolved';
      item.resolutionReason = undefined;
      item.reasonUnresolved = 'Source evidence for the recorded answer changed or is unavailable.';
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
