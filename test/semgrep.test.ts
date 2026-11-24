import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Repository } from '../src/repository/repository.ts';
import { createRuleHitTool, createSemgrepScanner, parseSemgrepOutput } from '../src/scanners/semgrep.ts';

const orders = 'src/orders.ts';
const network = 'src/network.js';
const firstRule = 'review.database-operation';
const secondRule = 'review.network-operation';
function rawHit(ruleId: string, path: string, category: string, startLine = 2, endLine = 2) {
  return { check_id: ruleId, path, start: { line: startLine, col: 3 }, end: { line: endLine, col: 18 },
    extra: { message: 'Inspect the operation and its context.', severity: 'INFO', metadata: { category } } };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'semgrep-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    [orders]: 'export function findOrder() {\n  return db.query("orders");\n}\n',
    [network]: 'export function getLocal() {\n  return fetch(localEndpoint);\n}\n',
    'node_modules/ignored/index.js': 'fetch(internalEndpoint);',
    '.semgrep.yml': 'Use a config supplied by the target.',
    '.semgrepignore': 'src/',
    'app.json': '{"pages":["index"]}',
  };
  for (const [file, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), source);
  }
  return { root, repository: await Repository.open(root), files };
}

test('scanner stages only fingerprinted JS/TS, reports coverage and reuses one scan for the shared snapshot', async (t) => {
  const { root, repository, files } = await fixture(t);
  let runs = 0;
  let stagedRoot: string | undefined;
  const scanner = createSemgrepScanner(async () => process.execPath, async (executable, args, cwd) => {
    runs++;
    stagedRoot = cwd;
    assert.equal(executable, process.execPath);
    assert.notEqual(cwd, root);
    assert.match(args[args.indexOf('--config') + 1], /rules[/\\]semgrep[/\\]sensitive-operations\.yml$/);
    assert.equal(args.at(-1), '.');
    assert.ok(args.includes('--metrics=off'));
    assert.ok(args.includes('--disable-version-check'));
    assert.equal(await readFile(join(cwd, orders), 'utf8'), files[orders]);
    assert.equal(await readFile(join(cwd, network), 'utf8'), files[network]);
    await assert.rejects(stat(join(cwd, 'node_modules')));
    await assert.rejects(stat(join(cwd, '.semgrep.yml')));
    await assert.rejects(stat(join(cwd, 'app.json')));
    assert.match(await readFile(join(cwd, '.semgrepignore'), 'utf8'), /Local staging tree/);
    return { failed: false, stdout: JSON.stringify({ paths: { scanned: [orders, join(cwd, network)] }, results: [
      rawHit(firstRule, orders, 'database'),
      rawHit(secondRule, network, 'network'),
    ] }) };
  });
  const [first, second] = await Promise.all([scanner(repository), scanner(repository)]);
  assert.equal(first, second);
  assert.equal(runs, 1);
  assert.equal(first.summary.status, 'completed');
  assert.equal(first.summary.eligibleFiles, 2);
  assert.equal(first.summary.stagedFiles, 2);
  assert.equal(first.summary.scannedFiles, 2);
  assert.deepEqual(first.summary.categories, { database: 1, network: 1 });
  const expected = (await repository.index).files.get(orders)?.contentHash;
  assert.equal(first.hits[0].sha256, expected);
  assert.equal(first.hits[0].symbolId, (await repository.index).searchSymbols('findOrder', 'exact')[0].id);
  await assert.rejects(stat(stagedRoot!));

  const refreshed = await scanner(await Repository.open(root));
  assert.equal(runs, 2);
  assert.deepEqual(refreshed.hits.map(({ id }) => id), first.hits.map(({ id }) => id));
  const tool = createRuleHitTool(first);
  const query = async (params: object) => {
    const result = await tool.execute('q', params);
    const entry = result.content[0];
    assert.equal(entry.type, 'text');
    return JSON.parse(entry.text);
  };
  assert.equal((await query({ filePattern: 'src/*.ts', category: 'database', ruleId: firstRule })).items[0].id, first.hits[0].id);
  assert.equal((await query({ symbolId: first.hits[1].symbolId })).total, 1);
  const page = await query({ limit: 1 });
  assert.equal(page.nextCursor, '1');
  const tail = await query({ cursor: page.nextCursor, limit: 1 });
  assert.equal(tail.items[0].id, first.hits[1].id);
  assert.equal(tail.nextCursor, null);
  await assert.rejects(query({ filePattern: '../**' }), /repository-relative/);
});

test('parser rejects out-of-scope, out-of-range and malformed hits and reports partial coverage', async (t) => {
  const { root, repository } = await fixture(t);
  const index = await repository.index;
  const sources = new Map([[orders, { sha256: index.files.get(orders)!.contentHash!, totalLines: 3 }]]);
  const result = parseSemgrepOutput(JSON.stringify({
    results: [
      rawHit(firstRule, orders, 'database'),
      rawHit(firstRule, '../outside.ts', 'database'),
      rawHit(firstRule, orders, 'database', 4, 99),
      { check_id: firstRule, path: orders },
    ],
    paths: { scanned: [orders, '../outside.ts'] }, errors: [{ type: 'ParseError' }],
  }), root, index, sources, 2, true);
  assert.equal(result.hits.length, 1);
  assert.equal(result.summary.status, 'partial');
  assert.equal(result.summary.scannedFiles, 1);
  assert.equal(result.summary.eligibleFiles, 2);
  assert.equal(result.summary.errorCount, 5);
});

test('missing, failed and zero-hit scans remain distinct', async (t) => {
  const { repository } = await fixture(t);
  const missing = createSemgrepScanner(async () => undefined, async () => assert.fail('should not launch'));
  assert.equal((await missing(repository)).summary.status, 'unavailable');
  const failed = createSemgrepScanner(async () => process.execPath, async () => ({ stdout: 'not JSON', failed: true }));
  assert.equal((await failed(repository)).summary.status, 'failed');
  assert.equal((await failed(repository)).summary.scannedFiles, 0);
  const clean = createSemgrepScanner(async () => process.execPath, async () => ({
    stdout: JSON.stringify({ results: [], paths: { scanned: [orders, network] } }), failed: false,
  }));
  const scan = await clean(repository);
  assert.equal(scan.summary.status, 'completed');
  assert.equal(scan.summary.scannedFiles, 2);
  assert.deepEqual(scan.hits, []);
});

test('files changed after indexing are not copied for the scanner', async (t) => {
  const { root, repository } = await fixture(t);
  await writeFile(join(root, orders), 'export const changed = true;\n');
  const scanner = createSemgrepScanner(async () => process.execPath, async (_bin, _args, cwd) => {
    await assert.rejects(stat(join(cwd, orders)));
    return { stdout: JSON.stringify({ results: [], paths: { scanned: [network] } }), failed: false };
  });
  const result = await scanner(repository);
  assert.equal(result.summary.status, 'partial');
  assert.equal(result.summary.stagedFiles, 1);
  assert.equal(result.summary.eligibleFiles, 2);
});
