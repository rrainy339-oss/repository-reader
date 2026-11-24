import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { type Api, type Model, type Models } from '@earendil-works/pi-ai';
import { z } from 'zod';

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
      ? error.issues.slice(0, 6).map(({ path, code }) => `${path.join('.') || 'result'} (${code})`).join(', ')
      : 'malformed JSON';
    throw new InvalidOutput(`The model did not return a valid ${resultName}: ${details}.`, { cause: error });
  }
}

class InvalidOutput extends Error {}

export async function runStructuredAgent<T>(options: {
  models: Models;
  model: Model<Api>;
  systemPrompt: string;
  tools: AgentTool[];
  input: object;
  schema: z.ZodType<T>;
  resultName: string;
  maxToolCalls: number;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  const { model, models, systemPrompt, tools, input, schema, resultName, maxToolCalls, timeoutMs, signal } = options;
  signal?.throwIfAborted();
  const toolCalls: string[] = [];
  const started = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let turns = 0;
  const agent = new Agent({
    initialState: { model, systemPrompt, tools },
    streamFn: models.streamSimple.bind(models),
    toolExecution: 'sequential',
    async beforeToolCall({ toolCall }) {
      if (toolCalls.length >= maxToolCalls) {
        return { block: true, reason: 'Tool budget exhausted. Return the best valid JSON result now.' };
      }
      toolCalls.push(toolCall.name);
    },
    finishTurn({ message }) {
      usage.input += message.usage.input;
      usage.output += message.usage.output;
      usage.cacheRead += message.usage.cacheRead;
      usage.cacheWrite += message.usage.cacheWrite;
      if (++turns >= maxToolCalls + 3) return { action: 'end' };
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, timeoutMs);
  const abort = () => agent.abort();
  signal?.addEventListener('abort', abort, { once: true });
  async function prompt(message: string) {
    signal?.throwIfAborted();
    try {
      await agent.prompt(message);
    } finally {
      if (timedOut) throw new Error('Agent timed out. Try a narrower scope or increase --timeout-ms.');
      signal?.throwIfAborted();
    }
    return parseOutput(agent, schema, resultName);
  }

  let repairedOutput = false;
  let draft: T;
  try {
    try {
      draft = await prompt(JSON.stringify(input));
    } catch (error) {
      if (!(error instanceof InvalidOutput)) throw error;
      repairedOutput = true;
      agent.state.tools = [];
      draft = await prompt(`${error.message} Rewrite only the final answer as one complete JSON object matching the original contract. Use only information already obtained in this session.`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  return { draft, run: { toolCalls, model: model.id, provider: model.provider, turns, usage, repairedOutput,
    elapsedMs: Date.now() - started } };
}

export function toolResult(data: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: {} };
}
