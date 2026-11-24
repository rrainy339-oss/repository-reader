import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { readRepository } from '../src/agents/reader.ts';
import { Repository } from '../src/repository/repository.ts';

test('Pi reads an overview, then extends it with an independent focused session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'repository-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'app.json'), '{"pages":["pages/orders"]}\n');
  await mkdir(join(root, 'pages'));
  await writeFile(join(root, 'pages', 'orders.js'), 'export function loadOrders() {\n  return []\n}\n');

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const moduleRecord = {
    kind: 'module', subject: 'Orders', description: 'Orders page', basis: 'observed',
    evidence: [{ path: 'app.json', startLine: 1, endLine: 1 }],
  };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('list_files', { directory: '.' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('read_lines', { path: 'app.json', startLine: 1, endLine: 1 })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText(JSON.stringify({ summary: 'Overview', records: [moduleRecord], unresolved: [] }))]),
  ]);
  const overview = await readRepository({ root, goal: 'Overview' }, models, faux.getModel());
  assert.deepEqual(overview.run.toolCalls, ['list_files', 'read_lines']);
  assert.equal(overview.map.records[0].subject, 'Orders');

  const focusedRecord = {
    kind: 'entry', subject: 'loadOrders', description: 'Loads orders', basis: 'observed',
    evidence: [{ path: 'pages/orders.js', startLine: 1, endLine: 3 }],
  };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('search_text', { query: 'loadOrders', scope: 'pages' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('read_lines', { path: 'pages/orders.js', startLine: 1, endLine: 3 })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('This answer is missing the required JSON.')]),
    fauxAssistantMessage([fauxText(JSON.stringify({ summary: 'Focused', records: [focusedRecord, moduleRecord], unresolved: [] }))]),
  ]);
  const focused = await readRepository({ root, goal: 'Explain loadOrders', focus: ['Orders'], previousMap: overview.map }, models, faux.getModel());
  assert.deepEqual(focused.map.records.map((record) => record.subject), ['Orders', 'loadOrders']);
  assert.deepEqual(focused.delta.map((record) => record.subject), ['loadOrders']);
  assert.equal(focused.run.repairedOutput, true);
  assert.match(focused.unresolved[0], /Unverified source/);

  await writeFile(join(root, 'app.json'), '{"pages":[]}\n');
  faux.setResponses([fauxAssistantMessage([fauxText('{"summary":"Review","records":[],"unresolved":[]}')])]);
  const changed = await readRepository({ root, goal: 'Review', previousMap: focused.map }, models, faux.getModel());
  assert.deepEqual(changed.map.records.map((record) => record.subject), ['loadOrders']);
  assert.equal(changed.run.staleRecords, 1);
});

test('read and search do not cross repository boundaries through paths or links', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'repository-scope-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'source');
  const other = join(parent, 'other');
  await mkdir(root);
  await mkdir(other);
  await writeFile(join(root, '.env.local'), 'other-file\n');
  await writeFile(join(other, 'outside.txt'), 'other-file\n');
  await symlink(other, join(root, 'link'), 'junction');
  const repo = await Repository.open(root);
  await assert.rejects(repo.readLines('../other/outside.txt', 1, 1));
  await assert.rejects(repo.readLines('link/outside.txt', 1, 1));
  await assert.rejects(repo.readLines('.env.local', 1, 1));
  assert.deepEqual((await repo.searchText('other-file')).matches, []);
});
