import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { detectTask } from '../src/agents/detection.ts';
import { discoverTasks } from '../src/agents/discover.ts';
import { validateCandidate, type ValidationRequest } from '../src/agents/validator.ts';
import { Repository } from '../src/repository/repository.ts';

const handler = { path: 'handler.js', startLine: 1, endLine: 1 };
const task = { taskId: 'default-status', targetId: 'entry:createRecord', goalId: 'state',
  question: '创建后状态是否符合约定？', expectedEvidence: ['默认状态来源'] };
const requiredRule = { id: 'draft-state', rule: '新记录默认为草稿。', source: '产品规范第 2 节', provenance: 'documented' as const };

function provider(draft: object, calls: [string, Parameters<typeof fauxToolCall>[1]][] = []) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    ...calls.map(([name, parameters]) => fauxAssistantMessage([fauxToolCall(name, parameters)], { stopReason: 'toolUse' })),
    fauxAssistantMessage([fauxText(JSON.stringify(draft))]),
  ]);
  return [models, faux.getModel(), faux] as const;
}

async function fixture(t: TestContext, source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'validator-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  await writeFile(join(root, 'handler.js'), source);
  const repo = await Repository.open(root);
  const { sha256 } = await repo.readLines('handler.js', 1, 1);
  const map = { version: 1 as const, root, records: [{ kind: 'entry' as const, subject: 'createRecord',
    description: '创建记录', basis: 'observed' as const, evidence: [{ ...handler, sha256 }] }] };
  const [models, model] = provider({ assessment: { status: 'suspected_violation', summary: '创建状态有待确认。' },
    evidence: [{ id: 'initial', source: handler, observation: '这里定义了创建入口。' }],
    checks: [{ index: 1, status: 'addressed', note: '已找到入口。', evidenceIds: ['initial'] }],
    candidates: [{ claim: '创建后状态可能不是草稿。', rule: '新记录默认为草稿。', evidenceIds: ['initial'] }],
    leads: [], unresolved: [],
  }, [['read_lines', handler]]);
  const detection = await detectTask({ root, task, map }, models, model);
  return { root, map, detection } satisfies ValidationRequest;
}

test('supports a candidate only with independent current evidence and a documented rule', async (t) => {
  const request = await fixture(t, 'export const creationStatus = "active";\n');
  const reply = { verdict: 'supported', summary: '初始化明确设置 active。', scope: '当前初始化路径。',
    evidence: [{ id: 'own', source: handler, observation: '状态初始化为 active。' }], decisionEvidenceIds: ['own'], ruleIds: ['draft-state'] };
  const [models, model] = provider(reply, [['read_lines', handler]]);
  const supported = await validateCandidate({ ...request, context: { rules: [requiredRule] } }, models, model);
  assert.equal(supported.verdict, 'supported');
  assert.equal(supported.candidateIndex, 1);
  assert.deepEqual(supported.ruleSources, [requiredRule]);
  assert.deepEqual(supported.decisionEvidenceIds, ['own']);
  assert.equal(supported.feedback, null);

  const [fallbackModels, fallbackModel] = provider(reply, [['read_lines', handler]]);
  const insufficient = await validateCandidate({ ...request, context: { rules: [{ ...requiredRule, provenance: 'inferred' }] } },
    fallbackModels, fallbackModel);
  assert.equal(insufficient.verdict, 'needs_evidence');
  assert.ok(insufficient.neededEvidence.some((note) => note.includes('applicable rule')));
});

test('refutes a candidate using an independently read shared implementation', async (t) => {
  const request = await fixture(t, 'export { createRecord } from "./shared.js";\n');
  const shared = { path: 'shared.js', startLine: 1, endLine: 1 };
  await writeFile(join(request.root, shared.path), 'export const createRecord = () => ({ state: "draft" });\n');
  const [models, model] = provider({ verdict: 'refuted', summary: '共享实现返回草稿。', scope: '通过此入口导出的实现。',
    evidence: [{ id: 'shared', source: shared, observation: '创建函数将状态设为 draft。' }], decisionEvidenceIds: ['shared'],
  }, [['read_lines', handler], ['search_text', { query: 'createRecord' }], ['read_lines', shared]]);
  const result = await validateCandidate(request, models, model);
  assert.equal(result.verdict, 'refuted');
  assert.equal(result.evidence[0].source.path, 'shared.js');
  assert.equal(result.feedback, null);
});

test('missing implementation produces a Discover feedback item for the original task', async (t) => {
  const request = await fixture(t, 'export const createRecord = () => service.createRecord();\n');
  const [models, model] = provider({ verdict: 'needs_evidence', summary: '服务端默认状态不可见。', scope: '调用端源码。',
    evidence: [{ id: 'call', source: handler, observation: '状态由服务端处理。' }], neededEvidence: ['定位 service.createRecord 的服务端实现。'],
  }, [['read_lines', handler]]);
  const result = await validateCandidate(request, models, model);
  assert.equal(result.verdict, 'needs_evidence');
  assert.ok(result.feedback);
  assert.equal(result.feedback.taskId, 'default-status');
  assert.deepEqual(result.feedback.recordIds, ['entry:createRecord']);

  const [planner, planningModel] = provider({ actions: [{ kind: 'supplement_task', taskId: task.taskId,
    note: result.feedback.note, reason: '补查复核指出的服务端实现。', feedbackIds: [result.feedback.id] }] }, [['query_tasks', {}]]);
  const plan = await discoverTasks({ map: request.map, state: {
    goals: [{ id: 'state', title: '创建状态', description: requiredRule.rule }],
    tasks: [{ ...task, id: task.taskId, status: 'in_progress' }], feedback: [result.feedback],
  } }, planner, planningModel);
  assert.equal(plan.actions[0].kind, 'supplement_task');
  assert.equal(plan.actions[0].taskId, task.taskId);
});

test('returns the changed evidence for refresh without spending a model turn', async (t) => {
  const request = await fixture(t, 'export const creationStatus = "active";\n');
  await writeFile(join(request.root, handler.path), 'export const creationStatus = "draft";\n');
  const [models, model, faux] = provider({});
  const result = await validateCandidate(request, models, model);
  assert.equal(result.verdict, 'needs_evidence');
  assert.equal(result.run, null);
  assert.equal(faux.state.callCount, 0);
  assert.equal(result.staleEvidence[0].source.path, handler.path);
  assert.equal(result.feedback?.taskId, task.taskId);
});
