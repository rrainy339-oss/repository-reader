import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { detectTask, type DetectionRequest } from '../src/agents/detection.ts';
import { discoverTasks } from '../src/agents/discover.ts';
import { Repository } from '../src/repository/repository.ts';

async function fixture(t: TestContext, source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'detection-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  await writeFile(join(root, 'handler.js'), source);
  return root;
}

function provider(draft: object, calls: [string, Parameters<typeof fauxToolCall>[1]][] = []) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    ...calls.map(([name, parameters]) => fauxAssistantMessage([fauxToolCall(name, parameters)], { stopReason: 'toolUse' })),
    fauxAssistantMessage([fauxText(JSON.stringify(draft))]),
  ]);
  return [models, faux.getModel()] as const;
}

const task = {
  taskId: 'access-1', targetId: 'entry:handler', goalId: 'object-access', question: '确认读取操作的对象授权控制。',
  expectedEvidence: ['读取操作之前的权限判断'],
};

test('reports the scoped result when a documented control has current source evidence', async (t) => {
  const root = await fixture(t, 'export function view(viewer, document) {\n  if (viewer.id !== document.ownerId) return null;\n  return document.title;\n}\n');
  const reply = { assessment: { status: 'no_issue_observed', summary: '读取前核对主体与文档所有者。' },
    evidence: [{ id: 'guard', source: { path: 'handler.js', startLine: 2, endLine: 3 }, observation: '所有者判断出现在读取之前。' }],
    checks: [{ index: 1, status: 'addressed', note: '已找到所有者判断。', evidenceIds: ['guard'] }],
    candidates: [], leads: [], unresolved: [] };
  const result = await detectTask({ root, task }, ...provider(reply, [['read_lines', { path: 'handler.js', startLine: 1, endLine: 4 }]]));
  assert.equal(result.taskId, 'access-1');
  assert.equal(result.assessment.status, 'no_issue_observed');
  assert.equal(result.coverageProposal.status, 'evaluated');
  assert.match(result.evidence[0].source.sha256, /^[0-9a-f]{64}$/);
});

test('accepts one Discover action and anchors a source review candidate and related lead', async (t) => {
  const root = await fixture(t, 'export const creationStatus = "active";\n');
  const repository = await Repository.open(root);
  const { path, startLine, endLine, sha256 } = await repository.readLines('handler.js', 1, 1);
  const map = { version: 1 as const, root, records: [{ kind: 'entry' as const, subject: 'handler',
    description: '默认创建状态', basis: 'observed' as const, evidence: [{ path, startLine, endLine, sha256 }] }] };
  const action = { kind: 'create_task', targetId: 'entry:handler', goalId: 'state', question: '创建后的默认状态是否符合产品规则？',
    expectedEvidence: ['默认初始化状态'], reason: '代码包含初始化配置。' };
  const plan = await discoverTasks({ map, state: { goals: [{ id: 'state', title: '创建状态', description: '创建后默认为草稿。' }] } },
    ...provider({ actions: [action] }, [['query_map', { kind: 'entry' }]]));
  const plannedTask = plan.actions[0];
  assert.equal(plannedTask.kind, 'create_task');

  const result = await detectTask({ root, map, task: plannedTask, context: { businessRules: ['创建后默认为草稿。'] } }, ...provider({
    assessment: { status: 'suspected_violation', summary: '默认状态与草稿要求不一致。' },
    evidence: [{ id: 'configured', source: { path: 'handler.js', startLine: 1, endLine: 1 }, observation: '默认状态声明为 active。' }],
    checks: [{ index: 1, status: 'addressed', note: '已找到初始化配置。', evidenceIds: ['configured'] }],
    candidates: [{ claim: '默认状态与文档约束不一致。', rule: '新记录默认为草稿。', evidenceIds: ['configured'] }],
    leads: [{ question: '还有哪些模块引用这个默认值？', reason: '该配置允许跨模块引用。', evidenceIds: ['configured'] }],
    unresolved: [],
  }, [['query_map', { query: 'handler' }], ['search_text', { query: 'creationStatus' }],
    ['read_lines', { path: 'handler.js', startLine: 1, endLine: 1 }]]));
  assert.deepEqual(result.run.toolCalls, ['query_map', 'search_text', 'read_lines']);
  assert.equal(result.assessment.status, 'suspected_violation');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.leads.length, 1);
  assert.equal(result.coverageProposal.status, 'needs_evidence');
});

test('keeps missing server code and unread citations from closing coverage', async (t) => {
  const root = await fixture(t, 'export const serverMethod = "viewDocument";\n');
  const request: DetectionRequest = { root, task };
  const unread = { id: 'guard', source: { path: 'server.js', startLine: 1, endLine: 1 }, observation: '服务端判断。' };
  const result = await detectTask(request, ...provider({ assessment: { status: 'no_issue_observed', summary: '服务端已检查。' },
    evidence: [unread], checks: [{ index: 1, status: 'addressed', note: '已检查。', evidenceIds: ['guard'] }],
    candidates: [{ claim: '待查判断不一致。', rule: '读取前需确认权限。', evidenceIds: ['guard'] }],
    leads: [], unresolved: [],
  }, [['list_files', { directory: '.' }], ['read_lines', { path: 'handler.js', startLine: 1, endLine: 1 }]]));
  assert.equal(result.assessment.status, 'inconclusive');
  assert.equal(result.coverageProposal.status, 'needs_evidence');
  assert.equal(result.checks[0].status, 'unresolved');
  assert.deepEqual(result.candidates, []);
  const blocked = await detectTask(request, ...provider({ assessment: { status: 'blocked', summary: '当前仓库仅有客户端源码。' },
    evidence: [], checks: [], candidates: [], leads: [], unresolved: ['缺少服务端 viewDocument 实现。'],
  }, [['list_files', { directory: '.' }]]));
  assert.equal(blocked.coverageProposal.status, 'blocked');
  assert.ok(blocked.unresolved.includes('缺少服务端 viewDocument 实现。'));
});
