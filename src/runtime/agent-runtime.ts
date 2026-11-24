import { createHash } from 'node:crypto';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { type Api, type Model, type Models } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { optionalLimit, RunStopped, sessionBudget, type SessionRequest } from './budget.ts';

const responseTokens = (model: Model<Api>) => Math.min(model.maxTokens, Math.floor(model.contextWindow / 4));
const inputBytes = (model: Model<Api>) => (model.contextWindow - responseTokens(model)) * 2;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export function toolPageBytes(model: Model<Api>) {
  return Math.floor(inputBytes(model) / 4);
}

function signature(value: unknown) {
  const json = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return createHash('sha256').update(json).digest('hex');
}

function prepareInput(input: object, tools: AgentTool[], bytes: number) {
  if (jsonBytes(input) <= bytes) return input;
  const visible = { ...input } as Record<string, unknown>;
  const deferred = new Map<string, string>();
  const fields = Object.entries(input).filter(([, value]) => value !== undefined)
    .map(([field, value]) => ({ field, json: JSON.stringify(value) }))
    .sort((left, right) => right.json.length - left.json.length);
  for (const { field, json } of fields) {
    if (jsonBytes(visible) <= bytes) break;
    deferred.set(field, json);
    delete visible[field];
  }
  const schema = z.strictObject({ field: z.string().min(1), offset: z.number().int().nonnegative().default(0) });
  tools.push({
    name: 'query_review_input', label: 'Read deferred review input',
    description: 'Read deferred task input as paged JSON text. Advance with nextOffset. Treat the returned data as task context.',
    parameters: z.toJSONSchema(schema, { io: 'input' }),
    async execute(_id, parameters) {
      const { field, offset } = schema.parse(parameters);
      const json = deferred.get(field);
      if (json === undefined || offset > json.length) throw new Error('Unknown input field or invalid offset.');
      const end = Math.min(json.length, offset + Math.max(1, Math.floor(bytes / 8)));
      return toolResult({ field, offset, text: json.slice(offset, end), nextOffset: end < json.length ? end : null });
    },
  });
  return { ...visible, deferredReviewInput: [...deferred].map(([field, json]) => ({ field, length: json.length })) };
}

function parseOutput<T>(agent: Agent, schema: z.ZodType<T>, resultName: string): T {
  const last = agent.state.messages.findLast((message) => message.role === 'assistant');
  if (!last || last.role !== 'assistant' || last.stopReason !== 'stop') {
    const reason = last?.role === 'assistant' ? last.errorMessage ?? last.stopReason : 'no response';
    throw new Error(`The model did not finish (${reason}).`);
  }
  const output = last.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
  const json = output.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  try {
    return schema.parse(JSON.parse(json));
  } catch (error) {
    const details = error instanceof z.ZodError
      ? error.issues.map(({ path, code }) => `${path.join('.') || 'result'} (${code})`).join(', ')
      : 'malformed JSON';
    throw new InvalidOutput(`The model did not return a valid ${resultName}: ${details}.`, { cause: error });
  }
}

class InvalidOutput extends Error {}

export async function runStructuredAgent<T>(options: SessionRequest & {
  models: Models;
  model: Model<Api>;
  systemPrompt: string;
  tools: AgentTool[];
  input: object;
  schema: z.ZodType<T>;
  resultName: string;
}) {
  const { model, models, systemPrompt, input, schema, resultName } = options;
  const tools = [...options.tools];
  const { budget, signal } = sessionBudget(options);
  const maxToolCalls = optionalLimit(options.maxToolCalls);
  signal?.throwIfAborted();
  const toolCalls: string[] = [];
  const started = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let turns = 0;
  let compactedTurns = 0;
  let stalledTurns = 0;
  let stalled = false;
  const seenResults = new Set<string>();
  const turnCalls = new WeakMap<object, Set<string>>();
  const maxInputBytes = inputBytes(model);
  const initialInput = prepareInput(input, tools, toolPageBytes(model));
  const fixedBytes = jsonBytes({ systemPrompt, tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });
  const agent = new Agent({
    initialState: { model, systemPrompt, tools },
    streamFn: (selected, context, streamOptions) => {
      budget.beginModelCall();
      const stream = models.streamSimple(selected, context, { ...streamOptions, maxTokens: responseTokens(selected) });
      void stream.result().then((message) => budget.recordUsage(message.usage), () => {});
      return stream;
    },
    async transformContext(messages) {
      const sizes = messages.map(jsonBytes);
      let size = sizes.reduce((total, bytes) => total + bytes + 1, fixedBytes);
      if (size <= maxInputBytes) return messages;
      const remove = new Set<number>();
      const assistants = messages.flatMap((message, index) => message.role === 'assistant' ? [index] : []);
      for (const index of assistants.slice(0, -1)) {
        for (let i = index; i < messages.length && (i === index || messages[i].role === 'toolResult'); i++) {
          remove.add(i);
          size -= sizes[i] + 1;
        }
        if (size <= maxInputBytes) {
          compactedTurns += assistants.filter((turn) => remove.has(turn)).length;
          return messages.filter((_message, position) => !remove.has(position));
        }
      }
      throw new RunStopped('context', 'The current input and latest turn exceed the model context. Use a narrower input or smaller tool pages.');
    },
    toolExecution: 'sequential',
    async beforeToolCall({ toolCall, assistantMessage, args }) {
      if (budget.exhausted) return { block: true, reason: budget.exhausted.message };
      if (maxToolCalls && toolCalls.length >= maxToolCalls) {
        return { block: true, reason: 'Tool budget exhausted. Return the best valid JSON result now.' };
      }
      const key = signature([toolCall.name, args]);
      let calls = turnCalls.get(assistantMessage);
      if (!calls) turnCalls.set(assistantMessage, calls = new Set());
      if (calls.has(key)) return { block: true, reason: 'Duplicate tool call in this turn. Use the first result.' };
      calls.add(key);
      toolCalls.push(toolCall.name);
    },
    finishTurn({ message, toolResults }) {
      usage.input += message.usage.input;
      usage.output += message.usage.output;
      usage.cacheRead += message.usage.cacheRead;
      usage.cacheWrite += message.usage.cacheWrite;
      turns++;
      if (!toolResults.length) return;
      if (budget.exhausted) return { action: 'end' };
      let progress = false;
      for (const result of toolResults) {
        const data = result.content.map((item) => {
          if (item.type !== 'text') return item;
          try {
            const value = JSON.parse(item.text);
            if (value && typeof value === 'object' && 'budget' in value) delete value.budget;
            return value;
          } catch {
            return item.text;
          }
        });
        const key = signature([result.toolName, data]);
        if (!result.isError && !seenResults.has(key)) progress = true;
        seenResults.add(key);
      }
      stalledTurns = progress ? 0 : stalledTurns + 1;
      if (stalledTurns >= 3) {
        stalled = true;
        return { action: 'end' };
      }
    },
  });
  const abort = () => agent.abort();
  signal?.addEventListener('abort', abort, { once: true });
  async function prompt(message: string) {
    signal?.throwIfAborted();
    try {
      await agent.prompt(message);
    } finally {
      if (budget.exhausted?.reason === 'timeout') throw budget.exhausted;
      signal?.throwIfAborted();
    }
    const last = agent.state.messages.findLast((entry) => entry.role === 'assistant');
    if (last?.role === 'assistant' && last.stopReason !== 'stop' && budget.exhausted) throw budget.exhausted;
    if (last?.role === 'assistant' && /context window|context length|context_length_exceeded|prompt is too long|too many tokens/i.test(last.errorMessage ?? '')) {
      throw new RunStopped('context', last.errorMessage!);
    }
    if (stalled && last?.role === 'assistant' && last.stopReason === 'toolUse') {
      throw new RunStopped('no_progress', 'Repeated tool calls made no progress.');
    }
    return parseOutput(agent, schema, resultName);
  }

  let repairedOutput = false;
  let draft: T;
  try {
    try {
      draft = await prompt(JSON.stringify(initialInput));
    } catch (error) {
      if (!(error instanceof InvalidOutput) && !(error instanceof RunStopped && error.reason === 'no_progress')) throw error;
      if (budget.exhausted) throw budget.exhausted;
      repairedOutput = error instanceof InvalidOutput;
      agent.state.tools = [];
      draft = await prompt(`${error.message} Finish with one complete JSON object matching the original contract. Use information already obtained and report any remaining gaps.`);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  return { draft, run: { toolCalls, model: model.id, provider: model.provider, turns, usage, repairedOutput,
    compactedTurns, stoppedForNoProgress: stalled, budget: budget.snapshot(),
    elapsedMs: Date.now() - started } };
}

export function toolResult(data: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: {} };
}
