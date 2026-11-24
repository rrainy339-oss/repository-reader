import { readFile, stat, writeFile } from 'node:fs/promises';
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { minimaxCnProvider } from '@earendil-works/pi-ai/providers/minimax-cn';
import { minimaxProvider } from '@earendil-works/pi-ai/providers/minimax';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

export async function loadJson(path: string, label: string): Promise<unknown> {
  if ((await stat(path)).size > 4 * 1024 * 1024) throw new Error(`${label} input exceeds 4 MiB.`);
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
