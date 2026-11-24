import { parseArgs } from 'node:util';
import { readRepository } from '../agents/reader.ts';
import { mapSchema } from '../repository/map.ts';
import { budgetFlags, budgetFromFlags, budgetHelp, getRuntime, loadJson, reportCliError, saveJson } from './common.ts';

const help = `Usage: npm run --silent read-repo -- --repo <directory> --goal <reading goal> --model <id>

Options:
  --focus <path or symbol>    Optional starting point. Repeatable.
  --map <file>                JSON output from an earlier run, or its map object.
  --out <file>                Save JSON as UTF-8 to a new file instead of stdout.
  --provider <name>           openai, anthropic, minimax, or minimax-cn. Default: openai.
  --max-tool-calls <number>    Tool calls allowed. Default: 30.
  --max-tool-calls <number>   Optional local tool-call ceiling.
  --timeout-ms <number>        Whole-run timeout. Default: 600000; 0 disables it.
  --help                      Show this help.

${budgetHelp}

Provider and model can also be set with REPO_READER_PROVIDER and REPO_READER_MODEL.
The chosen model provider receives relevant source excerpts.`;

async function loadMap(path: string) {
  const json = await loadJson(path, 'Map');
  return mapSchema.parse(json && typeof json === 'object' && 'map' in json ? json.map : json);
}

async function main() {
  const { values } = parseArgs({ options: {
    ...budgetFlags,
    repo: { type: 'string' }, goal: { type: 'string' }, model: { type: 'string' },
    provider: { type: 'string' }, focus: { type: 'string', multiple: true },
    map: { type: 'string' }, out: { type: 'string' }, 'max-tool-calls': { type: 'string' }, 'timeout-ms': { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(help);
    return;
  }
  const provider = values.provider ?? process.env.REPO_READER_PROVIDER ?? 'openai';
  const modelId = values.model ?? process.env.REPO_READER_MODEL;
  if (!values.repo || !values.goal || !modelId) {
    throw new Error('--repo, --goal and a model ID are required. Run with --help for usage.');
  }
  const { models, model } = getRuntime(provider, modelId);
  const result = await readRepository({
    root: values.repo,
    goal: values.goal,
    focus: values.focus,
    previousMap: values.map ? await loadMap(values.map) : undefined,
    maxToolCalls: values['max-tool-calls'] === undefined ? undefined : Number(values['max-tool-calls']),
    budget: budgetFromFlags(values),
    timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
  }, models, model);
  await saveJson(result, values.out);
}

try {
  await main();
} catch (error) {
  reportCliError(error);
}
