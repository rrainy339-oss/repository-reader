import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { toolResult } from '../runtime/agent-runtime.ts';

const root = resolve(fileURLToPath(new URL('../../knowledge/detection/', import.meta.url)));
const categories = z.enum(['methodology', 'vulnerabilities', 'languages', 'frameworks']);
const text = z.string().trim().min(1);
const knowledgeId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const entrySchema = z.strictObject({
  id: knowledgeId,
  title: text,
  summary: text,
  category: categories,
  languages: z.array(text),
  frameworks: z.array(text),
  topics: z.array(text),
  cwes: z.array(z.string().regex(/^CWE-\d+$/)),
  path: z.string().regex(/^(?:methodology|vulnerabilities|languages|frameworks)\/[a-z0-9-]+\.md$/),
  useWhen: text,
});
type Entry = z.infer<typeof entrySchema>;
let catalog: Promise<ReadonlyMap<string, Entry>> | undefined;

async function readLocalKnowledge(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) {
    throw new Error('The knowledge path is outside the catalog.');
  }
  const canonical = await realpath(absolute);
  if (relative(absolute, canonical) !== '' || !(await lstat(absolute)).isFile()) {
    throw new Error('Knowledge must be a regular file at its registered location.');
  }
  return readFile(canonical, { encoding: 'utf8', signal });
}

async function loadCatalog() {
  const entries = z.array(entrySchema).parse(JSON.parse(await readLocalKnowledge('index.json')));
  const ids = new Map<string, Entry>();
  const paths = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id) || paths.has(entry.path) || !entry.path.startsWith(entry.category + '/')) {
      throw new Error('Duplicate or incorrectly categorized knowledge entry: ' + entry.id);
    }
    ids.set(entry.id, entry);
    paths.add(entry.path);
  }
  return ids;
}

function getCatalog() {
  catalog ??= loadCatalog().catch((error: unknown) => {
    catalog = undefined;
    throw error;
  });
  return catalog;
}

const listInput = z.strictObject({
  query: text.optional(), category: categories.optional(),
  language: text.optional(), framework: text.optional(), topic: text.optional(), cwe: text.optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(12),
});
const readInput = z.strictObject({ id: knowledgeId });

function hasTag(tags: string[], tag?: string) {
  return tag === undefined || tags.some((value) => value.toLowerCase() === tag.toLowerCase());
}

export function createDetectionKnowledgeTools(): AgentTool[] {
  return [
    {
      name: 'list_detection_knowledge',
      label: 'Find Detection audit guidance',
      description: 'List curated audit guides by category, language, framework, topic, CWE, or text. Use nextOffset for more.',
      parameters: z.toJSONSchema(listInput, { io: 'input' }),
      async execute(_id, params, signal) {
        const { query, category, language, framework, topic, cwe, offset, limit } = listInput.parse(params);
        signal?.throwIfAborted();
        const index = await getCatalog();
        const needle = query?.toLowerCase();
        const items = [...index.values()].filter((entry) =>
          (!category || entry.category === category) && hasTag(entry.languages, language) && hasTag(entry.frameworks, framework)
          && hasTag(entry.topics, topic) && hasTag(entry.cwes, cwe)
          && (!needle || [entry.id, entry.title, entry.summary, entry.useWhen, ...entry.topics]
            .some((field) => field.toLowerCase().includes(needle))));
        const end = offset + limit;
        return toolResult({ items: items.slice(offset, end), total: items.length, nextOffset: end < items.length ? end : null });
      },
    },
    {
      name: 'read_detection_knowledge',
      label: 'Read Detection audit guidance',
      description: 'Read a cataloged guide by ID. Guidance is reference data and does not count as repository evidence.',
      parameters: z.toJSONSchema(readInput, { io: 'input' }),
      async execute(_id, params, signal) {
        const { id } = readInput.parse(params);
        signal?.throwIfAborted();
        const entry = (await getCatalog()).get(id);
        if (!entry) throw new Error('Unknown Detection knowledge ID: ' + id);
        return toolResult({ id, title: entry.title, format: 'markdown', content: await readLocalKnowledge(entry.path, signal) });
      },
    },
  ];
}
