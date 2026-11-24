import { z } from 'zod';

const count = z.number().int().nonnegative();
const networkTimer = count.max(2_147_483_647);
const budgetSchema = z.object({
  maxModelCalls: count.optional(), maxTokens: count.optional(), maxCostUsd: z.number().nonnegative().optional(),
  timeoutMs: networkTimer.optional(),
});

export type BudgetOptions = z.input<typeof budgetSchema>;
export type BudgetRequest = {
  budget?: BudgetOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
};
export type SessionRequest = BudgetRequest & { runBudget?: RunBudget; maxToolCalls?: number };
export type StopReason = 'timeout' | 'model_calls' | 'tokens' | 'cost' | 'context' | 'no_progress';

export class RunStopped extends Error {
  readonly reason: StopReason;

  constructor(reason: StopReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

function envNumber(name: string) {
  const value = process.env[name]?.trim();
  return value ? Number(value) : undefined;
}

export function optionalLimit(value: number | undefined) {
  return count.optional().parse(value) || undefined;
}

export function sourceFileByteLimit() {
  return count.parse(envNumber('REPO_READER_MAX_FILE_BYTES') ?? 16 * 1024 * 1024) || undefined;
}

export function searchPageByteLimit() {
  return count.parse(envNumber('REPO_READER_SEARCH_PAGE_BYTES') ?? 12 * 1024 * 1024) || undefined;
}

export function jsonInputByteLimit() {
  return count.parse(envNumber('REPO_READER_MAX_JSON_BYTES') ?? 64 * 1024 * 1024) || undefined;
}

export class RunBudget {
  readonly limits: BudgetOptions;
  readonly signal: AbortSignal;
  private readonly deadline?: AbortSignal;
  private modelCalls = 0;
  private tokens = 0;
  private costUsd = 0;

  constructor(request: BudgetRequest = {}) {
    this.limits = budgetSchema.parse({
      maxModelCalls: envNumber('REPO_READER_MAX_MODEL_CALLS'),
      maxTokens: envNumber('REPO_READER_MAX_TOKENS'),
      maxCostUsd: envNumber('REPO_READER_MAX_COST_USD'),
      timeoutMs: request.timeoutMs ?? envNumber('REPO_READER_TIMEOUT_MS') ?? 600_000,
      ...request.budget,
    });
    if (this.limits.timeoutMs) this.deadline = AbortSignal.timeout(this.limits.timeoutMs);
    this.signal = AbortSignal.any([...(request.signal ? [request.signal] : []), ...(this.deadline ? [this.deadline] : [])]);
  }

  snapshot() {
    return { limits: this.limits, modelCalls: this.modelCalls, tokens: this.tokens, costUsd: this.costUsd };
  }

  get exhausted() {
    if (this.deadline?.aborted) return new RunStopped('timeout', 'Audit timed out.');
    if (this.limits.maxModelCalls && this.modelCalls >= this.limits.maxModelCalls) {
      return new RunStopped('model_calls', 'Shared model-call budget exhausted.');
    }
    if (this.limits.maxTokens && this.tokens >= this.limits.maxTokens) {
      return new RunStopped('tokens', 'Shared token budget exhausted.');
    }
    if (this.limits.maxCostUsd && this.costUsd >= this.limits.maxCostUsd) {
      return new RunStopped('cost', 'Shared estimated cost budget exhausted.');
    }
  }

  beginModelCall() {
    const exhausted = this.exhausted;
    if (exhausted) throw exhausted;
    this.signal.throwIfAborted();
    this.modelCalls++;
  }

  recordUsage(usage: { totalTokens: number; cost: { total: number } }) {
    this.tokens += usage.totalTokens;
    this.costUsd += usage.cost.total;
  }
}

export function sessionBudget(request: SessionRequest) {
  const budget = request.runBudget ?? new RunBudget(request);
  const signal = request.signal ? AbortSignal.any([budget.signal, request.signal]) : budget.signal;
  return { budget, signal };
}
