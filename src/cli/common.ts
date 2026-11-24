import { readFile, stat, writeFile } from 'node:fs/promises';
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { minimaxCnProvider } from '@earendil-works/pi-ai/providers/minimax-cn';
import { minimaxProvider } from '@earendil-works/pi-ai/providers/minimax';
import { jsonInputByteLimit, type BudgetOptions } from '../runtime/budget.ts';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

export async function loadJson(path: string, label: string): Promise<unknown> {
  const limit = jsonInputByteLimit();
  if (limit && (await stat(path)).size > limit) throw new Error(`${label} input exceeds REPO_READER_MAX_JSON_BYTES (${limit} bytes).`);
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function saveJson(result: object, path?: string) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (path) await writeFile(path, json, { encoding: 'utf8', flag: 'wx' });
  else process.stdout.write(json);
}

export function getRuntime(provider: string, modelId: string) {
  const models = createModels();
  if (provider === 'openai') models.setProvider(openaiProvider());
  else if (provider === 'anthropic') models.setProvider(anthropicProvider());
  else if (provider === 'minimax') models.setProvider(minimaxProvider());
  else if (provider === 'minimax-cn') models.setProvider(minimaxCnProvider());
  else throw new Error('Supported providers are openai, anthropic, minimax, and minimax-cn.');
  const model = models.getModel(provider, modelId);
  if (!model) throw new Error(`Model ${modelId} was not found in the installed Pi catalog for ${provider}.`);
  return { models, model };
}

export function reportCliError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY']) {
    const secret = process.env[name];
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  console.error(message);
  process.exitCode = 1;
}
export const budgetFlags = {
  'max-model-calls': { type: 'string' },
  'max-tokens': { type: 'string' },
  'max-cost-usd': { type: 'string' },
} as const;

export const budgetHelp = `  --max-model-calls <number>  Total model requests across this run.
  --max-tokens <number>       Total provider-reported tokens.
  --max-cost-usd <number>     Total estimated cost in USD.
  Use 0 to disable an explicit budget.`;

export function budgetFromFlags(values: Partial<Record<keyof typeof budgetFlags, string>>): BudgetOptions {
  const budget: BudgetOptions = {};
  if (values['max-model-calls'] !== undefined) budget.maxModelCalls = Number(values['max-model-calls']);
  if (values['max-tokens'] !== undefined) budget.maxTokens = Number(values['max-tokens']);
  if (values['max-cost-usd'] !== undefined) budget.maxCostUsd = Number(values['max-cost-usd']);
  return budget;
}
