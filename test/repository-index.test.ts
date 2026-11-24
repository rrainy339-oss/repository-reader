import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Repository, type SourceLines } from '../src/repository/repository.ts';
import { createRepositoryTools, verifyReadRange } from '../src/repository/repository-tools.ts';
import type { EntryPointRecord } from '../src/repository/entry-points.ts';
import type { SymbolRecord } from '../src/repository/source-symbols.ts';

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'repository-index-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'repo');
  await mkdir(root);
  return { root, temporary, async write(path: string, data: string | Buffer) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  } };
}

function navigation(repository: Repository, observed: SourceLines[] = []) {
  const tools = createRepositoryTools(repository, (source) => observed.push(source));
  return async (name: string, input: object) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool);
    const response = await tool.execute('navigation', input);
    const content = response.content[0];
    assert.equal(content.type, 'text');
    return JSON.parse(content.text);
  };
}

test('indexes readable files, records unsupported and failed sources, and keeps exclusions in force', async (t) => {
  const { root, temporary, write } = await fixture(t);
  const healthy = 'function healthy() { return 1; }\n';
  await Promise.all([
    write('src/good.js', healthy),
    write('src/broken.js', 'function broken( {'),
    write('src/other.py', 'def other():\n    pass\n'),
    write('media/binary.dat', Buffer.from([1, 0, 2])),
    write('media/large.txt', Buffer.alloc(512 * 1024 + 1, 65)),
    write('node_modules/example/index.js', healthy),
    write('dist/generated.js', healthy),
    write('vendor/library/index.js', healthy),
    write('.env', 'EXAMPLE=placeholder'),
    writeFile(join(temporary, 'outside.js'), healthy),
  ]);
  await symlink(temporary, join(root, 'link'), 'junction');

  const repository = await Repository.open(root);
  const index = await repository.index;
  assert.deepEqual(index.summary.parseStatuses, { skipped: 2, parsed: 1, failed: 1, unsupported: 1 });
  assert.equal(index.summary.totalFiles, 5);
  assert.deepEqual(index.files.get('src/good.js'), { path: 'src/good.js', language: 'javascript',
    size: Buffer.byteLength(healthy), contentHash: createHash('sha256').update(healthy).digest('hex'), parseStatus: 'parsed' });
  assert.equal(index.files.get('media/binary.dat')?.contentHash, null);
  assert.equal(index.files.get('src/broken.js')?.parseStatus, 'failed');
  assert.equal(index.files.get('src/other.py')?.parseStatus, 'unsupported');
  assert.deepEqual([...index.symbols.values()].map(({ name }) => name), ['healthy']);
  assert.deepEqual((await repository.searchText('broken')).matches.map(({ path }) => path), ['src/broken.js']);
  assert.equal((await repository.readLines('src/other.py', 1, 1)).lines[0].text, 'def other():');
  await assert.rejects(repository.readLines('link/outside.js', 1, 1), /Linked paths/);
  await assert.rejects(repository.readLines('dist/generated.js', 1, 1), /excluded/);
  const call = navigation(repository);
  await assert.rejects(call('get_file_symbols', { filePath: '../outside.js' }), /repository-relative/);
  await assert.rejects(call('search_symbols', { name: 'healthy', filePattern: '../**' }), /repository-relative/);
  const failed = await call('query_files', { scope: 'src', parseStatus: 'failed' });
  assert.deepEqual(failed.items.map((record: { path: string }) => record.path), ['src/broken.js']);
});

test('extracts named JS, TS and TSX definitions with scope, stable IDs and source line ranges', async (t) => {
  const { root, write } = await fixture(t);
  const js = [
    'function outer() {',
    '  function nested() { return 1; }',
    '  if (true) { function nested() { return 2; } }',
    '}',
    'const arrow = () => 1;',
    'const expression = function internal() { return 2; };',
    'class Service {',
    '  run() { return 0; }',
    '}',
    'const config = {',
    '  run() { return 3; },',
    '  nested: { load: () => 4 },',
    '};',
    'exports.main = async () => {',
    '  return outer();',
    '};',
    'consume(() => 1, function namedCallback() { return 0; });',
  ].join('\r');
  await Promise.all([
    write('app.js', js),
    write('other.mjs', 'export function outer() {}\n'),
    write('types.ts', 'export function parse(value: string): number { return +value; }\n'
      + 'export class Model { getValue(): number { return 0; } }\n'),
    write('view.tsx', 'export const Template = () => <span />;\n'),
  ]);
  const repository = await Repository.open(root);
  const index = await repository.index;
  const scripts = index.symbolsByFile.get('app.js')!;
  const symbols = new Map(scripts.map((symbol) => [symbol.qualifiedName, symbol]));
  assert.deepEqual(scripts.map(({ name, kind }) => [name, kind]), [
    ['outer', 'function'], ['nested', 'function'], ['nested', 'function'], ['arrow', 'function'],
    ['expression', 'function'], ['Service', 'class'], ['run', 'method'], ['run', 'method'],
    ['load', 'method'], ['exports.main', 'function'], ['namedCallback', 'function'],
  ]);
  const outer = symbols.get('outer')!;
  const nested = scripts.filter(({ name }) => name === 'nested');
  assert.deepEqual(nested.map(({ parentSymbolId, startLine }) => [parentSymbolId, startLine]), [[outer.id, 2], [outer.id, 3]]);
  assert.notEqual(nested[0].id, nested[1].id);
  assert.equal(symbols.get('Service.run')?.parentSymbolId, symbols.get('Service')?.id);
  assert.equal(symbols.get('config.run')?.startLine, 11);
  assert.equal(symbols.get('config.nested.load')?.startLine, 12);
  const cloud = symbols.get('exports.main')!;
  assert.deepEqual([cloud.startLine, cloud.endLine], [14, 16]);
  assert.deepEqual((await repository.readLines(cloud.filePath, cloud.startLine, cloud.endLine)).lines.map(({ line }) => line),
    [14, 15, 16]);
  assert.deepEqual(index.symbolsByFile.get('types.ts')?.map(({ qualifiedName }) => qualifiedName),
    ['parse', 'Model', 'Model.getValue']);
  assert.equal(index.symbolsByFile.get('view.tsx')?.[0].name, 'Template');
  assert.equal(index.searchSymbols('outer', 'exact').length, 2);
  await write('app.js', '\r' + js);
  const refreshed = await (await Repository.open(root)).index;
  assert.deepEqual(refreshed.symbolsByFile.get('app.js')?.map(({ id }) => id), scripts.map(({ id }) => id));
  assert.deepEqual(refreshed.symbolsByFile.get('app.js')?.map(({ startLine }) => startLine),
    scripts.map(({ startLine }) => startLine + 1));
});

test('discovers WeChat routes, cloud entries, page handlers and call sites as separate static candidates', async (t) => {
  const { root, write } = await fixture(t);
  await Promise.all([
    write('project.config.json', JSON.stringify({ miniprogramRoot: 'app/', cloudfunctionRoot: 'cloud/' })),
    write('app/app.json', JSON.stringify({ pages: ['pages/home', 'pages/missing', '../invalid'],
      subPackages: [{ root: 'sub', pages: ['detail'] }] })),
    write('app/pages/home.js', 'Page({\n  onSave() {\n    wx.cloud.callFunction({ name: "save" });\n'
      + '    wx.request({ url: "https://example.invalid" });\n  },\n  onLoad: () => 0,\n});'),
    write('app/pages/home.wxml', '<!-- <button bindtap="commented" /> -->\n'
      + '<button\n  capture-bind:tap="onSave" catchtouchstart="onLoad"\n  bindtap="{{dynamic}}" data-example=\'bindtap="hidden"\' />'),
    write('app/sub/detail.ts', 'Page({ onLoad() {} });'),
    write('cloud/save/index.js', 'exports.main = async () => ({ ok: true });'),
    write('cloud/unread/package.json', '{"name":"unread"}'),
    write('cloudfunctions/secondary/index.js', 'const main = () => 1;\nmodule.exports.main = main;'),
    write('cloudfunctions/object/index.js', 'schedule(() => { exports.main = () => "nested"; });\n'
      + 'module.exports = { main() { return 2; } };'),
  ]);
  const repository = await Repository.open(root);
  const index = await repository.index;
  const call = navigation(repository);
  const readEntries = async (input: object) => (await call('query_entries', input)).items as EntryPointRecord[];
  const pages = await readEntries({ kind: 'client_page' });
  assert.deepEqual(pages.map(({ name, filePath, sourcePath }) => [name, filePath, sourcePath]), [
    ['pages/home', 'app/pages/home.js', 'app/app.json'],
    ['pages/missing', 'app/app.json', 'app/app.json'],
    ['sub/detail', 'app/sub/detail.ts', 'app/app.json'],
  ]);
  const server = await readEntries({ kind: 'server_entry' });
  assert.equal(server.length, 4);
  const primary = server.find(({ filePath }) => filePath === 'cloud/save/index.js')!;
  assert.equal(primary.name, 'exports.main');
  assert.equal(primary.symbolId, index.symbolsByFile.get(primary.filePath)?.[0].id);
  assert.equal(server.find(({ filePath }) => filePath === 'cloudfunctions/secondary/index.js')?.startLine, 2);
  const objectExport = server.find(({ filePath }) => filePath === 'cloudfunctions/object/index.js');
  assert.equal(objectExport?.name, 'module.exports.main');
  assert.equal(objectExport?.startLine, 2);
  assert.ok(objectExport?.symbolId);
  assert.equal(server.find(({ name }) => name === 'unread')?.detectionSource, 'cloud_directory');
  const events = await readEntries({ kind: 'client_event' });
  assert.ok(events.some(({ name, detectionSource, symbolId }) => name === 'onSave' && detectionSource === 'page_handler' && symbolId));
  assert.deepEqual(events.filter(({ detectionSource }) => detectionSource === 'wxml_binding')
    .map(({ name, event, startLine }) => [name, event, startLine]), [
    ['onSave', 'capture-bind:tap', 3], ['onLoad', 'catchtouchstart', 3],
  ]);
  const external = await readEntries({ kind: 'external_call' });
  assert.deepEqual(external.map(({ name, startLine }) => [name, startLine]), [['wx.cloud.callFunction', 3], ['wx.request', 4]]);
  assert.equal((await readEntries({ analysisStatus: 'unread' })).length, index.entries.size);
});

test('symbol tools page definition matches and register only current, actually returned source', async (t) => {
  const { root, write } = await fixture(t);
  await Promise.all([
    write('cloudfunctions/order/index.js', 'function updateOrder() {\n' + '  // step\n'.repeat(90) + '}\n'),
    write('cloudfunctions/order/helper.js', 'function updateOrder() { return 2; }\n'),
    write('client/index.js', 'function updateOrder() { return 3; }\n'),
    write('client/extra.js', 'function updateOrderLater() { return 4; }\n'),
    ...Array.from({ length: 22 }, (_, index) => write('more/' + index + '.ts', 'function updateOrder() {}')),
  ]);
  const repository = await Repository.open(root);
  const observed: SourceLines[] = [];
  const call = navigation(repository, observed);
  const page = await call('search_symbols', { name: 'updateOrder', match: 'exact' });
  assert.equal(page.items.length, 20);
  assert.equal(page.total, 25);
  const second = await call('search_symbols', { name: 'updateOrder', match: 'exact', offset: page.nextOffset });
  assert.equal(second.items.length, 5);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...page.items, ...second.items].map(({ id }: SymbolRecord) => id)).size, 25);

  const scoped = await call('search_symbols', { name: 'updateOrder', filePattern: 'cloudfunctions/**', kind: 'function' });
  assert.deepEqual(scoped.items.map(({ filePath }: SymbolRecord) => filePath),
    ['cloudfunctions/order/helper.js', 'cloudfunctions/order/index.js']);
  const fuzzy = await call('search_symbols', { name: 'updateorder', scope: 'client' });
  assert.equal(fuzzy.total, 2);
  assert.equal(observed.length, 0);
  const listed = await call('get_file_symbols', { filePath: 'cloudfunctions/order/index.js' });
  const { id } = listed.items[0];
  assert.equal(id, scoped.items[1].id);
  const result = await call('get_symbol_code', { symbolId: id });
  assert.equal(result.lines[0].text, 'function updateOrder() {');
  assert.equal(result.source.endLine, 80);
  assert.equal(result.truncated, true);
  assert.equal(result.nextStartLine, 81);
  assert.deepEqual(await verifyReadRange(repository, observed, result.source), result.source);
  assert.equal(await verifyReadRange(repository, observed, { ...result.source, endLine: 81 }), undefined);
  const tail = await call('get_symbol_code', { symbolId: id, startLine: result.nextStartLine });
  assert.equal(tail.source.endLine, 92);
  assert.equal(tail.nextStartLine, null);
  await assert.rejects(call('get_symbol_code', { symbolId: 'unknown' }), /Unknown symbol ID/);

  await write('cloudfunctions/order/index.js', 'function updateOrder() { return 9; }');
  await assert.rejects(call('get_symbol_code', { symbolId: id }), /indexed source has changed/);
  assert.equal(observed.length, 2);
  assert.equal(await verifyReadRange(repository, observed, result.source), undefined);
  const current = await call('read_lines', { path: result.source.path, startLine: 1, endLine: 1 });
  assert.match(current.lines[0].text, /return 9/);
});

test('full-text search resumes across a match limit and the directory scan budget', async (t) => {
  const { root, write } = await fixture(t);
  await write('matches.txt', 'hit\n'.repeat(35));
  for (let base = 0; base <= 800; base += 50) {
    await Promise.all(Array.from({ length: Math.min(50, 801 - base) }, (_, index) =>
      write('bulk/' + String(base + index).padStart(4, '0') + '.txt', base + index === 800 ? 'last match\n' : 'other\n')));
  }
  const repository = await Repository.open(root);
  const call = navigation(repository);
  const page = await call('search_text', { query: 'hit', scope: 'matches.txt' });
  assert.equal(page.matches.length, 30);
  assert.equal(page.limitReason, 'match_limit');
  assert.deepEqual(page.nextCursor, { path: 'matches.txt', line: 31 });
  const next = await call('search_text', { query: 'hit', scope: 'matches.txt', cursor: page.nextCursor });
  assert.deepEqual(next.matches.map(({ line }: { line: number }) => line), [31, 32, 33, 34, 35]);
  assert.equal(next.truncated, false);
  const budget = await call('search_text', { query: 'last', scope: 'bulk' });
  assert.equal(budget.limitReason, 'scan_budget');
  assert.deepEqual(budget.nextCursor, { path: 'bulk/0800.txt', line: 1 });
  const resumed = await call('search_text', { query: 'last', scope: 'bulk', cursor: budget.nextCursor });
  assert.deepEqual(resumed.matches, [{ path: 'bulk/0800.txt', line: 1, text: 'last match' }]);
  assert.equal(resumed.truncated, false);
});
