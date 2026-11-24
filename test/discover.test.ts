import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { discoverTasks, discoverStateSchema, type DiscoverRequest } from '../src/agents/discover.ts';
import { mapSchema } from '../src/repository/map.ts';

const createPage = 'entry:miniprogram/pages/create/create.js';
const detailPage = 'entry:miniprogram/pages/detail/detail.js';
const cloud = 'module:cloudfunctions/meeting (云函数层)';

async function inputs() {
  const output = JSON.parse(await readFile(new URL('../benchmark-results/minimax-m3-2026-11-22T08-27-29-727Z/meeting.json', import.meta.url), 'utf8'));
  const state = discoverStateSchema.parse(JSON.parse(await readFile(new URL('../examples/discover-state.json', import.meta.url), 'utf8')));
  return { map: mapSchema.parse(output.map), delta: mapSchema.shape.records.parse(output.delta), state };
}

function planner(actions: object[], queries: [string, Parameters<typeof fauxToolCall>[1]][]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    ...queries.map(([name, parameters]) => fauxAssistantMessage([fauxToolCall(name, parameters)], { stopReason: 'toolUse' })),
    fauxAssistantMessage([fauxText(JSON.stringify({ actions }))]),
  ]);
  return (request: DiscoverRequest) => discoverTasks(request, models, faux.getModel());
}

const detailReview = {
  kind: 'create_task', targetId: detailPage, goalId: 'object-access', question: '会议详情读取在哪里校验对象权限？',
  expectedEvidence: ['详情读取入口和服务端授权检查的源码引用'], reason: '详情入口尚未检查对象授权。',
};

test('plans an initial source review using the saved public repository map', async () => {
  const request = await inputs();
  const result = await planner([detailReview, { ...detailReview, relatedRecordIds: [cloud] }], [
    ['query_map', { kind: 'entry', onlyChanged: true }], ['query_tasks', { targetId: detailPage }],
  ])(request);
  assert.equal(result.phase, 'initial');
  assert.deepEqual(result.run.toolCalls, ['query_map', 'query_tasks']);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].kind, 'create_task');
  assert.deepEqual(result.actions[0].evidence.map(({ recordId }) => recordId), [detailPage, cloud]);
  const savedDetail = request.map.records.find((record) => `entry:${record.subject}` === detailPage);
  assert.ok(savedDetail);
  assert.deepEqual(result.actions[0].evidence[0].citations, savedDetail.evidence);
  assert.match(result.discarded[0].reason, /Duplicate/);
});

test('fills a gap, routes new evidence to existing work, and requests a missing repository fact', async () => {
  const request = await inputs();
  const existing = { id: 'create-access', targetId: createPage, goalId: 'object-access', question: '确认创建者身份来源', status: 'in_progress' as const };
  request.state.tasks = [existing];
  request.state.coverage = [
    { targetId: detailPage, goalId: 'object-access', status: 'unplanned' },
    { targetId: createPage, goalId: 'object-access', status: 'in_progress' },
    { targetId: createPage, goalId: 'business-state', status: 'not_applicable' },
  ];
  request.state.feedback = [
    { id: 'identity-gap', kind: 'verification_gap', taskId: existing.id, note: '待查云函数从哪里读取调用者身份。', recordIds: [cloud] },
  ];
  const result = await planner([
    detailReview,
    { ...detailReview, targetId: createPage, question: '补查云函数调用者身份的来源', feedbackIds: ['identity-gap'], relatedRecordIds: [cloud] },
    { kind: 'request_repository_read', targetId: cloud, question: '确认详情页调用在云函数内的分派关系。', reason: '地图缺少分派位置。' },
    { ...detailReview, targetId: 'entry:missing' },
    { ...detailReview, targetId: createPage, goalId: 'business-state' },
    { ...detailReview, feedbackIds: ['identity-gap'] },
  ], [['query_coverage', { gapsOnly: true }], ['query_tasks', {}], ['query_map', { query: 'meeting' }]])(request);

  assert.equal(result.phase, 'incremental');
  assert.deepEqual(result.run.toolCalls, ['query_coverage', 'query_tasks', 'query_map']);
  assert.deepEqual(result.actions.map((action) => action.kind), ['create_task', 'supplement_task', 'request_repository_read']);
  const supplement = result.actions[1];
  assert.equal(supplement.kind, 'supplement_task');
  assert.equal(supplement.taskId, existing.id);
  assert.deepEqual(supplement.feedbackIds, ['identity-gap']);
  assert.deepEqual(result.discarded.map(({ index }) => index), [3, 4, 5]);
  assert.match(result.discarded[2].reason, /not linked/);
  assert.deepEqual(request.state.tasks, [existing]);
});

test('Discover receives source lines only when given the matching repository root', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'discover-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  await writeFile(join(root, 'handler.js'), 'export const handler = 42;\n');
  const { state } = await inputs();
  const map = { version: 1 as const, root, records: [] };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const stream = models.streamSimple.bind(models);
  let received = '';
  models.streamSimple = (model, context, options) => {
    for (const message of context.messages) {
      if (message.role === 'toolResult' && message.toolName === 'read_lines' && !message.isError) {
        received = message.content.find((block) => block.type === 'text')?.text ?? '';
      }
    }
    return stream(model, context, options);
  };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read_lines', { path: 'handler.js', startLine: 1, endLine: 1 })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('{"actions":[]}')]),
  ]);
  await assert.rejects(discoverTasks({ root, map: { ...map, root: `${root}-other` }, state }, models, faux.getModel()), /does not match/);
  const result = await discoverTasks({ root, map, state }, models, faux.getModel());
  assert.deepEqual(result.run.toolCalls, ['read_lines']);
  assert.deepEqual(JSON.parse(received).lines, [{ line: 1, text: 'export const handler = 42;' }]);
});
