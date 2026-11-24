import { parseArgs } from 'node:util';
import { detectTask, detectionContextSchema, detectionTaskSchema } from '../agents/detection.ts';
import { mapSchema } from '../repository/map.ts';
import { getRuntime, loadJson, reportCliError, saveJson } from './common.ts';

const help = `Usage: npm run --silent detect -- --repo <directory> --task <task or Discover plan JSON> --model <id>

Options:
  --repo <directory>          Source repository to read.
  --task <file>               A single task, a create_task action, or a Discover result.
  --action-index <number>     1-based index into the Discover result's actions array.
  --map <file>                Optional repository map or Repository output.
  --context <file>            Optional businessRules and followUp notes.
  --provider <name>           openai, anthropic, minimax, or minimax-cn. Default: openai.
  --out <file>                Write the assessment to a new UTF-8 file. Default: stdout.
  --max-tool-calls <number>    Tool call budget. Default: 15.
  --timeout-ms <number>       Review timeout. Default: 120000.
  --help                     Show this help.

Provider and model can also be set with REPO_READER_PROVIDER and REPO_READER_MODEL.
Task context and any source lines read are sent to the selected model provider.`;

function selectTask(input: unknown, actionIndex?: string) {
  if (input && typeof input === 'object' && 'actions' in input && Array.isArray(input.actions)) {
    if (actionIndex !== undefined) {
      const index = Number(actionIndex);
      if (!Number.isSafeInteger(index) || index < 1 || index > input.actions.length) {
        throw new Error('--action-index must be a valid 1-based index into the Discover result.');
      }
      const action = input.actions[index - 1];
      if (action?.kind !== 'create_task') throw new Error('The selected action must be create_task.');
      return detectionTaskSchema.parse(action);
    }
    const created = input.actions.filter((action) => action?.kind === 'create_task');
    if (created.length === 1) return detectionTaskSchema.parse(created[0]);
    throw new Error('Select one create_task action with --action-index.');
  }
  if (actionIndex !== undefined) throw new Error('--action-index requires a Discover result.');
  return detectionTaskSchema.parse(input);
}

async function main() {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, task: { type: 'string' }, 'action-index': { type: 'string' }, map: { type: 'string' },
    context: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, out: { type: 'string' },
    'max-tool-calls': { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(help);
    return;
  }
  const modelId = values.model ?? process.env.REPO_READER_MODEL;
  if (!values.repo || !values.task || !modelId) throw new Error('--repo, --task, and a model ID are required. Run with --help for usage.');
  const [taskJson, mapJson, contextJson] = await Promise.all([
    loadJson(values.task, 'Task'), values.map ? loadJson(values.map, 'Map') : undefined,
    values.context ? loadJson(values.context, 'Context') : undefined,
  ]);
  const task = selectTask(taskJson, values['action-index']);
  const map = mapJson === undefined ? undefined : mapSchema.parse(mapJson && typeof mapJson === 'object' && 'map' in mapJson ? mapJson.map : mapJson);
  const { models, model } = getRuntime(values.provider ?? process.env.REPO_READER_PROVIDER ?? 'openai', modelId);
  const result = await detectTask({
    root: values.repo, task, map, context: contextJson === undefined ? undefined : detectionContextSchema.parse(contextJson),
    maxToolCalls: values['max-tool-calls'] === undefined ? undefined : Number(values['max-tool-calls']),
    timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
  }, models, model);
  await saveJson(result, values.out);
}

try {
  await main();
} catch (error) {
  reportCliError(error);
}
