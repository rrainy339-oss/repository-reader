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
  aliases: z.array(text).default([]),
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
  includeGeneral: z.boolean().default(true).describe('Include untagged guides in each selected language or framework.'),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(12),
});
const readInput = z.strictObject({ id: knowledgeId });

function normalize(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\bcwe[\s\p{Pd}]*0*(\d+)\b/gu, 'cwe$1');
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

function words(value: string) {
  const terms = [...segmenter.segment(normalize(value))]
    .filter((part) => part.isWordLike).map((part) => part.segment);
  return terms.map((term) => /^\d+$/.test(term) ? 'cwe' + (term.replace(/^0+(?=\d)/, '')) : term);
}

function hasTag(tags: string[], tag?: string, includeGeneral = false) {
  return tag === undefined || (includeGeneral && tags.length === 0)
    || tags.some((value) => normalize(value) === normalize(tag));
}

function hasCwe(tags: string[], cwe?: string) {
  if (cwe === undefined) return true;
  const id = normalize(/^\d+$/.test(cwe) ? 'CWE-' + cwe : cwe);
  return tags.some((tag) => normalize(tag) === id);
}

function relevance(entry: Entry, queryWords: string[], phrase: string) {
  if (!queryWords.length) return { matched: 0, exact: false, primary: 0 };
  const primary = [entry.id, entry.title, ...entry.aliases, ...entry.cwes];
  const primaryWords = new Set(primary.flatMap(words));
  const otherFields = [entry.summary, entry.useWhen, ...entry.topics, ...entry.languages, ...entry.frameworks];
  const otherWords = new Set(otherFields.flatMap(words));
  const descriptions = [...primary, ...otherFields].map(normalize);
  // Han word boundaries can differ between short queries and full descriptions.
  const matched = queryWords.filter((word) => primaryWords.has(word) || otherWords.has(word)
    || (/^\p{Script=Han}{2,}$/u.test(word) && descriptions.some((field) => field.includes(word))));
  return {
    matched: matched.length,
    exact: primary.some((field) => words(field).join(' ') === phrase),
    primary: matched.filter((word) => primaryWords.has(word)).length,
  };
}

export async function getDetectionKnowledgeDirectory() {
  return [...(await getCatalog()).values()].map(({ id, useWhen }) => ({ id, useWhen }));
}

export function createDetectionKnowledgeTools(): AgentTool[] {
  return [
    {
      name: 'list_detection_knowledge',
      label: 'Find Detection audit guidance',
      description: 'Find audit guides using Chinese or English keywords, aliases, and CWE numbers (e.g. CWE-89). Separate key concepts with spaces. Empty language/framework tags are general and included by default. If no results, use fewer keywords, a known alias, or remove filters. Use nextOffset for more.',
      parameters: z.toJSONSchema(listInput, { io: 'input' }),
      async execute(_id, params, signal) {
        const { query, category, language, framework, topic, cwe, includeGeneral, offset, limit } = listInput.parse(params);
        signal?.throwIfAborted();
        const index = await getCatalog();
        const phrase = words(query ?? '').join(' ');
        const queryWords = phrase ? [...new Set(phrase.split(' '))] : [];
        const items = [...index.values()]
          .filter((entry) => (!category || entry.category === category)
            && hasTag(entry.languages, language, includeGeneral) && hasTag(entry.frameworks, framework, includeGeneral)
            && hasTag(entry.topics, topic) && hasCwe(entry.cwes, cwe))
          .map((entry) => ({
            entry,
            ...relevance(entry, queryWords, phrase),
            specificity: Number(language !== undefined && entry.languages.length > 0)
              + Number(framework !== undefined && entry.frameworks.length > 0),
          }))
          .filter((item) => query === undefined || item.matched > 0)
          .sort((left, right) => Number(right.exact) - Number(left.exact) || right.matched - left.matched
            || right.primary - left.primary || right.specificity - left.specificity);
        const end = offset + limit;
        return toolResult({
          items: items.slice(offset, end).map(({ entry }) => entry),
          total: items.length,
          nextOffset: end < items.length ? end : null,
          ...(items.length === 0 && { hint: 'Try fewer keywords, a known alias/CWE, or remove language, framework, or topic filters.' }),
        });
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
