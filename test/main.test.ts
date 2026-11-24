import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { runMain } from '../src/agents/main.ts';

const handler = { path: 'handler.js', startLine: 1, endLine: 1 };
const entry = { kind: 'entry', subject: 'createRecord', description: '创建记录入口', basis: 'observed', evidence: [handler] };
const goals = [{ id: 'state', title: '创建状态', description: '核对新记录的默认状态。' }];
const call = (name: string, params = {}) =>
  fauxAssistantMessage([fauxToolCall(name, params)], { stopReason: 'toolUse' });
const reply = (value: object) => fauxAssistantMessage([fauxText(JSON.stringify(value))]);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'main-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, handler.path), 'export const createRecord = () => service.createRecord();\n');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { root, models, faux, model: faux.getModel() };
}

test('Main dispatches all four Pi sessions and replans from coverage and evidence feedback', async (t) => {
  const { root, models, model, faux } = await fixture(t);
  const task = { kind: 'create_task', targetId: 'entry:createRecord', goalId: 'state',
    question: '默认状态如何确定？', expectedEvidence: ['状态初始化位置'], reason: '新入口尚无覆盖' };
  const gap = '定位持久化层默认状态及适用业务规则。';
  let feedbackIds: string[] = [];
  faux.setResponses([
    call('run_repository'),
    call('read_lines', handler),
    reply({ summary: '定位入口', records: [entry], unresolved: [] }),
    () => {
      writeFileSync(join(root, 'created-between-agents.js'), 'function addedLater() {}');
      return call('run_discover');
    },
    call('query_files', { scope: 'created-between-agents.js' }),
    ({ messages }) => {
      const result = messages.findLast((item) => item.role === 'toolResult' && item.toolName === 'query_files');
      assert.ok(result?.role === 'toolResult' && !result.isError);
      const block = result.content.find((item) => item.type === 'text');
      assert.ok(block);
      assert.equal(JSON.parse(block.text).total, 0);
      return call('query_map');
    },
    reply({ actions: [task, { kind: 'request_repository_read', targetId: task.targetId,
      question: '梳理创建服务的关系。', reason: '补全模块地图' }] }),
    call('run_repository', { requestId: 'read-1' }),
    ({ messages }) => {
      const users = messages.filter(({ role }) => role === 'user');
      assert.equal(users.length, 1);
      assert.match(JSON.stringify(users[0]), /梳理创建服务的关系/);
      return call('read_lines', handler);
    },
    reply({ summary: '补全服务模块', records: [{ ...entry, kind: 'module', subject: 'service' }], unresolved: [] }),
    call('run_detection', { taskId: 'task-1' }),
    call('read_lines', handler),
    reply({ assessment: { status: 'suspected_violation', summary: '默认状态缺少明确依据。' },
      evidence: [{ id: 'initial', source: handler, observation: '入口调用创建服务。' }],
      checks: [{ index: 1, status: 'unresolved', note: '服务层未定位。', evidenceIds: ['initial'] }],
      candidates: [{ claim: '默认状态可能不符合要求。', rule: '默认进入草稿。', evidenceIds: ['initial'] }],
      leads: [{ question: '其他入口是否复用创建服务？', reason: '可能共享状态规则。', evidenceIds: ['initial'] }],
      unresolved: [] }),
    call('run_validator', { taskId: 'task-1', candidateIndex: 1 }),
    call('read_lines', handler),
    reply({ verdict: 'needs_evidence', summary: '调用端未确定服务层状态。', scope: '当前源码',
      evidence: [{ id: 'own', source: handler, observation: '状态来自服务。' }], neededEvidence: [gap] }),
    call('run_discover'),
    ({ messages }) => {
      const users = messages.filter(({ role }) => role === 'user');
      assert.equal(users.length, 1);
      const content = users[0].content;
      assert.ok(typeof content !== 'string' && content[0].type === 'text');
      const input = JSON.parse(content[0].text);
      assert.equal(input.phase, 'incremental');
      assert.deepEqual(input.feedback.map((item: { kind: string }) => item.kind), ['discovery_lead', 'verification_gap']);
      feedbackIds = input.feedback.map((item: { id: string }) => item.id);
      return call('query_coverage', { gapsOnly: true });
    },
    () => reply({ actions: [{ kind: 'supplement_task', taskId: 'task-1', note: gap, reason: '复核后补查', feedbackIds },
      { ...task, targetId: 'module:service', question: '服务有没有统一设定创建状态？', reason: '新增模块尚无覆盖' }] }),
    call('get_audit_state'),
    reply({ summary: '已复核候选，下一轮补查业务规则。' }),
  ]);

  const result = await runMain({ root, goals, maxSubagentCalls: 6 }, models, model);
  assert.equal(result.error, null);
  assert.deepEqual(result.failures, []);
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.subagentCalls, 6);
  assert.equal(result.indexSummary.totalFiles, 1);
  assert.equal(result.readJobs[0].status, 'completed');
  assert.deepEqual(result.map?.records.map(({ subject }) => subject), ['createRecord', 'service']);
  assert.deepEqual(result.plans.map(({ phase }) => phase), ['initial', 'incremental']);
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.plans[0].actions[0].feedbackIds, []);
  assert.equal(result.tasks[0].attempts[0].validations[0].verdict, 'needs_evidence');
  assert.deepEqual(result.tasks[0].followUp, [gap]);
  assert.equal(result.pending.pendingTasks[0].id, 'task-1');
  assert.equal(result.coverage[0].status, 'needs_evidence');
  assert.equal(result.coverage[1].status, 'unplanned');
  assert.deepEqual(result.findings, []);
});

test('Main rejects invalid work and does not start child sessions beyond the shared budget', async (t) => {
  const { root, models, model, faux } = await fixture(t);
  faux.setResponses([
    call('run_discover'),
    call('run_detection', { taskId: 'task-100' }),
    call('run_repository'),
    reply({ summary: '地图为空', records: [], unresolved: [] }),
    call('run_discover'),
    reply({ summary: '预算用完' }),
  ]);
  const result = await runMain({ root, goals, maxSubagentCalls: 1 }, models, model);
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.subagentCalls, 1);
  assert.equal(result.plans.length, 0);
  assert.equal(result.pending.discoverReady, true);
  assert.equal(faux.state.callCount, 6);
});

test('Main cancels a running Pi child at the deadline and preserves completed work', async (t) => {
  const { root, models, model, faux } = await fixture(t);
  let childSignal: AbortSignal | undefined;
  faux.setResponses([
    call('run_repository'),
    reply({ summary: '初读完毕', records: [], unresolved: [] }),
    call('run_discover'),
    async (_context, options) => {
      childSignal = options?.signal;
      if (childSignal && !childSignal.aborted) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(fallback);
            resolve();
          };
          const fallback = setTimeout(done, 1800);
          childSignal?.addEventListener('abort', done, { once: true });
        });
      }
      return reply({ actions: [] });
    },
  ]);
  const result = await runMain({ root, goals, timeoutMs: 1000 }, models, model);
  assert.equal(childSignal?.aborted, true);
  assert.equal(result.status, 'interrupted');
  assert.match(result.error ?? '', /timed out/);
  assert.equal(result.repositoryReads.length, 1);
  assert.equal(result.plans.length, 0);
  assert.equal(result.pending.discoverReady, true);
});
