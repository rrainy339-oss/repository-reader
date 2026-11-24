import { parseArgs } from 'node:util';
import { validateCandidate, validationContextSchema, validationInputSchema } from '../agents/validator.ts';
import { mapSchema } from '../repository/map.ts';
import { getRuntime, loadJson, reportCliError, saveJson } from './common.ts';

const help = `Usage: npm run --silent validate -- --repo <directory> --detection <result.json> --model <id>

Options:
  --repo <directory>          Source checkout to reread.
  --detection <file>          Detection result with candidates and source fingerprints.
  --candidate-index <number>  1-based index into candidates. Optional for one candidate.
  --map <file>                Optional Repository output or raw map.
  --context <file>            Optional validation rules and provenance.
  --provider <name>           openai, anthropic, minimax, or minimax-cn. Default: openai.
  --out <file>                Write the decision to a new UTF-8 file. Default: stdout.
  --max-tool-calls <number>    Tool call budget. Default: 15.
  --timeout-ms <number>       Review timeout. Default: 120000.
  --help                      Show this help.

Provider and model can also be set with REPO_READER_PROVIDER and REPO_READER_MODEL.
Candidate context and relevant source excerpts are sent to the selected model provider.`;

async function main() {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, detection: { type: 'string' }, 'candidate-index': { type: 'string' }, map: { type: 'string' },
    context: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, out: { type: 'string' },
    'max-tool-calls': { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(help);
    return;
  }
  const modelId = values.model ?? process.env.REPO_READER_MODEL;
  if (!values.repo || !values.detection || !modelId) throw new Error('--repo, --detection, and a model ID are required. Run with --help for usage.');
  const [detectionJson, mapJson, contextJson] = await Promise.all([
    loadJson(values.detection, 'Detection'), values.map ? loadJson(values.map, 'Map') : undefined,
    values.context ? loadJson(values.context, 'Context') : undefined,
  ]);
  const map = mapJson === undefined ? undefined : mapSchema.parse(mapJson && typeof mapJson === 'object' && 'map' in mapJson ? mapJson.map : mapJson);
  const { models, model } = getRuntime(values.provider ?? process.env.REPO_READER_PROVIDER ?? 'openai', modelId);
  const result = await validateCandidate({
    root: values.repo, detection: validationInputSchema.parse(detectionJson), map,
    context: contextJson === undefined ? undefined : validationContextSchema.parse(contextJson),
    candidateIndex: values['candidate-index'] === undefined ? undefined : Number(values['candidate-index']),
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
