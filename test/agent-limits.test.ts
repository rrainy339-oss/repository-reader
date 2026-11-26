import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { readRepository } from '../src/agents/reader.ts';
import { discoverTasks } from '../src/agents/discover.ts';
import { runMain } from '../src/agents/main.ts';
import { Repository } from '../src/repository/repository.ts';
import { runStructuredAgent, toolResult } from '../src/runtime/agent-runtime.ts';
import { RunBudget, RunStopped } from '../src/runtime/budget.ts';

const call = (name: string, arguments_: Parameters<typeof fauxToolCall>[1] = {}) =>
  fauxAssistantMessage([fauxToolCall(name, arguments_)], { stopReason: 'toolUse' });
const reply = (value: object) => fauxAssistantMessage([fauxText(JSON.stringify(value))]);

function provider() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'agent-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

test('Reader can exceed the previous tool-call and map-output ceilings', async (t) => {
  const lines = Array.from({ length: 38 }, (_, index) => ({
    path: 'notes.txt', startLine: index + 1, endLine: index + 1,
  }));
  const root = await fixture(t, { 'notes.txt': lines.map(({ startLine }) => 'Section ' + startLine).join('\n') });
  const { faux, model, models } = provider();
  faux.setResponses([
    ...lines.map((source) => call('read_lines', source)),
    reply({ summary: 'Sections', records: lines.map((source) => ({
      kind: 'module', subject: 'Section ' + source.startLine, description: 'Section notes.', basis: 'observed', evidence: [source],
    })), unresolved: [] }),
  ]);
  const result = await readRepository({ root, goal: 'Read the sections', budget: { timeoutMs: 0 } }, models, model);
  assert.equal(result.run.toolCalls.length, 38);
  assert.equal(result.map.records.length, 38);
  assert.equal(result.run.budget.modelCalls, 39);
});

test('Discover grounds all supported target kinds and accepts more proposals than former caps', async (t) => {
  const path = 'cloudfunctions/work/index.js';
  const root = await fixture(t, {
    [path]: 'exports.main = () => createDraft();\nfunction createDraft() { return "draft"; }\n',
    'unread.js': 'function unrelated() {}',
  });
  const repository = await Repository.open(root);
  const index = await repository.index;
  const entry = [...index.entries.values()].find(({ filePath }) => filePath === path)!;
  const symbol = index.searchSymbols('createDraft', 'exact')[0];
  assert.ok(entry && symbol);
  const first = { path, startLine: 1, endLine: 1 };
  const second = { path, startLine: 2, endLine: 2 };
  const base = { kind: 'create_task', question: 'What is the initial state?', expectedEvidence: ['Read the initializer.'],
    reason: 'Source defines the initial state.' };
  const goal = (label: string) => ({ title: label, description: 'Confirm the documented state for ' + label });
  const fileProposal = { ...base, target: { kind: 'file', source: second }, goal: goal('draft lifecycle') };
  const proposals = [
    { ...base, targetId: entry.id, source: first, goal: goal('entry') },
    { ...base, targetId: symbol.id, source: second, goal: goal('initializer') },
    fileProposal,
    { ...base, target: { kind: 'source', source: second }, goal: goal('return expression') },
    ...Array.from({ length: 30 }, (_, index) => ({
      ...base, target: { kind: 'file', source: second }, goal: goal('Rule ' + index),
    })),
    fileProposal,
    { ...base, target: { kind: 'source', source: { ...second, path: 'unread.js', startLine: 1, endLine: 1 } }, goal: goal('unread') },
    { ...base, target: { kind: 'file', source: { ...second, path: '../outside.js' } }, goal: goal('outside') },
    { ...base, targetId: symbol.id, source: first, goal: goal('wrong declaration') },
  ];
  const { faux, model, models } = provider();
  faux.setResponses([call('read_lines', { path, startLine: 1, endLine: 2 }), reply({ actions: proposals })]);
  const result = await discoverTasks({ repository }, models, model);
  assert.equal(result.actions.length, 34);
  assert.equal(result.goals.length, 34);
  assert.deepEqual(result.actions.slice(0, 4).map((action) => action.kind === 'create_task' && action.target?.kind),
    ['entry', 'symbol', 'file', 'source']);
  assert.ok(result.actions.every((action) => action.evidence[0].citations[0].sha256 === index.files.get(path)?.contentHash));
  assert.deepEqual(result.discarded.map(({ index }) => index), [34, 35, 36, 37]);
  assert.match(result.discarded[0].reason, /Duplicate/);
  assert.match(result.discarded[1].reason, /not fully read/);
  assert.match(result.discarded[2].reason, /repository-relative/);
  assert.match(result.discarded[3].reason, /cover the indexed target/);
});

test('Main carries a new source target and goal into Detection and can validate candidate ten', async (t) => {
  const path = 'record.js';
  const root = await fixture(t, { [path]: 'function createRecord() { return { state: "ready" }; }\n' });
  const source = { path, startLine: 1, endLine: 1 };
  const requirement = 'An initial record state must be draft.';
  const { faux, model, models } = provider();
  faux.setResponses([
    call('run_repository'),
    reply({ summary: 'Record creation.', records: [], unresolved: [] }),
    call('run_discover'),
    call('read_lines', source),
    reply({ actions: [{ kind: 'create_task', target: { kind: 'file', source },
      goal: { title: 'Initial state', description: requirement },
      question: 'What state does the first record use?', expectedEvidence: ['Read initial state.'], reason: 'State is explicit.' }] }),
    call('run_task_batch', { taskIds: ['task-1'] }),
    call('read_lines', source),
    reply({ assessment: { status: 'suspected_violation', summary: 'The implementation uses ready.' },
      evidence: [{ id: 'state', source, observation: 'Initial value uses ready.' }],
      checks: [{ index: 1, status: 'addressed', note: 'Read initialization.', evidenceIds: ['state'] }],
      candidates: Array.from({ length: 10 }, (_, index) => ({
        claim: 'Review initial state ' + (index + 1), rule: requirement, evidenceIds: ['state'],
      })), leads: [], unresolved: [] }),
    ...Array.from({ length: 9 }, () => [call('read_lines', source),
      reply({ verdict: 'refuted', summary: 'The checked concern is refuted.', scope: 'Creation source',
        evidence: [{ id: 'value', source, observation: 'Read the initialization.' }], decisionEvidenceIds: ['value'] })]).flat(),
    call('read_lines', source),
    reply({ verdict: 'supported', summary: 'The source uses ready and the specification requires draft.', scope: 'Creation source',
      evidence: [{ id: 'value', source, observation: 'The initial state is ready.' }], decisionEvidenceIds: ['value'], ruleIds: ['initial'] }),
    reply({ summary: 'Reviewed an unmapped source target.' }),
  ]);
  const result = await runMain({ root, budget: { timeoutMs: 0 },
    context: { rules: [{ id: 'initial', rule: requirement, source: 'Product spec', provenance: 'documented' }] } }, models, model);
  assert.equal(result.error, null);
  assert.deepEqual(result.failures, []);
  assert.equal(result.map?.records.length, 0);
  assert.equal(result.goals.length, 1);
  const [{ action, attempts }] = result.tasks;
  assert.equal(action.target?.kind, 'file');
  assert.equal(action.goalId, result.goals[0].id);
  assert.equal(attempts[0].detection.target?.id, action.targetId);
  assert.equal(attempts[0].detection.candidates.length, 10);
  assert.equal(attempts[0].validations.length, 10);
  assert.equal(attempts[0].validations[9].candidateIndex, 10);
  assert.equal(result.findings.length, 1);
  assert.equal(result.budget.modelCalls, faux.state.callCount);
});

test('the global model request ceiling is shared between Main and its child', async (t) => {
  const root = await fixture(t, { 'notes.txt': 'Description' });
  const { faux, models, model } = provider();
  faux.setResponses([
    call('run_repository'),
    reply({ summary: 'Indexed.', records: [], unresolved: [] }),
    call('run_discover'),
  ]);
  const result = await runMain({ root, budget: { timeoutMs: 0, maxModelCalls: 3 } }, models, model);
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.stopReason, 'model_calls');
  assert.equal(result.budget.modelCalls, 3);
  assert.equal(faux.state.callCount, 3);
  assert.equal(result.subagentCalls, 1);
  assert.ok(result.map);
});

test('token and estimated cost limits block another model request after usage is recorded', () => {
  const tokens = new RunBudget({ budget: { timeoutMs: 0, maxTokens: 50 } });
  tokens.beginModelCall();
  tokens.recordUsage({ totalTokens: 62, cost: { total: 0 } });
  assert.throws(() => tokens.beginModelCall(), (error) => error instanceof RunStopped && error.reason === 'tokens');
  const cost = new RunBudget({ budget: { timeoutMs: 0, maxCostUsd: 0.01 } });
  cost.beginModelCall();
  cost.recordUsage({ totalTokens: 5, cost: { total: 0.011 } });
  assert.throws(() => cost.beginModelCall(), (error) => error instanceof RunStopped && error.reason === 'cost');
});

test('repeated tools with unchanged results trigger tool-free finalization', async () => {
  const { faux, model, models } = provider();
  const tool = {
    name: 'check', label: 'Check', description: 'Return a constant state.',
    parameters: { type: 'object', properties: { attempt: { type: 'integer' } }, required: ['attempt'] },
    async execute() { return toolResult({ state: 'unchanged' }); },
  };
  faux.setResponses([
    ...[1, 2, 3, 4].map((attempt) => call('check', { attempt })),
    ({ messages }) => {
      assert.match(JSON.stringify(messages.at(-1)), /Repeated tool calls made no progress/);
      return reply({ summary: 'Source state unchanged.' });
    },
  ]);
  const result = await runStructuredAgent({ models, model, systemPrompt: 'Summarize source state.', tools: [tool], input: {},
    schema: z.object({ summary: z.string() }), resultName: 'status', budget: { timeoutMs: 0 } });
  assert.equal(result.run.stoppedForNoProgress, true);
  assert.equal(result.run.turns, 5);
});

function deferredText(messages: Message[]) {
  const message = messages.findLast((entry) => entry.role === 'toolResult' && entry.toolName === 'query_review_input');
  assert.ok(message?.role === 'toolResult' && !message.isError);
  const block = message.content.find((item) => item.type === 'text');
  assert.ok(block);
  return JSON.parse(block.text);
}

test('large task context remains page-accessible and old assistant-tool turns compact together', async () => {
  const { faux, models, model } = provider();
  const contextModel = { ...model, contextWindow: 6000, maxTokens: 1200 };
  const tool = {
    name: 'read_part', label: 'Read part', description: 'Return a test part.',
    parameters: { type: 'object', properties: { part: { type: 'integer' } }, required: ['part'] },
    async execute(_id: string, args: unknown) {
      return toolResult({ part: z.object({ part: z.number() }).parse(args).part, text: 'x'.repeat(2200) });
    },
  };
  faux.setResponses([
    call('query_review_input', { field: 'large' }),
    ({ messages }) => {
      const data = deferredText(messages);
      assert.ok(data.text.startsWith('"title:'));
      assert.ok(data.nextOffset > 0);
      return call('read_part', { part: 1 });
    },
    ...[2, 3, 4, 5, 6].map((part) => call('read_part', { part })),
    ({ messages }) => {
      for (const message of messages) {
        if (message.role !== 'toolResult') continue;
        assert.ok(messages.some((candidate) => candidate.role === 'assistant'
          && candidate.content.some((block) => block.type === 'toolCall' && block.id === message.toolCallId)));
      }
      return reply({ summary: 'Compacted complete turns.' });
    },
  ]);
  const result = await runStructuredAgent({ models, model: contextModel, systemPrompt: 'Review the input.', tools: [tool],
    input: { large: 'title:' + 'Z'.repeat(15000), goal: 'Read parts' }, schema: z.object({ summary: z.string() }),
    resultName: 'status', budget: { timeoutMs: 0 } });
  assert.ok(result.run.compactedTurns > 0);
  assert.equal(result.run.toolCalls.length, 7);
});

test('provider context overflow has a specific stop reason', async () => {
  const { faux, models, model } = provider();
  faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Maximum context length exceeded' })]);
  await assert.rejects(runStructuredAgent({ models, model, systemPrompt: 'Read the source.', tools: [],
    input: {}, schema: z.object({ summary: z.string() }), resultName: 'status', budget: { timeoutMs: 0 } }),
  (error) => error instanceof RunStopped && error.reason === 'context');
});
