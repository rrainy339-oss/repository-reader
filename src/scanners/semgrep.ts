import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { normalizePath, type Repository } from '../repository/repository.ts';
import type { RepositoryIndex } from '../repository/repository-index.ts';
import { stableId } from '../repository/source-symbols.ts';
import { toolResult } from '../runtime/agent-runtime.ts';
import { jsonInputByteLimit } from '../runtime/budget.ts';

const ruleSource = 'rules/semgrep/sensitive-operations.yml';
const config = fileURLToPath(new URL('../../' + ruleSource, import.meta.url));
const execute = promisify(execFile);
const semgrepFile = process.platform === 'win32' ? 'semgrep.exe' : 'semgrep';
const line = z.number().int().positive();

const outputSchema = z.object({
  results: z.array(z.unknown()),
  errors: z.array(z.unknown()).default([]),
  paths: z.object({ scanned: z.array(z.string()) }).optional(),
});
const hitSchema = z.object({
  check_id: z.string().min(1), path: z.string().min(1),
  start: z.object({ line, col: line.optional() }), end: z.object({ line, col: line.optional() }),
  extra: z.object({ message: z.string().min(1), severity: z.string().optional(),
    metadata: z.object({ category: z.string().optional() }).optional() }),
});

export type RuleHit = {
  id: string;
  ruleId: string;
  ruleSource: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sha256: string;
  category?: string;
  severity?: string;
  message: string;
  symbolId?: string;
};

type ScanStatus = 'completed' | 'partial' | 'failed' | 'unavailable' | 'disabled' | 'not_applicable' | 'not_requested';
type ScanSource = { sha256: string; totalLines: number };
type ScanSummary = {
  status: ScanStatus;
  eligibleFiles: number;
  stagedFiles: number;
  scannedFiles: number;
  outsideScanScope: number;
  totalHits: number;
  categories: Record<string, number>;
  topPaths: { path: string; hits: number }[];
  errorCount: number;
  reason?: string;
};
export type RuleScan = { summary: ScanSummary; hits: RuleHit[] };
export type RuleScanner = (repository: Repository, signal?: AbortSignal) => Promise<RuleScan>;
type CommandResult = { stdout: string; failed: boolean };
type RunCommand = (executable: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<CommandResult>;

export function emptyRuleScan(status: ScanStatus, reason?: string, eligibleFiles = 0, outsideScanScope = 0): RuleScan {
  return { hits: [], summary: { status, reason, eligibleFiles, outsideScanScope,
    stagedFiles: 0, scannedFiles: 0, totalHits: 0, categories: {}, topPaths: [], errorCount: 0 } };
}

async function findExecutable() {
  const configured = process.env.REPO_READER_SEMGREP_BIN;
  const candidates = configured ? [configured] : (process.env.PATH ?? '').split(delimiter)
    .map((directory) => directory.replace(/^"(.*)"$/, '$1')).filter(isAbsolute)
    .map((directory) => join(directory, semgrepFile));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Keep searching trusted PATH directories. */ }
  }
}

async function runCommand(executable: string, args: string[], cwd: string, signal?: AbortSignal): Promise<CommandResult> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:SEMGREP_|OTEL_|.*_API_KEY$|.*_TOKEN$)/i.test(key)));
  try {
    const { stdout } = await execute(executable, args, {
      cwd, env, signal, encoding: 'utf8', windowsHide: true, maxBuffer: jsonInputByteLimit() ?? Infinity,
    });
    return { stdout, failed: false };
  } catch (error) {
    signal?.throwIfAborted();
    if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' && error.stdout) {
      return { stdout: error.stdout, failed: true };
    }
    throw error;
  }
}

function scopedPath(value: string, stage: string, sources: ReadonlyMap<string, ScanSource>) {
  try {
    const path = normalizePath(isAbsolute(value) ? relative(stage, value) : value);
    return sources.has(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function enclosingSymbol(index: RepositoryIndex, path: string, startLine: number, endLine: number) {
  const matches = (index.symbolsByFile.get(path) ?? []).filter((symbol) =>
    symbol.startLine <= startLine && symbol.endLine >= endLine)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
  const [first, second] = matches;
  if (first && (!second || first.endLine - first.startLine < second.endLine - second.startLine)) return first.id;
}

export function parseSemgrepOutput(stdout: string, stage: string, index: RepositoryIndex,
  sources: ReadonlyMap<string, ScanSource>, eligibleFiles: number, failed: boolean): RuleScan {
  const output = outputSchema.parse(JSON.parse(stdout));
  let invalid = 0;
  const hits = new Map<string, RuleHit>();
  for (const value of output.results) {
    const parsed = hitSchema.safeParse(value);
    const filePath = parsed.success ? scopedPath(parsed.data.path, stage, sources) : undefined;
    if (!parsed.success || !filePath) { invalid++; continue; }
    const { check_id: ruleId, start, end, extra } = parsed.data;
    const { sha256, totalLines } = sources.get(filePath)!;
    const startLine = start.line;
    // Semgrep's end position is exclusive. Column 1 on a later line refers to the prior line's end.
    const endLine = end.line > startLine && end.col === 1 ? end.line - 1 : end.line;
    if (endLine < startLine || endLine > totalLines) { invalid++; continue; }
    const id = stableId('rule-hit', [ruleId, filePath, start.line, start.col, end.line, end.col]);
    hits.set(id, { id, ruleId, ruleSource, filePath, startLine, endLine, sha256, message: extra.message,
      severity: extra.severity, category: extra.metadata?.category, symbolId: enclosingSymbol(index, filePath, startLine, endLine) });
  }
  const scanned = new Set(output.paths?.scanned.map((path) => scopedPath(path, stage, sources)).filter(Boolean));
  const categories = new Map<string, number>();
  const paths = new Map<string, number>();
  for (const { category, filePath } of hits.values()) {
    const key = category ?? 'other';
    categories.set(key, (categories.get(key) ?? 0) + 1);
    const directory = posix.dirname(filePath);
    paths.set(directory, (paths.get(directory) ?? 0) + 1);
  }
  const incomplete = failed || output.errors.length > 0 || invalid > 0 || scanned.size !== eligibleFiles;
  const status = incomplete ? (scanned.size || hits.size ? 'partial' : 'failed') : 'completed';
  return { hits: [...hits.values()], summary: { status, eligibleFiles, stagedFiles: sources.size,
    scannedFiles: scanned.size, outsideScanScope: index.files.size - eligibleFiles, totalHits: hits.size,
    categories: Object.fromEntries(categories), errorCount: output.errors.length + invalid + Number(failed),
    topPaths: [...paths].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([path, hits]) => ({ path, hits })),
    ...(incomplete ? { reason: 'Some source files, matches, or scanner results could not be verified as scanned.' } : {}) } };
}

export function createSemgrepScanner(find = findExecutable, run: RunCommand = runCommand): RuleScanner {
  const scans = new WeakMap<Repository, Promise<RuleScan>>();
  async function scan(repository: Repository, signal?: AbortSignal): Promise<RuleScan> {
    signal?.throwIfAborted();
    const index = await repository.index;
    const files = [...index.files.values()].filter(({ language, contentHash }) =>
      contentHash && (language === 'javascript' || language === 'typescript'));
    const outOfScope = index.files.size - files.length;
    const summary = (status: ScanStatus, reason: string) => emptyRuleScan(status, reason, files.length, outOfScope);
    if (process.env.REPO_READER_SEMGREP === '0') return summary('disabled', 'Disabled by configuration.');
    if (!files.length) return summary('not_applicable', 'No readable indexed JavaScript or TypeScript files.');
    const executable = await find();
    if (!executable) return summary('unavailable', 'Semgrep was not found on PATH or at the configured executable.');
    const parent = await realpath(tmpdir());
    const stage = await mkdtemp(join(parent, 'repository-reader-semgrep-'));
    const sources = new Map<string, ScanSource>();
    try {
      await writeFile(join(stage, '.semgrepignore'), '# Local staging tree already respects the repository boundary.\n');
      for (const file of files) {
        signal?.throwIfAborted();
        try {
          const { bytes, sha256, totalLines } = await repository.readIndexedSource(file.path, signal);
          const path = resolve(stage, normalizePath(file.path));
          const local = relative(stage, path);
          if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) continue;
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, bytes, { flag: 'wx' });
          sources.set(file.path, { sha256, totalLines });
        } catch { signal?.throwIfAborted(); }
      }
      if (!sources.size) return summary('failed', 'No eligible source could be copied from the current index snapshot.');
      const result = await run(executable, ['scan', '--config', config, '--json', '--metrics=off',
        '--disable-version-check', '--no-git-ignore', '--no-rewrite-rule-ids', '--disable-nosem', '--max-target-bytes=0', '.'], stage, signal);
      signal?.throwIfAborted();
      return parseSemgrepOutput(result.stdout, stage, index, sources, files.length, result.failed);
    } catch {
      signal?.throwIfAborted();
      const failed = summary('failed', 'Semgrep failed to run or did not return usable JSON. Continue with source navigation.');
      return { ...failed, summary: { ...failed.summary, stagedFiles: sources.size, errorCount: 1 } };
    } finally {
      const cleanup = await realpath(stage).catch(() => undefined);
      if (cleanup === stage && dirname(cleanup) === parent) await rm(cleanup, { recursive: true, force: true }).catch(() => {});
    }
  }
  return (repository, signal) => {
    signal?.throwIfAborted();
    let result = scans.get(repository);
    if (!result) {
      result = scan(repository, signal).catch((error: unknown) => {
        scans.delete(repository);
        if (signal?.aborted) throw error;
        return emptyRuleScan('failed', 'Unable to prepare or cleanly run the local scanner.');
      });
      scans.set(repository, result);
    }
    return result;
  };
}

export const scanSemgrep = createSemgrepScanner();

export function createRuleHitTool(scan: RuleScan): AgentTool {
  const id = z.string().trim().min(1);
  const schema = z.strictObject({ ruleId: id.optional(), category: id.optional(), filePattern: id.optional(),
    symbolId: id.optional(), cursor: z.string().regex(/^\d+$/).optional(), limit: z.number().int().positive().default(20) });
  return {
    name: 'query_rule_hits', label: 'Query Semgrep source leads',
    description: 'Page through local scan leads; use the same filters with nextCursor. Read the actual source before relying on a hit.',
    parameters: z.toJSONSchema(schema, { io: 'input' }),
    async execute(_id, params) {
      const { ruleId, category, filePattern, symbolId, cursor, limit } = schema.parse(params);
      const offset = z.number().int().nonnegative().parse(Number(cursor ?? 0));
      const pattern = filePattern === undefined ? undefined : normalizePath(filePattern);
      const hits = scan.hits.filter((hit) => (!ruleId || hit.ruleId === ruleId) && (!category || hit.category === category)
        && (!symbolId || hit.symbolId === symbolId) && (!pattern || posix.matchesGlob(hit.filePath, pattern)));
      const next = offset + limit;
      return toolResult({ status: scan.summary.status, total: hits.length, items: hits.slice(offset, next),
        nextCursor: next < hits.length ? String(next) : null });
    },
  };
}
