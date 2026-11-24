import { parseArgs } from 'node:util';
import { discoverStateSchema, discoverTasks } from '../agents/discover.ts';
import { mapSchema } from '../repository/map.ts';
import { budgetFlags, budgetFromFlags, budgetHelp, getRuntime, loadJson, reportCliError, saveJson } from './common.ts';

const help = `Usage: npm run --silent discover -- [--map <repository JSON>] [--repo <directory>] [--state <planning JSON>] --model <id>

Options:
  --map <file>                Optional Repository CLI output or raw map object. Supply --repo, --map, or both.
  --state <file>              Optional goals, coverage, tasks, and feedback.
  --repo <directory>         Enable source reading and index tools in the repository used for the map.
  --provider <name>           openai, anthropic, minimax, or minimax-cn. Default: openai.
  --out <file>                Write proposals as JSON to a new file. Default: stdout.
  --max-actions <number>      Optional action ceiling for this plan.
  --max-tool-calls <number>    Optional local tool-call ceiling.
  --timeout-ms <number>       Whole-run timeout. Default: 600000; 0 disables it.
  --help                      Show this help.

${budgetHelp}

Provider and model can also be set with REPO_READER_PROVIDER and REPO_READER_MODEL.
Map excerpts, goals, feedback, and any source lines read are sent to the selected model provider.`;

async function main() {
  const { values } = parseArgs({ options: {
    ...budgetFlags,
    map: { type: 'string' }, state: { type: 'string' }, repo: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
    out: { type: 'string' }, 'max-actions': { type: 'string' }, 'max-tool-calls': { type: 'string' },
    'timeout-ms': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(help);
    return;
  }
  const modelId = values.model ?? process.env.REPO_READER_MODEL;
  if ((!values.map && !values.repo) || !modelId) throw new Error('A model and either --repo or --map are required. Run with --help for usage.');
  const { models, model } = getRuntime(values.provider ?? process.env.REPO_READER_PROVIDER ?? 'openai', modelId);
  const [mapJson, stateJson] = await Promise.all([
    values.map ? loadJson(values.map, 'Map') : undefined, values.state ? loadJson(values.state, 'State') : {},
  ]);
  const envelope = mapJson && typeof mapJson === 'object' && 'map' in mapJson ? mapJson : undefined;
  const delta = envelope && 'delta' in envelope ? mapSchema.shape.records.parse(envelope.delta) : undefined;
  const result = await discoverTasks({
    root: values.repo, map: mapJson === undefined ? undefined : mapSchema.parse(envelope ? envelope.map : mapJson),
    delta, state: discoverStateSchema.parse(stateJson),
    maxActions: values['max-actions'] === undefined ? undefined : Number(values['max-actions']),
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
