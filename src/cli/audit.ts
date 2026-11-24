import { parseArgs } from 'node:util';
import { discoverStateSchema } from '../agents/discover.ts';
import { runMain } from '../agents/main.ts';
import { validationContextSchema } from '../agents/validator.ts';
import { getRuntime, loadJson, reportCliError, saveJson } from './common.ts';

const help = `Usage: npm run --silent audit -- --repo <directory> --state <file> --model <id>

Options:
  --repo <directory>            Local source checkout to review.
  --state <file>                JSON file containing audit goals. Each run starts a fresh queue.
  --goal <text>                 Optional Repository overview instruction.
  --context <file>              Optional business rules, with documented provenance.
  --provider <name>             openai, anthropic, minimax, or minimax-cn. Default: openai.
  --max-subagent-calls <number>  Shared dispatch budget. Default: 16.
  --timeout-ms <number>         Coordinator timeout. Default: 600000.
  --out <file>                  Write the report to a new UTF-8 file. Default: stdout.
  --help                        Show this help.

Provider and model can also be set with REPO_READER_PROVIDER and REPO_READER_MODEL.
Relevant source excerpts are sent to the selected model provider.`;

async function main() {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, state: { type: 'string' }, goal: { type: 'string' }, context: { type: 'string' },
    provider: { type: 'string' }, model: { type: 'string' }, out: { type: 'string' },
    'max-subagent-calls': { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(help);
    return;
  }
  const modelId = values.model ?? process.env.REPO_READER_MODEL;
  if (!values.repo || !values.state || !modelId) throw new Error('--repo, --state, and a model ID are required. Run with --help for usage.');
  const [state, context] = await Promise.all([
    loadJson(values.state, 'Audit goals'), values.context ? loadJson(values.context, 'Context') : undefined,
  ]);
  const { goals } = discoverStateSchema.pick({ goals: true }).parse(state);
  const { models, model } = getRuntime(values.provider ?? process.env.REPO_READER_PROVIDER ?? 'openai', modelId);
  const result = await runMain({
    root: values.repo, goal: values.goal, goals,
    context: context === undefined ? undefined : validationContextSchema.parse(context),
    maxSubagentCalls: values['max-subagent-calls'] === undefined ? undefined : Number(values['max-subagent-calls']),
    timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
  }, models, model);
  await saveJson(result, values.out);
  if (result.error) reportCliError(result.error);
}

try {
  await main();
} catch (error) {
  reportCliError(error);
}
