import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message } from '@earendil-works/pi-ai';
import { detectTask } from '../src/agents/detection.ts';
import { discoverTasks } from '../src/agents/discover.ts';
import { readRepository } from '../src/agents/reader.ts';
import { validateCandidate } from '../src/agents/validator.ts';
import { repositoryRecordId } from '../src/repository/map.ts';
import { Repository } from '../src/repository/repository.ts';

const call = (name: string, params: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, params)], { stopReason: 'toolUse' });
const reply = (value: object) => fauxAssistantMessage([fauxText(JSON.stringify(value))]);

function toolData(messages: Message[], name: string) {
  const message = messages.findLast((item) => item.role === 'toolResult' && item.toolName === name);
  assert.ok(message?.role === 'toolResult' && !message.isError);
  const block = message.content.find((item) => item.type === 'text');
  assert.ok(block);
  return JSON.parse(block.text);
}

test('Reader, Discover, Detection and Validator can navigate a shared indexed snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'indexed-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function write(path: string, text: string) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  const entryPath = 'cloudfunctions/order/index.js';
  const implementationPath = 'cloudfunctions/order/service.js';
  await Promise.all([
    write(entryPath, 'const service = require("./service");\nexports.main = () => service.newRecord();\n'),
    write(implementationPath, 'exports.newRecord = () => ({ state: "draft" });\n'),
    write('cloudfunctions/other/index.js', 'exports.main = () => ({ state: "ready" });\n'),
    write('examples/duplicate.js', 'export function newRecord() { return {}; }\n'),
  ]);

  const repository = await Repository.open(root);
  const index = await repository.index;
  const entry = [...index.entries.values()].find(({ filePath }) => filePath === entryPath)!;
  const other = [...index.entries.values()].find(({ filePath }) => filePath === 'cloudfunctions/other/index.js')!;
  const symbol = index.symbolsByFile.get(implementationPath)?.[0];
  assert.ok(entry.symbolId && symbol);
  assert.equal(await Repository.open(root, repository), repository);

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const evidence = { path: entryPath, startLine: 2, endLine: 2 };
  const mapRecord = { kind: 'entry', subject: '订单创建入口', description: '委托创建订单记录', basis: 'observed',
    anchor: { kind: 'entry', id: entry.id }, evidence: [evidence] };

  faux.setResponses([
    ({ messages }) => {
      const message = messages.find((item) => item.role === 'user');
      assert.ok(message?.role === 'user');
      const content = typeof message.content === 'string' ? message.content
        : message.content.find((item) => item.type === 'text')?.text;
      assert.ok(content);
      assert.equal(JSON.parse(content).indexSummary.totalEntries, 2);
      return call('get_file_symbols', { filePath: entryPath });
    },
    ({ messages }) => {
      assert.equal(toolData(messages, 'get_file_symbols').items[0].id, entry.symbolId);
      return call('get_symbol_code', { symbolId: entry.symbolId! });
    },
    call('query_entries', { analysisStatus: 'partial' }),
    ({ messages }) => {
      assert.deepEqual(toolData(messages, 'query_entries').items.map(({ id }: { id: string }) => id), [entry.id]);
      return reply({ summary: '订单与其他云函数。', records: [
        mapRecord, { ...mapRecord, subject: '新建订单', anchor: { kind: 'symbol', id: entry.symbolId } },
      ], unresolved: [] });
    },
  ]);
  const reading = await readRepository({ root, repository, goal: '理解订单入口' }, models, model);
  assert.equal(reading.map.summary, '订单与其他云函数。');
  assert.equal(reading.indexSummary.totalEntries, 2);
  assert.equal(reading.map.records.length, 1);
  assert.equal(reading.map.records[0].subject, '新建订单');
  assert.deepEqual(reading.map.records[0].anchor, mapRecord.anchor);
  const targetId = repositoryRecordId(reading.map.records[0]);
  assert.equal(repositoryRecordId({ ...reading.map.records[0], subject: '另一标题' }), targetId);

  await write('added-after-index.js', 'function hasNewIndex() {}');
  const goals = [{ id: 'state', title: '检查初始状态', description: '核对记录的默认状态。' }];
  faux.setResponses([
    call('query_entries', { analysisStatus: 'unread' }),
    ({ messages }) => {
      assert.deepEqual(toolData(messages, 'query_entries').items.map(({ id }: { id: string }) => id), [other.id]);
      return call('query_entries', { entryId: entry.id });
    },
    ({ messages }) => {
      assert.equal(toolData(messages, 'query_entries').items[0].analysisStatus, 'summarized');
      return call('search_symbols', { name: 'hasNewIndex', match: 'exact' });
    },
    ({ messages }) => {
      assert.equal(toolData(messages, 'search_symbols').total, 0);
      return reply({ actions: [{ kind: 'create_task', targetId, goalId: 'state',
        question: '订单进入何种状态？', expectedEvidence: ['读取默认状态的实现'], reason: '检查创建服务的返回值' }] });
    },
  ]);
  const plan = await discoverTasks({ repository, map: reading.map, state: { goals } }, models, model);
  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0];
  assert.equal(action.kind, 'create_task');
  if (action.kind !== 'create_task') throw new Error('Expected a Detection task.');

  const serviceRange = { path: implementationPath, startLine: 1, endLine: 1 };
  faux.setResponses([
    call('read_lines', { path: entryPath, startLine: 1, endLine: 2 }),
    call('search_symbols', { name: 'newRecord', match: 'exact' }),
    ({ messages }) => {
      const definitions = toolData(messages, 'search_symbols').items as { id: string; filePath: string }[];
      assert.equal(definitions.length, 2);
      return call('get_symbol_code', { symbolId: definitions.find(({ filePath }) => filePath === implementationPath)!.id });
    },
    reply({ assessment: { status: 'suspected_violation', summary: '检查订单是否须默认进入待处理状态。' },
      evidence: [{ id: 'initial', source: serviceRange, observation: '当前代码以 draft 作为初始状态。' }],
      checks: [{ index: 1, status: 'addressed', note: '已阅读默认状态的实现。', evidenceIds: ['initial'] }],
      candidates: [{ claim: '实际状态与传入要求不同。', rule: '初始状态应为 pending。', evidenceIds: ['initial'] }],
      leads: [], unresolved: [] }),
  ]);
  const detection = await detectTask({ root, repository, map: reading.map, task: action }, models, model);
  assert.equal(detection.checks[0].status, 'addressed');
  assert.equal(detection.evidence[0].source.sha256, index.files.get(implementationPath)?.contentHash);
  assert.deepEqual(detection.run.toolCalls, ['read_lines', 'search_symbols', 'get_symbol_code']);

  faux.setResponses([
    call('get_symbol_code', { symbolId: symbol.id }),
    reply({ verdict: 'supported', summary: '源码中的默认值为 draft，文档规则要求 pending。', scope: '创建服务源码',
      evidence: [{ id: 'own', source: serviceRange, observation: '默认值为 draft。' }],
      decisionEvidenceIds: ['own'], ruleIds: ['state-default'] }),
  ]);
  const validation = await validateCandidate({ root, repository, map: reading.map, detection,
    context: { rules: [{ id: 'state-default', rule: '初始状态应为 pending。', source: '产品规范',
      provenance: 'documented' }] } }, models, model);
  assert.equal(validation.verdict, 'supported');
  assert.deepEqual(validation.run?.toolCalls, ['get_symbol_code']);
});
