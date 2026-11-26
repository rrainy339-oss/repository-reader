import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message } from '@earendil-works/pi-ai';
import { createDetectionKnowledgeTools } from '../src/agents/detection-knowledge.ts';
import { detectTask } from '../src/agents/detection.ts';
import { validationInputSchema } from '../src/agents/validator.ts';

const listName = 'list_detection_knowledge';
const readName = 'read_detection_knowledge';
const untrusted = 'MARKER_FROM_TARGET_REPOSITORY';

function navigate() {
  const tools = new Map(createDetectionKnowledgeTools().map((tool) => [tool.name, tool]));
  return async (name: string, args: object) => {
    const result = await tools.get(name)!.execute('knowledge', args);
    const content = result.content[0];
    assert.equal(content.type, 'text');
    return JSON.parse(content.text);
  };
}

test('catalog lists and pages relevant knowledge by category, language, framework, topic and CWE', async () => {
  const query = navigate();
  const all = await query(listName, { limit: 100 });
  assert.equal(all.items.length, all.total);
  assert.deepEqual(new Set(all.items.map((item: { category: string }) => item.category)),
    new Set(['methodology', 'languages', 'frameworks', 'vulnerabilities']));
  const filtered = await query(listName, { category: 'vulnerabilities', language: 'TypeScript', cwe: 'cwe-89' });
  assert.deepEqual(filtered.items.map((entry: { id: string }) => entry.id), ['sql-injection']);
  const platform = await query(listName, { category: 'frameworks', framework: 'wechat-miniapp', topic: 'session' });
  assert.deepEqual(platform.items.map((entry: { id: string }) => entry.id), ['wechat-miniapp']);
  assert.equal((await query(listName, { query: 'TOCTOU', topic: 'atomicity' })).total, 1);
  const head = await query(listName, { limit: 2 });
  const next = await query(listName, { offset: head.nextOffset, limit: 2 });
  assert.equal(head.nextOffset, 2);
  assert.equal(next.items[0].id, all.items[2].id);
  assert.ok(!('content' in head.items[0]));
});

test('catalog ranks bilingual aliases and accepts CWE numbers in free text and filters', async () => {
  const query = navigate();
  for (const alias of ['BOLA', '对象级授权']) {
    assert.equal((await query(listName, { query: alias })).items[0].id, 'object-authorization');
  }
  for (const cwe of ['CWE‑089', 'cwe 89', '89']) {
    assert.equal((await query(listName, { query: cwe })).items[0].id, 'sql-injection');
    assert.equal((await query(listName, { cwe })).items[0].id, 'sql-injection');
  }
  assert.equal((await query(listName, { query: 'NoSQLi' })).items[0].id, 'nosql-injection');
  assert.ok(!(await query(listName, { query: 'SQL' })).items.some((item: { id: string }) => item.id === 'nosql-injection'));
});

test('catalog ranks matches across multiple terms and keeps rankings through pagination', async () => {
  const query = navigate();
  const params = { query: 'SSRF redirect' };
  const ranked = await query(listName, params);
  assert.equal(ranked.items[0].id, 'ssrf');
  assert.ok(ranked.items.some((item: { id: string }) => item.id === 'open-redirect'));
  const first = await query(listName, { ...params, limit: 1 });
  const second = await query(listName, { ...params, limit: 1, offset: first.nextOffset });
  assert.equal(second.items[0].id, ranked.items[1].id);
  assert.equal((await query(listName, { query: 'IDOR 租户' })).items[0].id, 'object-authorization');
  assert.match((await query(listName, { query: 'zzcatalogunknownword' })).hint, /keywords/);
});

test('catalog includes general guides by default and supports exact platform filters', async () => {
  const query = navigate();
  const filters = { language: 'JavaScript', framework: 'cloudbase', limit: 100 };
  const scoped = await query(listName, filters);
  assert.equal(scoped.items[0].id, 'wechat-cloud-development');
  const ids = scoped.items.map((item: { id: string }) => item.id);
  assert.ok(ids.includes('source-navigation'));
  assert.ok(ids.includes('business-invariants'));
  assert.ok(!ids.includes('express-routing'));
  const strict = await query(listName, { ...filters, includeGeneral: false });
  assert.ok(strict.items.length > 0);
  for (const item of strict.items) {
    assert.ok(item.languages.includes('javascript'));
    assert.ok(item.frameworks.includes('cloudbase'));
  }
});

test('each registered guide resolves and vulnerability guides include controls, evidence and counterexamples', async () => {
  const query = navigate();
  const { items } = await query(listName, { limit: 100 });
  const ids = new Set<string>();
  for (const item of items) {
    assert.ok(!ids.has(item.id));
    ids.add(item.id);
    const result = await query(readName, { id: item.id });
    assert.equal(result.title, item.title);
    assert.equal(result.format, 'markdown');
    assert.match(result.content, /^# /);
    assert.match(result.content, /## References/);
    assert.match(result.content, /\(https:\/\//);
    if (item.category === 'vulnerabilities') {
      assert.match(result.content, /控制/);
      assert.match(result.content, /引用|证据/);
      assert.match(result.content, /反证|误报/);
    }
  }
  await assert.rejects(query(readName, { id: '../SOURCES.md' }), /regex|format|pattern/i);
  await assert.rejects(query(readName, { id: 'sql-injection', path: 'other.md' }), /unrecognized/i);
  await assert.rejects(query(readName, { id: 'sources' }), /Unknown/);
});

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

function toolData(messages: Message[], toolName: string) {
  const result = messages.findLast((entry) => entry.role === 'toolResult' && entry.toolName === toolName);
  assert.ok(result?.role === 'toolResult' && !result.isError);
  const content = result.content.find((item) => item.type === 'text');
  assert.ok(content);
  return JSON.parse(content.text);
}

test('Detection reads optional app guides without treating target knowledge or guide text as source evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'detection-knowledge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guidePath = 'knowledge/detection/vulnerabilities/sql-injection.md';
  await mkdir(join(root, 'knowledge/detection/vulnerabilities'), { recursive: true });
  await writeFile(join(root, guidePath), untrusted + '\n');
  await writeFile(join(root, 'products.js'), 'db.query("SELECT name FROM products WHERE id = $1", [id]);\n');
  const source = { path: 'products.js', startLine: 1, endLine: 1 };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    ({ messages }) => {
      const initial = JSON.stringify(messages);
      assert.match(initial, /list_detection_knowledge/);
      assert.match(initial, /knowledgeDirectory/);
      assert.match(initial, /sql-injection.*useWhen/);
      assert.doesNotMatch(initial, /数据库接收的查询结构|CATALOG_ENDPOINT|MARKER_FROM_TARGET_REPOSITORY/);
      return call(listName, { cwe: 'CWE-89' });
    },
    ({ messages }) => {
      const data = toolData(messages, listName);
      assert.equal(data.items[0].id, 'sql-injection');
      return call(readName, { id: data.items[0].id });
    },
    ({ messages }) => {
      const guide = toolData(messages, readName);
      assert.match(guide.content, /参数绑定/);
      assert.doesNotMatch(guide.content, /MARKER_FROM_TARGET_REPOSITORY/);
      return call('read_lines', source);
    },
    fauxAssistantMessage([fauxText(JSON.stringify({
      assessment: { status: 'no_issue_observed', summary: 'The shown SQL uses driver value binding.' },
      evidence: [{ id: 'current', source, observation: 'The identifier is a bound parameter.' },
        { id: 'guide', source: { ...source, path: guidePath }, observation: 'Guide text is not source read by the agent.' }],
      checks: [{ index: 1, status: 'addressed', note: 'Observed independent parameter binding.', evidenceIds: ['current'] }],
      candidates: [], leads: [], unresolved: [],
    }))]),
  ]);
  const result = await detectTask({ root, task: { targetId: 'products', goalId: 'query-structure',
    question: 'Does the query bind its input as a value?', expectedEvidence: ['Actual driver call.'] } }, models, faux.getModel());
  assert.deepEqual(result.run.toolCalls, [listName, readName, 'read_lines']);
  assert.equal(result.checks[0].status, 'addressed');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].source.path, source.path);
  assert.match(result.evidence[0].source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.unresolved, ['Unverified or ambiguous source reference: guide.']);
  assert.equal(result.assessment.status, 'inconclusive');
  assert.equal(validationInputSchema.parse(result).evidence.length, 1);
});
