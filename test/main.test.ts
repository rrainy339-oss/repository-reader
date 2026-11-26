import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message } from '@earendil-works/pi-ai';
import { runMain } from '../src/agents/main.ts';
import { emptyRuleScan } from '../src/scanners/semgrep.ts';

const handler = { path: 'handler.js', startLine: 1, endLine: 1 };
const service = { path: 'service.js', startLine: 1, endLine: 1 };
const goal = { id: 'status', title: '创建状态', description: '核对记录的初始状态。' };
const rule = { id: 'draft', rule: '新记录默认为草稿。', source: '产品规范', provenance: 'documented' as const };
const call = (name: string, params = {}) =>
  fauxAssistantMessage([fauxToolCall(name, params)], { stopReason: 'toolUse' });
const reply = (value: object) => fauxAssistantMessage([fauxText(JSON.stringify(value))]);
const read = (source = handler) => call('read_lines', source);
const proposal = (source = handler, question = '创建时写入哪种状态？', fields = {}) => ({
  kind: 'create_task', target: { kind: 'file', source }, goalId: goal.id, question,
  expectedEvidence: ['定位初始化。'], reason: '源文件实现初始化。', ...fields,
});
const evidence = (source = handler, id = 'original') => ({ id, source, observation: '此处设置初始值。' });
const candidate = (claim: string, evidenceIds = ['original']) => ({ claim, rule: rule.rule, evidenceIds });
const detection = (options: object = {}) => ({
  assessment: { status: 'no_issue_observed', summary: '已读取源文件中的初始化。' },
  evidence: [evidence()], checks: [{ index: 1, status: 'addressed', note: '查阅赋值。', evidenceIds: ['original'] }],
  candidates: [], leads: [], unresolved: [], ...options,
});
const decision = (verdict: string, source = handler, options: object = {}) => ({
  verdict, summary: '已复查赋值。', scope: '当前源码', evidence: [evidence(source, 'own')],
  decisionEvidenceIds: ['own'], ruleIds: [rule.id], ...options,
});
const firstPlan = (...actions: ReturnType<typeof proposal>[]) =>
  [call('run_discover'), read(), ...(actions.some(({ target }) => target.source.path === service.path) ? [read(service)] : []), reply({ actions })];

function input(messages: Message[]) {
  const entry = messages.find(({ role }) => role === 'user');
  assert.ok(entry?.role === 'user');
  const block = typeof entry.content === 'string' ? entry.content : entry.content[0];
  return JSON.parse(typeof block === 'string' ? block : block.type === 'text' ? block.text : '');
}

function output(messages: Message[], name: string) {
  const entry = messages.findLast((message) => message.role === 'toolResult' && message.toolName === name);
  assert.ok(entry?.role === 'toolResult');
  const block = entry.content.find((item) => item.type === 'text');
  assert.ok(block?.type === 'text');
  return JSON.parse(block.text);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'main-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(root, handler.path), 'export const status = "active";\n'),
    writeFile(join(root, service.path), 'export const state = "draft";\n'),
  ]);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const run = (options: Pick<Parameters<typeof runMain>[0], 'budget' | 'maxSubagentCalls' | 'signal'> = {}) => runMain({
    root, goal: '只审计 handler.js 和 service.js 的初始状态。', goals: [goal], context: { rules: [rule] },
    budget: { timeoutMs: 0 }, ruleScanner: async () => emptyRuleScan('disabled'), ...options,
  }, models, faux.getModel());
  return { root, faux, run };
}

test('Main plans from source without a map and runs a priority batch without Main turns between tasks', async (t) => {
  const { faux, run } = await fixture(t);
  faux.setResponses([
    ...firstPlan(proposal(), proposal(service, '服务层怎样初始化？', { priority: 'high' })),
    call('run_task_batch', { goalId: goal.id }),
    ({ messages }) => {
      assert.equal(input(messages).taskId, 'task-2');
      return read(service);
    },
    reply(detection({ evidence: [evidence(service)] })),
    ({ messages }) => {
      assert.equal(input(messages).taskId, 'task-1');
      return read();
    },
    reply(detection()),
    ({ messages }) => {
      const batch = output(messages, 'run_task_batch');
      assert.equal(batch.investigations, 2);
      assert.equal(batch.stop, 'batch_complete');
      assert.equal(batch.state.discoverReady, false);
      assert.deepEqual(batch.state.modules, [['handler.js', 1], ['service.js', 1]]);
      return call('get_audit_state', { view: 'tasks', limit: 1 });
    },
    ({ messages }) => {
      const { items, nextOffset } = output(messages, 'get_audit_state');
      assert.equal(items[0].question, proposal().question);
      assert.equal(items[0].direction, goal.title);
      assert.equal(nextOffset, 1);
      return reply({ summary: '完成两个已安排的检查。' });
    },
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.map, null);
  assert.equal(result.repositoryReads.length, 0);
  assert.equal(result.plans[0].phase, 'initial');
  assert.equal(result.subagentCalls, 3);
  assert.deepEqual(result.run?.toolCalls, ['run_discover', 'run_task_batch', 'get_audit_state']);
  assert.equal(result.status, 'queue_drained');
});

test('Detection batches duplicate leads into an incremental plan and skips already covered questions', async (t) => {
  const { faux, run } = await fixture(t);
  const question = '服务层是否在其他入口初始化状态？';
  const lead = { question, reason: '多个入口使用该服务。', evidenceIds: ['service'] };
  let leadId = '';
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch', { taskIds: ['task-1'] }), read(), read(service),
    reply(detection({ evidence: [evidence(), evidence(service, 'service')],
      leads: [lead, { ...lead, reason: '另一个描述。' }, { ...lead, question: proposal().question, evidenceIds: ['original'] }] })),
    ({ messages }) => {
      const batch = output(messages, 'run_task_batch');
      assert.equal(batch.stop, 'strategy_signal');
      assert.equal(batch.state.planning.newFeedback, 1);
      return call('run_discover', { phase: 'incremental' });
    },
    ({ messages }) => {
      const plan = input(messages);
      assert.equal(plan.phase, 'incremental');
      assert.equal(plan.newLeads.length, 1);
      assert.equal(plan.newLeads[0].question, question);
      assert.equal(plan.newLeads[0].evidence[0].path, service.path);
      assert.deepEqual(plan.relevantFeedback, []);
      leadId = plan.newLeads[0].id;
      return read(service);
    },
    () => reply({ actions: [proposal(service, question, { feedbackIds: [leadId] })] }),
    call('run_task_batch', { module: 'service.js' }), read(service),
    reply(detection({ evidence: [evidence(service)], leads: [{ ...lead, evidenceIds: ['original'] }] })),
    reply({ summary: '增量检查结束。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.deepEqual(result.plans.map(({ phase }) => phase), ['initial', 'incremental']);
  assert.deepEqual(result.plans[1].planning.feedbackIds, [leadId]);
  assert.equal(result.feedback.length, 1);
  assert.equal(result.feedback[0].status, 'processed');
  assert.equal(result.tasks[1].action.discoverySources[0].kind, 'detection_lead');
  assert.equal(result.pending.discoverReady, false);
});

test('ordinary supported and refuted verdicts do not make Discover ready', async (t) => {
  const { faux, run } = await fixture(t);
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(),
    reply(detection({ candidates: [candidate('状态值有误。'), candidate('状态初始化缺失。')] })),
    read(), reply(decision('supported')), read(), reply(decision('refuted')),
    reply({ summary: '两条候选完成独立复核。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.pending.discoverReady, false);
  assert.deepEqual(result.feedback, []);
  assert.deepEqual(result.candidates.map(({ status }) => status), ['supported', 'refuted']);
  assert.equal(result.findings.length, 1);
  assert.equal(result.coverage[0].status, 'evaluated');
});

test('a concrete Validator request goes directly to the original Detection task and preserves independent findings', async (t) => {
  const { faux, run } = await fixture(t);
  const first = candidate('入口状态值有误。');
  const second = candidate('服务入口状态值有误。');
  const gap = '定位服务层初始值。';
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(),
    reply(detection({ candidates: [first, second] })),
    read(), reply(decision('supported')),
    read(), reply(decision('needs_evidence', handler, { neededEvidence: [gap, '  ' + gap] })),
    ({ messages }) => {
      const task = input(messages);
      assert.equal(task.taskId, 'task-1');
      assert.deepEqual(task.followUp, [gap]);
      assert.deepEqual(task.previousInvestigation.requests, [{ claim: second.claim, questions: [gap] }]);
      assert.equal(task.previousInvestigation.evidence[0].source.path, handler.path);
      return read();
    },
    read(service),
    reply(detection({ evidence: [evidence(), evidence(service, 'service')],
      candidates: [{ ...second, counterevidenceIds: ['service'] }] })),
    ({ messages }) => {
      assert.equal(input(messages).claim, second.claim);
      return read();
    },
    read(service), reply(decision('refuted', service)),
    reply({ summary: '补证完成。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].attempts.length, 2);
  assert.equal(result.tasks[0].attempts[1].validations.length, 1);
  assert.deepEqual(result.findings.map(({ claim }) => claim), [first.claim]);
  assert.deepEqual(result.candidates.map(({ status }) => status), ['supported', 'refuted']);
  assert.deepEqual(result.feedback.map(({ kind, status }) => [kind, status]), [['verification_gap', 'resolved']]);
  assert.equal(result.pending.discoverReady, false);
});

test('unchanged evidence and repeated questions leave an unresolved candidate and stop the loop', async (t) => {
  const { faux, run } = await fixture(t);
  const unresolved = candidate('服务入口状态值有误。');
  const gap = '定位服务层初始值。';
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(), reply(detection({ candidates: [unresolved] })),
    read(), reply(decision('needs_evidence', handler, { neededEvidence: [gap] })),
    read(), reply(detection({ candidates: [{ ...unresolved, openQuestions: ['改写同一个问题。'] }] })),
    call('run_task_batch', { taskIds: ['task-1'] }),
    ({ messages }) => {
      const batch = output(messages, 'run_task_batch');
      assert.equal(batch.investigations, 0);
      assert.equal(batch.validations, 0);
      return reply({ summary: '仍缺少可核验的信息。' });
    },
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.status, 'work_remaining');
  assert.equal(result.tasks[0].starts, 2);
  assert.equal(result.tasks[0].attempts[1].validations.length, 0);
  assert.equal(result.coverage[0].status, 'needs_evidence');
  assert.equal(result.feedback[0].status, 'unresolved');
  assert.match(result.feedback[0].reasonUnresolved ?? '', /did not establish new evidence/);
  assert.equal(result.pending.discoverReady, false);
});

test('Main can explore a focused direction without a pending planning signal', async (t) => {
  const { faux, run } = await fixture(t);
  const focus = '核对服务层独立入口。';
  faux.setResponses([
    call('run_discover'), reply({ actions: [] }),
    call('run_discover', { focus }),
    ({ messages }) => {
      assert.equal(input(messages).focus, focus);
      assert.equal(input(messages).phase, 'incremental');
      return reply({ actions: [] });
    },
    reply({ summary: '完成两次定向规划。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.plans.length, 2);
  assert.equal(result.plans[1].planning.focus, focus);
  assert.deepEqual(result.plans[1].planning.feedbackIds, []);
  assert.equal(result.pending.discoverReady, false);
});

test('a mapless Discover can request focused repository context when planning needs it', async (t) => {
  const { faux, run } = await fixture(t);
  const question = '服务从何处获取初始化规则？';
  const focus = '记录服务';
  faux.setResponses([
    call('run_discover'), reply({ actions: [{ kind: 'request_repository_read', focus, question, reason: '需要业务背景。' }] }),
    call('run_repository', { requestId: 'read-1' }),
    ({ messages }) => {
      assert.equal(input(messages).goal, question);
      assert.deepEqual(input(messages).focus, [focus]);
      return reply({ summary: '读取定向上下文。', records: [], unresolved: [] });
    },
    reply({ summary: '已按需补读。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.readJobs[0].status, 'completed');
  assert.equal(result.repositoryReads[0].requestId, 'read-1');
});

test('Validator routes independent leads and coverage gaps to planning, and repository questions to Main', async (t) => {
  const { faux, run } = await fixture(t);
  const repositoryQuestion = '服务层在哪边信任入口的身份？';
  const lead = { question: '其他创建入口是否应用同一限制？', reason: '代码显示独立入口。', evidenceIds: ['own'] };
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(), reply(detection({ candidates: [candidate('状态值有误。')] })),
    read(), reply(decision('supported', handler, { leads: [
      lead, { ...lead, kind: 'repository_context', question: repositoryQuestion },
      { ...lead, kind: 'coverage_gap', question: '后台创建入口尚待检查。' },
    ] })),
    call('get_audit_state', { view: 'feedback' }),
    ({ messages }) => {
      const { items } = output(messages, 'get_audit_state');
      assert.equal(items.length, 3);
      const context = items.find(({ kind }: { kind: string }) => kind === 'repository_context');
      assert.equal(context.question, repositoryQuestion);
      return call('run_repository', { focus: ['创建服务'], feedbackIds: [context.id] });
    },
    ({ messages }) => {
      assert.equal(input(messages).goal, repositoryQuestion);
      assert.deepEqual(input(messages).focus, ['创建服务']);
      return read();
    },
    reply({ summary: '服务概览', records: [{ kind: 'module', subject: '创建服务',
      description: '定义创建路径。', basis: 'observed', evidence: [handler] }], unresolved: [] }),
    call('run_discover'),
    ({ messages }) => {
      assert.equal(input(messages).newLeads[0].question, lead.question);
      assert.deepEqual(input(messages).relevantFeedback.map(({ kind }: { kind: string }) => kind), ['coverage_gap']);
      return reply({ actions: [] });
    },
    reply({ summary: '已分流线索并补读仓库。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.plans[1].planning.repositoryRecordIds, ['module:创建服务']);
  assert.equal(result.plans[1].planning.feedbackIds.length, 2);
  assert.ok(result.feedback.every(({ status }) => status === 'processed'));
});

test('a failed investigation is blocked and prior findings survive', async (t) => {
  const { faux, run } = await fixture(t);
  faux.setResponses([
    ...firstPlan(proposal(), proposal(service, '服务怎样初始化？')),
    call('run_task_batch'), read(), reply(detection({ candidates: [candidate('状态值有误。')] })),
    read(), reply(decision('supported')),
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Simulated provider failure' }),
    reply({ summary: '第二项未能调查。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.status, 'work_remaining');
  assert.equal(result.findings.length, 1);
  assert.equal(result.tasks[1].status, 'blocked');
  assert.equal(result.coverage[1].status, 'blocked');
  assert.match(result.tasks[1].reason ?? '', /Simulated provider failure/);
});

test('batch budget exhaustion preserves a supported candidate and leaves remaining work pending', async (t) => {
  const { faux, run } = await fixture(t);
  faux.setResponses([
    ...firstPlan(proposal(), proposal(service, '服务怎样初始化？')),
    call('run_task_batch'), read(),
    reply(detection({ candidates: [candidate('状态值有误。'), candidate('状态初始化缺失。')] })),
    read(), reply(decision('supported')),
    ({ messages }) => {
      const batch = output(messages, 'run_task_batch');
      assert.equal(batch.stop, 'subagent_calls');
      assert.equal(batch.state.remainingSubagentCalls, 0);
      return reply({ summary: '可用预算已用尽。' });
    },
  ]);
  const result = await run({ maxSubagentCalls: 3 });
  assert.equal(result.error, null);
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.stopReason, 'subagent_calls');
  assert.equal(result.subagentCalls, 3);
  assert.equal(result.findings.length, 1);
  assert.equal(result.pending.pendingValidations.length, 1);
  assert.equal(result.tasks[1].starts, 0);
  assert.equal(result.tasks[1].status, 'pending');
});

test('the shared model budget can stop an active Validator without discarding a prior verdict', async (t) => {
  const { faux, run } = await fixture(t);
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(),
    reply(detection({ candidates: [candidate('状态值有误。'), candidate('状态初始化缺失。')] })),
    read(), reply(decision('supported')), read(),
  ]);
  const result = await run({ budget: { timeoutMs: 0, maxModelCalls: 9 } });
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.stopReason, 'model_calls');
  assert.equal(result.budget.modelCalls, 9);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.candidates.map(({ status }) => status), ['supported', 'pending']);
  assert.match(result.candidates[1].reason ?? '', /budget exhausted/);
});

test('changed decision evidence marks only the affected candidate stale', async (t) => {
  const { root, faux, run } = await fixture(t);
  faux.setResponses([
    ...firstPlan(proposal(), proposal(service, '服务怎样初始化？')),
    call('run_task_batch'), read(), reply(detection({ candidates: [candidate('入口状态值有误。')] })),
    read(), reply(decision('supported')),
    read(service), reply(detection({ evidence: [evidence(service)], candidates: [candidate('服务状态值有误。')] })),
    read(service), reply(decision('supported', service)),
    async () => {
      await writeFile(join(root, handler.path), 'export const status = "draft";\n');
      return reply({ summary: '已复查两个文件。' });
    },
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.deepEqual(result.candidates.map(({ status }) => status), ['stale', 'supported']);
  assert.deepEqual(result.findings.map(({ claim }) => claim), ['服务状态值有误。']);
  assert.equal(result.tasks[0].attempts[0].validations[0].verdict, 'supported');
  assert.equal(result.coverage[0].status, 'needs_evidence');
});

test('invalid task selection spends no subagent budget', async (t) => {
  const { faux, run } = await fixture(t);
  faux.setResponses([
    call('run_task_batch', { taskIds: ['task-100'] }),
    ({ messages }) => {
      assert.match(output(messages, 'run_task_batch').error, /Unknown task ID/);
      return call('run_discover');
    },
    reply({ actions: [] }),
    reply({ summary: '仅执行了规划。' }),
  ]);
  const result = await run({ maxSubagentCalls: 1 });
  assert.equal(result.error, null);
  assert.equal(result.subagentCalls, 1);
  assert.equal(result.status, 'queue_drained');
  assert.equal(result.plans.length, 1);
});

test('a running child is cancelled at the deadline and completed repository work is preserved', async (t) => {
  const { faux, run } = await fixture(t);
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
  const result = await run({ budget: { timeoutMs: 1000 } });
  assert.equal(childSignal?.aborted, true);
  assert.equal(result.status, 'interrupted');
  assert.match(result.error ?? '', /timed out/);
  assert.equal(result.repositoryReads.length, 1);
  assert.equal(result.plans.length, 0);
  assert.equal(result.pending.discoverReady, true);
});
