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
    () => reply({ actions: [proposal(service, question, { feedbackIds: [leadId] })],
      feedbackOutcomes: [{ feedbackId: leadId, status: 'addressed', reason: '新任务覆盖该入口。' }] }),
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

test('Discover retains untouched feedback and the remaining part of a lead after accepting a task', async (t) => {
  const { faux, run } = await fixture(t);
  const first = '服务的初始化与回收规则是什么？';
  const second = '服务配置从哪里加载？';
  const remaining = '服务的回收规则是什么？';
  let firstId = '';
  let secondId = '';
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(), read(service),
    reply(detection({ evidence: [evidence(), evidence(service, 'service')], leads: [first, second].map((question) =>
      ({ question, reason: '需另行检查服务。', evidenceIds: ['service'] })) })),
    call('run_discover'),
    ({ messages }) => {
      const leads = input(messages).newLeads;
      firstId = leads.find(({ question }: { question: string }) => question === first).id;
      secondId = leads.find(({ question }: { question: string }) => question === second).id;
      return read(service);
    },
    () => reply({ actions: [proposal(service, '服务的初始化规则是什么？', { feedbackIds: [firstId] })],
      feedbackOutcomes: [{ feedbackId: firstId, status: 'addressed', reason: '初始化已派单，回收仍待分析。', remainingQuestions: [remaining] }] }),
    call('run_task_batch', { taskIds: ['task-2'] }), read(service), reply(detection({ evidence: [evidence(service)] })),
    call('run_discover'),
    ({ messages }) => {
      assert.match(output(messages, 'run_discover').error, /no pending planning signal/);
      return reply({ summary: '本轮工作已执行，两个线索仍有缺口。' });
    },
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.status, 'work_remaining');
  assert.equal(result.pending.pendingTasks.length, 0);
  assert.equal(result.pending.discoverReady, false);
  assert.equal(result.pending.repositoryCoverage, 'unknown');
  const outstanding = new Map(result.pending.unresolvedFeedback.map((item) => [item.id, item]));
  assert.deepEqual(outstanding.get(firstId)?.remainingQuestions, [remaining]);
  assert.deepEqual(outstanding.get(firstId)?.workIds, ['task-2']);
  assert.match(outstanding.get(secondId)?.reasonUnresolved ?? '', /no complete disposition/);
  assert.equal(result.plans.length, 2);
});

test('a rejected action and a false coverage claim leave the source lead unresolved', async (t) => {
  const { faux, run } = await fixture(t);
  const question = '服务是否在单独入口设定默认值？';
  let feedbackId = '';
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(), read(service),
    reply(detection({ evidence: [evidence(), evidence(service, 'service')],
      leads: [{ question, reason: '有独立实现。', evidenceIds: ['service'] }] })),
    call('run_discover'),
    ({ messages }) => {
      feedbackId = input(messages).newLeads[0].id;
      return reply({ actions: [proposal(service, question, { feedbackIds: [feedbackId] })],
        feedbackOutcomes: [{ feedbackId, status: 'addressed', reason: '服务专项已安排。' }] });
    },
    ({ messages }) => {
      assert.equal(output(messages, 'run_discover').discarded, 1);
      return call('run_discover', { focus: '复查主入口是否能覆盖服务线索', feedbackIds: [feedbackId] });
    },
    ({ messages }) => {
      assert.match(input(messages).newLeads[0].reasonUnresolved, /not fully read/);
      return reply({ actions: [], feedbackOutcomes: [{ feedbackId, status: 'covered', reason: '已有入口任务。',
        taskIds: ['task-1'] }] });
    },
    reply({ summary: '服务线索仍待检查。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(result.plans[1].discarded[0].feedbackIds, [feedbackId]);
  assert.equal(result.pending.unresolvedFeedback[0].id, feedbackId);
  assert.match(result.pending.unresolvedFeedback[0].reasonUnresolved ?? '', /source-linked coverage/);
  assert.equal(result.pending.discoverReady, false);
});

test('Discover can close a lead linked to eligible existing source work without opening another task', async (t) => {
  const { faux, run } = await fixture(t);
  const question = '服务如何选择初始值？';
  faux.setResponses([
    ...firstPlan(proposal(), proposal(service, '服务的初始化规则是什么？', { expectedEvidence: [question] })),
    call('run_task_batch', { taskIds: ['task-1'] }), read(), read(service),
    reply(detection({ evidence: [evidence(), evidence(service, 'service')],
      leads: [{ question, reason: '检查独立实现。', evidenceIds: ['service'] }] })),
    call('run_discover'),
    ({ messages }) => reply({ actions: [], feedbackOutcomes: [{ feedbackId: input(messages).newLeads[0].id,
      status: 'covered', reason: '已有任务检查该函数的初始化规则。', taskIds: ['task-2'] }] }),
    call('run_task_batch', { taskIds: ['task-2'] }), read(service), reply(detection({ evidence: [evidence(service)] })),
    reply({ summary: '已有任务已检查该线索。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.feedback[0].status, 'processed');
  assert.deepEqual(result.feedback[0].workIds, ['task-2']);
  assert.equal(result.pending.discoverReady, false);
  assert.equal(result.status, 'queue_drained');
});

test('an unapplied supplement cannot close a previously recorded independent question', async (t) => {
  const { faux, run } = await fixture(t);
  const remaining = '检查服务端状态回收。';
  let feedbackId = '';
  const action = () => ({ kind: 'supplement_task', taskId: 'task-1', note: '检查初始化的影响。', reason: '已有任务可复用。',
    feedbackIds: [feedbackId] });
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(),
    reply(detection({ leads: [{ question: '检查初始化和状态回收。', reason: '状态管理源码相关。', evidenceIds: ['original'] }] })),
    call('run_discover'),
    ({ messages }) => {
      feedbackId = input(messages).newLeads[0].id;
      return reply({ actions: [action()], feedbackOutcomes: [{ feedbackId, status: 'addressed', reason: '已覆盖初始化。',
        remainingQuestions: [remaining] }] });
    },
    () => call('run_discover', { focus: '检查余下的回收问题', feedbackIds: [feedbackId] }),
    () => reply({ actions: [action()], feedbackOutcomes: [{ feedbackId, status: 'addressed', reason: '已处理回收。',
      addressedQuestions: [remaining] }] }),
    ({ messages }) => {
      assert.equal(output(messages, 'run_discover').supplemented, 0);
      return reply({ summary: '原补充任务不涵盖状态回收。' });
    },
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.plans[2].actions.length, 1);
  assert.deepEqual(result.pending.unresolvedFeedback[0].remainingQuestions, [remaining]);
  assert.match(result.pending.unresolvedFeedback[0].reasonUnresolved ?? '', /No linked proposal was applied/);
});

test('selected tasks take turns and different requests can receive the same conclusion', async (t) => {
  const { faux, run } = await fixture(t);
  const firstGap = '状态从哪一层写入？';
  const secondGap = '读路径如何解释状态？';
  let firstId = '';
  let secondId = '';
  const conclusion = '入口将初始化状态写入本地变量。';
  faux.setResponses([
    ...firstPlan(proposal(handler, '创建时写入哪种状态？', { priority: 'high' }),
      proposal(service, '服务层怎样初始化？', { priority: 'normal' })),
    call('run_task_batch', { priority: 'low', module: 'handler.js', goalId: goal.id }),
    ({ messages }) => {
      assert.equal(output(messages, 'run_task_batch').selected, 0);
      return call('run_task_batch', { goalId: goal.id, limit: 2 });
    },
    read(), reply(detection({ candidates: [candidate('状态值有误。')] })),
    read(), reply(decision('needs_evidence', handler, { neededEvidence: [firstGap] })),
    ({ messages }) => {
      assert.equal(input(messages).taskId, 'task-2');
      return read(service);
    },
    reply(detection({ evidence: [evidence(service)] })),
    ({ messages }) => {
      assert.equal(input(messages).taskId, 'task-1');
      firstId = input(messages).previousInvestigation.requests[0].evidenceRequests[0].id;
      return read();
    },
    () => reply(detection({ supplementResults: [{ requestId: firstId, status: 'partial', conclusion,
      uncertainties: ['写入发生在初始化还是延迟更新仍需确认。'], evidenceIds: ['original'] }] })),
    read(),
    () => reply(decision('needs_evidence', handler, { neededEvidence: [secondGap],
      addressedRequests: [{ requestId: firstId, evidenceIds: ['own'] }] })),
    ({ messages }) => {
      const [request] = input(messages).previousInvestigation.requests[0].evidenceRequests;
      secondId = request.id;
      assert.notEqual(secondId, firstId);
      assert.equal(request.question, secondGap);
      return read(service);
    },
    () => reply(detection({ evidence: [evidence(service)], supplementResults: [{ requestId: secondId, status: 'resolved',
      conclusion: conclusion.replace('。', '！'), evidenceIds: ['original'] }] })),
    read(), read(service),
    () => reply(decision('refuted', service, { addressedRequests: [{ requestId: secondId, evidenceIds: ['own'] }] })),
    ({ messages }) => {
      const batch = output(messages, 'run_task_batch');
      assert.deepEqual(batch.recentInvestigations.map(({ taskId }: { taskId: string }) => taskId),
        ['task-1', 'task-2', 'task-1', 'task-1']);
      assert.equal(batch.validations, 3);
      return reply({ summary: '两项补证分别核验完成。' });
    },
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.tasks[1].status, 'completed');
  assert.equal(result.feedback.find(({ id }) => id === firstId)?.status, 'resolved');
  assert.equal(result.feedback.find(({ id }) => id === secondId)?.status, 'resolved');
  assert.equal(result.pending.unresolvedFeedback.length, 0);
  assert.equal(result.candidates[0].status, 'refuted');
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
  const revisedClaim = '该入口直接写入初始状态。';
  let requestId = '';
  let candidateId = '';
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(),
    reply(detection({ candidates: [first, second] })),
    read(), reply(decision('supported')),
    read(), reply(decision('needs_evidence', handler, { neededEvidence: [gap, '  ' + gap] })),
    ({ messages }) => {
      const task = input(messages);
      assert.equal(task.taskId, 'task-1');
      const [requested] = task.previousInvestigation.requests;
      ({ candidateId } = requested);
      requestId = requested.evidenceRequests[0].id;
      assert.deepEqual(requested.evidenceRequests, [{ id: requestId, question: gap }]);
      assert.equal(requested.claim, second.claim);
      assert.equal(requested.rule, second.rule);
      assert.equal(task.previousInvestigation.summary, first.claim);
      assert.equal(task.previousInvestigation.evidence[0].source.path, handler.path);
      return read();
    },
    () => reply(detection({ candidates: [{ ...second, claim: revisedClaim, priorCandidateId: candidateId }],
      supplementResults: [{ requestId, status: 'resolved', conclusion: '入口写入常量，服务读取该值且无额外默认值。', evidenceIds: ['original'] }] })),
    ({ messages }) => {
      assert.equal(input(messages).claim, revisedClaim);
      assert.equal(input(messages).supplements[0].requestId, requestId);
      assert.equal(input(messages).supplements[0].evidence[0].source.path, handler.path);
      return read();
    },
    () => reply(decision('refuted', handler, { addressedRequests: [{ requestId, evidenceIds: ['own'] }] })),
    reply({ summary: '补证完成。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].attempts.length, 2);
  assert.equal(result.tasks[0].attempts[1].validations.length, 1);
  assert.deepEqual(result.findings.map(({ claim }) => claim), [first.claim]);
  assert.deepEqual(result.candidates.map(({ status }) => status), ['supported', 'refuted']);
  assert.equal(result.candidates[1].candidateId, candidateId);
  assert.equal(result.candidates[1].claim, revisedClaim);
  assert.deepEqual(result.feedback.map(({ kind, status }) => [kind, status]), [['verification_gap', 'resolved']]);
  assert.equal(result.pending.discoverReady, false);
});

test('unrelated evidence and a repeated candidate leave the original request unresolved', async (t) => {
  const { faux, run } = await fixture(t);
  const unresolved = candidate('服务入口状态值有误。');
  const gap = '定位服务层初始值。';
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(), reply(detection({ candidates: [unresolved] })),
    read(), reply(decision('needs_evidence', handler, { neededEvidence: [gap] })),
    read(), read(service), reply(detection({ evidence: [evidence(), evidence(service, 'unrelated')],
      candidates: [candidate(unresolved.claim, ['original', 'unrelated'])] })),
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
  assert.match(result.feedback[0].reasonUnresolved ?? '', /no grounded answer/);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].claim, unresolved.claim);
  assert.equal(result.pending.unresolvedFeedback[0].candidateId, result.candidates[0].candidateId);
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
  assert.equal(result.readJobs[0].resolution, 'unresolved');
  assert.equal(result.pending.unresolvedReads[0].id, 'read-1');
  assert.equal(result.status, 'work_remaining');
  assert.equal(result.repositoryReads[0].requestId, 'read-1');
});

test('Validator routes independent leads and coverage gaps to planning, and repository questions to Main', async (t) => {
  const { faux, run } = await fixture(t);
  const repositoryQuestion = '服务层在哪边信任入口的身份？';
  const lead = { question: '其他创建入口是否应用同一限制？', reason: '代码显示独立入口。', evidenceIds: ['own'] };
  let contextId = '';
  let coverageId = '';
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
      contextId = context.id;
      return call('run_repository', { focus: ['创建服务'], feedbackIds: [context.id] });
    },
    ({ messages }) => {
      assert.equal(input(messages).goal, repositoryQuestion);
      assert.deepEqual(input(messages).focus, ['创建服务']);
      assert.deepEqual(input(messages).questions, [{ id: contextId, question: repositoryQuestion }]);
      return read();
    },
    () => reply({ summary: '服务概览', records: [{ kind: 'module', subject: '创建服务',
      description: '定义创建路径。', basis: 'observed', evidence: [handler] }], unresolved: [],
      answers: [{ requestId: contextId, status: 'answered', summary: '身份来自服务端。', evidence: [service] }] }),
    ({ messages }) => {
      assert.equal(output(messages, 'run_repository').answers[0].status, 'unresolved');
      return call('run_repository', { focus: ['身份来源'], feedbackIds: [contextId] });
    },
    read(service),
    () => reply({ summary: '补读服务实现。', records: [], unresolved: [],
      answers: [{ requestId: contextId, status: 'answered', summary: '服务入口从已读实现取得身份。', evidence: [service] }] }),
    call('run_discover'),
    ({ messages }) => {
      assert.equal(input(messages).newLeads[0].question, lead.question);
      assert.deepEqual(input(messages).relevantFeedback.map(({ kind }: { kind: string }) => kind), ['coverage_gap']);
      coverageId = input(messages).relevantFeedback[0].id;
      return read();
    },
    () => reply({ actions: [], feedbackOutcomes: [{ feedbackId: coverageId,
      status: 'not_applicable', reason: '此目标没有后台创建入口。', evidence: [handler] }] }),
    reply({ summary: '已分流线索并补读仓库。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.plans[1].planning.repositoryRecordIds, ['module:创建服务']);
  assert.equal(result.plans[1].planning.feedbackIds.length, 2);
  assert.equal(result.feedback.find(({ id }) => id === contextId)?.status, 'resolved');
  assert.equal(result.feedback.find(({ kind }) => kind === 'coverage_gap')?.status, 'not_applicable');
  assert.equal(result.pending.pendingTasks.length, 0);
  assert.equal(result.pending.unresolvedFeedback[0].kind, 'discovery_lead');
});

test('an answered blocking Repository question returns to the original Detection task once', async (t) => {
  const { faux, run } = await fixture(t);
  const question = '默认状态由哪一层提供？';
  const answer = '服务定义了记录的默认状态。';
  let requestId = '';
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(),
    reply(detection({ assessment: { status: 'blocked', summary: '缺少创建服务的位置。' },
      leads: [{ kind: 'repository_context', blocking: true, question, reason: '初始化取决于服务层。', evidenceIds: ['original'] }] })),
    ({ messages }) => {
      requestId = output(messages, 'run_task_batch').state.strategySignals[0].id;
      return call('run_repository', { feedbackIds: [requestId] });
    },
    read(),
    () => reply({ summary: '找到调用侧。', records: [], unresolved: [],
      answers: [{ requestId, status: 'partial', summary: '只确认了调用入口。', evidence: [handler] }] }),
    ({ messages }) => {
      assert.equal(output(messages, 'run_repository').answers[0].status, 'unresolved');
      return call('run_task_batch');
    },
    ({ messages }) => {
      assert.equal(output(messages, 'run_task_batch').investigations, 0);
      return call('run_repository', { feedbackIds: [requestId], focus: ['创建服务'] });
    },
    read(service),
    () => reply({ summary: '找到定义。', records: [], unresolved: [],
      answers: [{ requestId, status: 'answered', summary: answer, evidence: [service] }] }),
    call('run_task_batch'),
    ({ messages }) => {
      const task = input(messages);
      const [context] = task.repositoryContext;
      assert.equal(task.taskId, 'task-1');
      assert.equal(context.requestId, requestId);
      assert.equal(context.answer, answer);
      assert.equal(context.evidence[0].path, service.path);
      assert.match(context.evidence[0].sha256, /^[a-f0-9]{64}$/);
      return read(service);
    },
    reply(detection({ evidence: [evidence(service)] })),
    call('run_task_batch'),
    ({ messages }) => {
      assert.equal(output(messages, 'run_task_batch').investigations, 0);
      return reply({ summary: '补读使原任务得以完成。' });
    },
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.feedback[0].status, 'resolved');
  assert.equal(result.tasks[0].starts, 2);
  assert.equal(result.status, 'queue_drained');
});

test('a Validator Repository answer resumes its candidate and independent supplement candidates survive', async (t) => {
  const { faux, run } = await fixture(t);
  const confirmed = candidate('入口初始化写入异常值。');
  const pending = candidate('服务的默认值未经确认。');
  const newClaim = '重新初始化时未保留原状态。';
  const unlinkedClaim = '取消操作也覆盖记录状态。';
  const question = '创建服务的默认值在哪里定义？';
  let contextId = '';
  let requestId = '';
  let candidateId = '';
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(), reply(detection({ candidates: [confirmed, pending] })),
    read(), reply(decision('supported')),
    read(), reply(decision('needs_evidence', handler, { neededEvidence: [question], leads: [
      { kind: 'repository_context', blocking: true, question, reason: '无法确定服务入口。', evidenceIds: ['own'] },
    ] })),
    ({ messages }) => {
      contextId = output(messages, 'run_task_batch').state.strategySignals[0].id;
      return call('run_repository', { feedbackIds: [contextId] });
    },
    read(service),
    () => reply({ summary: '定位服务。', records: [], unresolved: [],
      answers: [{ requestId: contextId, status: 'answered', summary: '服务自己的声明规定了默认值。', evidence: [service] }] }),
    call('run_task_batch'),
    ({ messages }) => {
      const task = input(messages);
      const [request] = task.previousInvestigation.requests;
      candidateId = request.candidateId;
      requestId = request.evidenceRequests[0].id;
      assert.equal(request.evidenceRequests.length, 1);
      assert.equal(task.repositoryContext[0].candidateId, candidateId);
      assert.equal(task.repositoryContext[0].requestId, contextId);
      return read(service);
    },
    () => reply(detection({ evidence: [evidence(service)], candidates: [
      candidate(newClaim), { ...candidate(unlinkedClaim), priorCandidateId: 'task-1-candidate-1' },
    ], supplementResults: [{ requestId, status: 'resolved', conclusion: '服务声明直接指定了默认值。', evidenceIds: ['original'] }] })),
    read(), read(service),
    () => reply(decision('refuted', service, { addressedRequests: [{ requestId, evidenceIds: ['own'] }] })),
    ({ messages }) => {
      assert.equal(input(messages).claim, newClaim);
      return read(service);
    },
    reply(decision('supported', service)),
    ({ messages }) => {
      assert.equal(input(messages).claim, unlinkedClaim);
      return read(service);
    },
    reply(decision('refuted', service)),
    reply({ summary: '补证和附带的新候选均已独立验证。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.tasks[0].attempts[1].validations.length, 3);
  assert.deepEqual(result.candidates.map(({ claim, status }) => [claim, status]),
    [[confirmed.claim, 'supported'], [pending.claim, 'refuted'], [newClaim, 'supported'], [unlinkedClaim, 'refuted']]);
  assert.equal(result.candidates[1].candidateId, candidateId);
  assert.equal(result.tasks[0].attempts[1].candidateLinkIssues?.[0].priorCandidateId, 'task-1-candidate-1');
  assert.match(result.tasks[0].attempts[1].candidateLinkIssues?.[0].reason ?? '', /active supplement request/);
});

test('same source range does not cover a different security question', async (t) => {
  const { faux, run } = await fixture(t);
  faux.setResponses([
    ...firstPlan(proposal(handler, '初始记录归属哪个账户？', { expectedEvidence: ['确认创建时的账户归属。'] })),
    call('run_task_batch'), read(), reply(detection({ leads: [
      { question: '调用端是否能修改只读字段？', reason: '同一入口也处理字段更新。', evidenceIds: ['original'] },
    ] })),
    call('run_discover'),
    ({ messages }) => reply({ actions: [], feedbackOutcomes: [{ feedbackId: input(messages).newLeads[0].id,
      status: 'covered', reason: '已有任务包含这行源码。', taskIds: ['task-1'] }] }),
    reply({ summary: '字段权限仍需检查。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.pending.unresolvedFeedback.length, 1);
  assert.match(result.pending.unresolvedFeedback[0].reasonUnresolved ?? '', /same security question/);
});

for (const scenario of ['fresh evidence', 'repeat', 'separate open question'] as const) {
  test('a repeated request preserves its ID and uses request-scoped progress: ' + scenario, async (t) => {
    const { faux, run } = await fixture(t);
    const question = '创建服务是否读取显式默认值？';
    const otherQuestion = '更新流程的状态约定是什么？';
    const conclusion = '服务读取调用者指定的默认值。';
    const answerSource = scenario === 'repeat' ? handler : service;
    let requestId = '';
    faux.setResponses([
      ...firstPlan(proposal()),
      call('run_task_batch'), read(),
      reply(detection({ candidates: [candidate('创建时未使用预期默认状态。')],
        checks: [{ index: 1, status: 'unresolved', note: question, evidenceIds: ['original'] }],
        unresolved: scenario === 'separate open question' ? [otherQuestion] : [] })),
      read(), reply(decision('needs_evidence', handler, { neededEvidence: [question] })),
      ({ messages }) => {
        requestId = input(messages).previousInvestigation.requests[0].evidenceRequests[0].id;
        return read();
      },
      () => reply(detection({ supplementResults: [{ requestId, status: 'resolved', conclusion, evidenceIds: ['original'] }] })),
      read(), read(service),
      reply(decision('needs_evidence', handler, { neededEvidence: [question], evidence: [evidence(service, 'direction')],
        requestEvidence: [{ question, evidenceIds: ['direction'] }] })),
      ({ messages }) => {
        const [request] = input(messages).previousInvestigation.requests[0].evidenceRequests;
        assert.equal(request.id, requestId);
        assert.equal(request.evidence[0].path, service.path);
        assert.equal(request.previous[0].verification, 'unresolved');
        return read(answerSource);
      },
      () => reply(detection({ evidence: [evidence(answerSource)], supplementResults: [
        { requestId, status: 'resolved', conclusion, evidenceIds: ['original'] },
      ] })),
      ...(scenario === 'repeat' ? [] : [
        read(), read(service),
        () => reply(decision('refuted', service, { addressedRequests: [{ requestId, evidenceIds: ['own'] }] })),
      ]),
      reply({ summary: '按请求记录补证进展。' }),
    ]);
    const result = await run();
    assert.equal(result.error, null);
    assert.equal(result.tasks[0].attempts.length, 3);
    assert.equal(result.feedback.length, 1);
    assert.equal(result.feedback[0].id, requestId);
    assert.equal(result.feedback[0].supplementHistory?.length, 2);
    assert.ok(result.tasks[0].attempts[0].detection.unresolved.includes(question));
    if (scenario === 'repeat') {
      assert.equal(result.tasks[0].attempts[2].validations.length, 0);
      assert.match(result.feedback[0].reasonUnresolved ?? '', /already been reviewed/);
      assert.equal(result.coverage[0].status, 'needs_evidence');
    } else {
      assert.equal(result.feedback[0].status, 'resolved');
      assert.equal(result.feedback[0].supplementHistory?.[1].verification, 'verified');
      assert.equal(result.coverage[0].status, scenario === 'fresh evidence' ? 'evaluated' : 'needs_evidence');
      if (scenario === 'separate open question') assert.ok(result.tasks[0].attempts[0].detection.unresolved.includes(otherQuestion));
    }
  });
}

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

test('Validator keeps a supplement open when the independent citation does not address it', async (t) => {
  const { faux, run } = await fixture(t);
  const gap = '查明服务配置的取值。';
  let requestId = '';
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(), reply(detection({ candidates: [candidate('状态值有误。')] })),
    read(), reply(decision('needs_evidence', handler, { neededEvidence: [gap] })),
    ({ messages }) => {
      requestId = input(messages).previousInvestigation.requests[0].evidenceRequests[0].id;
      return read(service);
    },
    () => reply(detection({ evidence: [evidence(service)],
      supplementResults: [{ requestId, status: 'resolved', conclusion: '服务使用代码中定义的默认值。', evidenceIds: ['original'] }] })),
    read(),
    () => reply(decision('supported', handler, { addressedRequests: [{ requestId, evidenceIds: ['own'] }] })),
    reply({ summary: '补证结论仍待独立核验。' }),
  ]);
  const result = await run();
  assert.equal(result.error, null);
  assert.equal(result.tasks[0].attempts[1].validations[0].verdict, 'needs_evidence');
  assert.equal(result.pending.unresolvedFeedback[0].id, requestId);
  assert.equal(result.feedback.length, 1);
  assert.deepEqual(result.findings, []);
});

test('cancelling a later candidate review preserves the first confirmed finding', async (t) => {
  const { faux, run } = await fixture(t);
  const controller = new AbortController();
  faux.setResponses([
    ...firstPlan(proposal()),
    call('run_task_batch'), read(),
    reply(detection({ candidates: [candidate('状态值有误。'), candidate('初始化遗漏。')] })),
    read(), reply(decision('supported')),
    () => {
      controller.abort(new Error('Cancelled during independent review.'));
      return read();
    },
  ]);
  const result = await run({ signal: controller.signal });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.stopReason, 'cancelled');
  assert.deepEqual(result.findings.map(({ claim }) => claim), ['状态值有误。']);
  assert.equal(result.pending.pendingValidations.length, 1);
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
