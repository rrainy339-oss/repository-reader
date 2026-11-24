import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message } from '@earendil-works/pi-ai';
import { detectTask } from '../src/agents/detection.ts';
import { discoverKnowledge } from '../src/agents/discover-knowledge.ts';
import { discoverTasks } from '../src/agents/discover.ts';
import { Repository } from '../src/repository/repository.ts';
import { createSemgrepScanner } from '../src/scanners/semgrep.ts';

const call = (name: string, params: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, params)], { stopReason: 'toolUse' });
const reply = (value: object) => fauxAssistantMessage([fauxText(JSON.stringify(value))]);
const path = 'cloudfunctions/orders/index.js';
const read = { path, startLine: 1, endLine: 2 };
const objective = 'Review the documented order ownership and state constraints.';
const goal = { title: 'Order access', description: 'Check resource ownership before reading an order.' };
const stateGoal = { title: 'Order state', description: 'Check permitted state transitions on modification.' };
const task = { kind: 'create_task', question: 'Where is the order owner checked?', reason: 'The source identifies an order operation.',
  expectedEvidence: ['Read the service control.'], goal };

async function setup(t: TestContext, sourceFiles: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'discover-phase-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(sourceFiles)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { root, repository: await Repository.open(root), faux, model: faux.getModel(), models };
}

function userInput(messages: Message[]) {
  const message = messages.findLast((entry) => entry.role === 'user');
  assert.ok(message?.role === 'user');
  const content = typeof message.content === 'string' ? message.content
    : message.content.find((block) => block.type === 'text')?.text;
  assert.ok(content);
  return JSON.parse(content);
}

test('loads only project-owned general knowledge and adds domain knowledge when indexed evidence supports it', async (t) => {
  const { repository } = await setup(t, { 'src/plain.js': 'const view = "plain";',
    'knowledge/security-goals.md': 'UNTRUSTED_TARGET_KNOWLEDGE' });
  const general = await discoverKnowledge(repository);
  assert.match(general, /身份认证与身份来源/);
  assert.doesNotMatch(general, /微信小程序源码审查知识|UNTRUSTED_TARGET_KNOWLEDGE/);
  const miniapp = await setup(t, { 'app.json': '{"pages":["orders"]}', 'orders.wxml': '<view />' });
  assert.match(await discoverKnowledge(miniapp.repository), /微信小程序源码审查知识/);
});

test('INITIAL combines queryable rule leads with grounded entries, merges exact repetitions and preserves distinct constraints', async (t) => {
  const { repository, faux, models, model } = await setup(t, { 'app.json': '{"pages":["orders"]}',
    [path]: 'exports.main = (event) => db.collection("orders").doc(event.id).get();\n// order state and owner are business policies' });
  const index = await repository.index;
  const entry = [...index.entries.values()].find((item) => item.filePath === path)!;
  assert.ok(entry);
  let scanCalls = 0;
  const ruleScanner = createSemgrepScanner(async () => process.execPath, async () => {
    scanCalls++;
    return { failed: false, stdout: JSON.stringify({ results: [{
      check_id: 'review.wechat-cloud-data', path, start: { line: 1, col: 26 }, end: { line: 1, col: 66 },
      extra: { message: 'DATABASE_HINT_MARKER', metadata: { category: 'cloud_database' } },
    }], paths: { scanned: [path] } }) };
  });
  const [hit] = (await ruleScanner(repository)).hits;
  const action = { ...task, targetId: entry.id, source: { ...read, endLine: 1 } };
  faux.setResponses([
    ({ messages }) => {
      const input = userInput(messages);
      const system = JSON.stringify(messages.filter((message) => message.role === 'system'));
      assert.equal(input.phase, 'initial');
      assert.equal(input.auditObjective, objective);
      assert.equal(input.ruleHitSummary.totalHits, 1);
      assert.equal(input.indexSummary.totalEntries, 2);
      assert.equal(input.newLeads, undefined);
      assert.match(system, /INITIAL:|INITIAL/);
      assert.match(system, /微信小程序源码审查知识/);
      assert.match(system, /avoid expanding every entry against every goal/);
      assert.doesNotMatch(JSON.stringify(input) + system, /DATABASE_HINT_MARKER/);
      return call('query_rule_hits', { category: 'cloud_database', filePattern: 'cloudfunctions/**' });
    },
    call('read_lines', read),
    reply({ actions: [
      { ...action, discoverySources: [{ kind: 'rule_hit', referenceId: hit.id }] },
      { ...action, goal: { ...goal, id: 'other-spelling' }, discoverySources: ['security_goal', { kind: 'unknown-metadata' },
        { kind: 'rule_hit', referenceId: 'invented-hit' }] },
      { ...action, goal: stateGoal, question: 'Which order state transition is permitted?', discoverySources: ['code_exploration'] },
    ] }),
  ]);
  const plan = await discoverTasks({ repository, auditObjective: objective, phase: 'initial', ruleScanner }, models, model);
  assert.equal(scanCalls, 1);
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.goals.length, 2);
  assert.match(plan.discarded[0].reason, /Duplicate/);
  assert.equal(plan.actions[0].discoveryPhase, 'initial');
  assert.deepEqual(plan.actions[0].discoverySources, [
    { kind: 'rule_hit', referenceId: hit.id }, { kind: 'entry_point', referenceId: entry.id }, { kind: 'security_goal' },
  ]);
  assert.notEqual(plan.actions[0].kind === 'create_task' && plan.actions[0].goalId,
    plan.actions[1].kind === 'create_task' && plan.actions[1].goalId);
  assert.equal(plan.actions[0].evidence[0].citations[0].sha256, hit.sha256);
  assert.deepEqual(plan.referencedRuleHits, [hit]);

  faux.setResponses([call('query_rule_hits', {}), reply({
    actions: [{ ...action, discoverySources: [{ kind: 'rule_hit', referenceId: hit.id }] }],
  })]);
  const unread = await discoverTasks({ repository, ruleScanner }, models, model);
  assert.equal(unread.actions.length, 0);
  assert.match(unread.discarded[0].reason, /not fully read/);
  assert.equal(scanCalls, 1);
});

test('INCREMENTAL keeps new references separate from gaps and handles unavailable scanning', async (t) => {
  const { repository, faux, models, model } = await setup(t, { [path]: 'function lookup() { return store.read(); }\n' });
  const source = { ...read, endLine: 1, sha256: (await repository.index).files.get(path)!.contentHash! };
  const ruleScanner = createSemgrepScanner(async () => undefined);
  const feedback = [
    { id: 'lead', kind: 'discovery_lead' as const, note: 'Read lookup.', evidence: [source, { ...source, path: '../outside.js' }] },
    { id: 'gap', kind: 'verification_gap' as const, note: 'Locate the applicable policy.' },
    { id: 'old', kind: 'discovery_lead' as const, note: 'Already considered.', evidence: [source] },
  ];
  await assert.rejects(discoverTasks({ repository, phase: 'initial', state: { feedback }, ruleScanner }, models, model), /phase/);
  faux.setResponses([
    ({ messages }) => {
      const input = userInput(messages);
      assert.match(JSON.stringify(messages.filter((message) => message.role === 'system')), /INCREMENTAL/);
      assert.equal(input.phase, 'incremental');
      assert.equal(input.focus, 'Shared state policy');
      assert.deepEqual(input.coverageSummary, {});
      assert.equal(input.ruleScanStatus, 'unavailable');
      assert.equal(input.ruleHitSummary, undefined);
      assert.deepEqual(input.newLeads.map((lead: { id: string }) => lead.id), ['lead']);
      assert.deepEqual(input.newLeads[0].evidence, [source]);
      assert.deepEqual(input.relevantFeedback.map((item: { id: string }) => item.id), ['gap']);
      return call('read_lines', { path: input.newLeads[0].evidence[0].path, startLine: 1, endLine: 1 });
    },
    reply({ actions: [{ ...task, target: { kind: 'source', source: { ...read, endLine: 1 } }, feedbackIds: ['lead'] }] }),
  ]);
  const result = await discoverTasks({ repository, ruleScanner, phase: 'incremental', focus: 'Shared state policy',
    state: { feedback }, newFeedbackIds: ['lead', 'gap'] }, models, model);
  assert.equal(result.ruleHitSummary.status, 'unavailable');
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].discoverySources, [{ kind: 'detection_lead', referenceId: 'lead' }]);
  assert.equal(result.actions[0].discoveryPhase, 'incremental');
});

test('Detection resolves lead IDs through verified evidence and withholds mixed invalid references', async (t) => {
  const { repository, faux, models, model } = await setup(t, { [path]: 'const policy = "draft";\nconst state = "active";\n' });
  const source = { ...read, endLine: 1 };
  faux.setResponses([call('read_lines', source), reply({
    assessment: { status: 'inconclusive', summary: 'A policy reference needs further reading.' },
    evidence: [{ id: 'available', source, observation: 'The source declares a policy.' },
      { id: 'unread', source: { ...source, startLine: 2, endLine: 2 }, observation: 'Unread.' }],
    checks: [{ status: 'addressed', index: 1, note: 'The policy is visible.', evidenceIds: ['available'] }],
    candidates: [],
    leads: [{ question: 'Where is the policy used?', reason: 'It is declared locally.', evidenceIds: ['available', 'available'] },
      { question: 'Check a second location', reason: 'Another state may exist.', evidenceIds: ['available', 'unread'] }],
    unresolved: [],
  })]);
  const result = await detectTask({ root: repository.root, repository,
    task: { taskId: 'source-task', targetId: 'known-target', goalId: 'state', question: 'What policy is documented?',
      expectedEvidence: ['Read the policy.'] } }, models, model);
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].sourceTaskId, 'source-task');
  assert.deepEqual(result.leads[0].evidence, [result.evidence[0].source]);
  assert.match(result.leads[0].id, /^lead-[0-9a-f]+$/);
  assert.ok(result.unresolved.some((item) => item.includes('related lead was withheld')));
});

test('a completed zero-hit scan does not prevent source-led planning', async (t) => {
  const { repository, faux, models, model } = await setup(t, { [path]: 'function updateState() { return "draft"; }\n' });
  const ruleScanner = createSemgrepScanner(async () => process.execPath, async () => ({
    failed: false, stdout: JSON.stringify({ results: [], paths: { scanned: [path] } }),
  }));
  const source = { ...read, endLine: 1 };
  faux.setResponses([call('read_lines', source), reply({ actions: [{
    ...task, goal: stateGoal, question: 'Which initial state is used?', target: { kind: 'source', source },
    discoverySources: ['rule_hit'],
  }] })]);
  const result = await discoverTasks({ repository, ruleScanner }, models, model);
  assert.equal(result.ruleHitSummary.status, 'completed');
  assert.equal(result.ruleHitSummary.totalHits, 0);
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].discoverySources, [{ kind: 'code_exploration' }]);
});
