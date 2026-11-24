import { posix } from 'node:path';
import { stableId, type EntryHint } from './source-symbols.ts';

export const entryKinds = ['server_entry', 'client_page', 'client_event', 'external_call'] as const;
export const analysisStatuses = ['unread', 'partial', 'summarized'] as const;
export type AnalysisStatus = typeof analysisStatuses[number];
export type EntryPointRecord = {
  id: string;
  name: string;
  kind: typeof entryKinds[number];
  filePath: string;
  sourcePath: string;
  startLine?: number;
  endLine?: number;
  symbolId?: string;
  event?: string;
  detectionSource: 'app_json' | 'cloud_directory' | 'commonjs_export' | 'page_handler'
    | 'wxml_binding' | 'wx_cloud_call' | 'wx_request';
  analysisStatus: AnalysisStatus;
};

type XmlBinding = { name: string; event: string; startLine: number; endLine: number };

export function wxmlBindings(text: string): XmlBinding[] {
  const bindings: XmlBinding[] = [];
  const source = text.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ' '));
  const tagPattern = /<[\w:-]+((?:[^"'<>]|"[^"]*"|'[^']*')*)>/g;
  let offset = 0;
  let line = 1;
  for (const tag of source.matchAll(tagPattern)) {
    const attributesStart = tag.index + tag[0].length - tag[1].length - 1;
    const attributes = tag[1].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g);
    for (const attribute of attributes) {
      const event = attribute[1];
      const name = (attribute[2] ?? attribute[3])?.trim();
      if (!/^(?:capture-)?(?:bind|catch):?[\w.-]+$/.test(event)
        || !name || !/^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u.test(name)) continue;
      const start = attributesStart + attribute.index;
      for (; offset < start; offset++) if (source[offset] === '\n') line++;
      const endLine = line + (attribute[0].match(/\n/g)?.length ?? 0);
      bindings.push({ name, event, startLine: line, endLine });
    }
  }
  return bindings;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function relativeConfigPath(value: unknown) {
  if (typeof value !== 'string') return;
  const path = value.replace(/^\.\//, '').replace(/\/+$/, '');
  if (path && path.split('/').every((part) => part && part !== '.' && part !== '..' && !/[:\\\x00-\x1f]/.test(part))) {
    return path;
  }
}

function inDirectory(path: string, directory: string) {
  return directory === '.' || path.startsWith(directory + '/');
}

export function collectEntryPoints(paths: ReadonlySet<string>, configs: ReadonlyMap<string, unknown>,
  hints: ReadonlyMap<string, EntryHint[]>, wxml: ReadonlyMap<string, XmlBinding[]>) {
  const entries: EntryPointRecord[] = [];
  const occurrences = new Map<string, number>();
  const appRoots = new Set<string>();
  const pageKeys = new Set<string>();
  const cloudRoots = new Set(['cloudfunctions']);
  const cloudExports = new Set<string>();
  const cloudDirectoryFiles = new Map<string, string>();
  const scriptExtensions = ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'mts', 'cts'];

  function add(entry: Omit<EntryPointRecord, 'id' | 'analysisStatus'>, keyParts: unknown[]) {
    const key = JSON.stringify([entry.kind, entry.detectionSource, ...keyParts]);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    entries.push({ ...entry, id: stableId('entry', [key, occurrence]), analysisStatus: 'unread' });
  }

  function addPages(pages: unknown, sourcePath: string, root: string, prefix?: string) {
    if (!Array.isArray(pages)) return;
    for (const value of new Set(pages)) {
      const path = relativeConfigPath(value);
      if (!path) continue;
      const name = prefix ? posix.join(prefix, path) : path;
      const stem = posix.join(root, name);
      const filePath = [...scriptExtensions, 'wxml', 'json'].map((extension) => stem + '.' + extension)
        .find((candidate) => paths.has(candidate)) ?? sourcePath;
      const key = JSON.stringify([sourcePath, name]);
      if (pageKeys.has(key)) continue;
      pageKeys.add(key);
      add({ kind: 'client_page', name, filePath, sourcePath, detectionSource: 'app_json' }, [sourcePath, name]);
    }
  }

  for (const [path, value] of configs) {
    const config = jsonObject(value);
    if (!config) continue;
    const directory = posix.dirname(path);
    if (posix.basename(path) === 'project.config.json') {
      const cloud = relativeConfigPath(config.cloudfunctionRoot);
      cloudRoots.add(posix.join(directory, cloud ?? 'cloudfunctions'));
      continue;
    }
    const packages = config.subPackages ?? config.subpackages;
    if (!Array.isArray(config.pages) && !Array.isArray(packages)) continue;
    appRoots.add(directory);
    cloudRoots.add(posix.join(directory, 'cloudfunctions'));
    addPages(config.pages, path, directory);
    if (Array.isArray(packages)) {
      for (const value of packages) {
        const subpackage = jsonObject(value);
        const prefix = relativeConfigPath(subpackage?.root);
        if (prefix) addPages(subpackage?.pages, path, directory, prefix);
      }
    }
  }

  const orderedCloudRoots = [...cloudRoots].sort((left, right) => right.length - left.length);
  function cloudFunction(path: string) {
    const root = orderedCloudRoots.find((directory) => inDirectory(path, directory));
    if (!root) return;
    const parts = path.slice(root.length + 1).split('/');
    return parts.length > 1 ? posix.join(root, parts[0]) : undefined;
  }

  for (const path of paths) {
    const cloud = cloudFunction(path);
    if (!cloud || posix.dirname(path) !== cloud) continue;
    const file = posix.basename(path);
    if (/^index\.(?:[mc]?[jt]s|[jt]sx)$/.test(file)) cloudDirectoryFiles.set(cloud, path);
    else if (file === 'package.json' && !cloudDirectoryFiles.has(cloud)) cloudDirectoryFiles.set(cloud, path);
  }

  for (const [filePath, fileHints] of hints) {
    const cloud = cloudFunction(filePath);
    const inMiniProgram = [...appRoots].some((root) => inDirectory(filePath, root))
      || paths.has(filePath.replace(/\.[^.]+$/, '.wxml'));
    for (const { kind, name, ...location } of fileHints) {
      const source = { filePath, sourcePath: filePath, ...location };
      if (kind === 'cloud_export' && cloud) {
        cloudExports.add(cloud);
        add({ ...source, kind: 'server_entry', name, detectionSource: 'commonjs_export' }, [filePath, name]);
      } else if (kind === 'page_handler' && inMiniProgram) {
        add({ ...source, kind: 'client_event', name, detectionSource: 'page_handler' }, [filePath, location.symbolId]);
      } else if (kind === 'cloud_call' || kind === 'network_request') {
        add({ ...source, kind: 'external_call', name, detectionSource: kind === 'cloud_call' ? 'wx_cloud_call' : 'wx_request' },
          [filePath, name]);
      }
    }
  }

  for (const [cloud, filePath] of cloudDirectoryFiles) {
    if (!cloudExports.has(cloud)) {
      add({ kind: 'server_entry', name: posix.basename(cloud), filePath, sourcePath: filePath,
        detectionSource: 'cloud_directory' }, [cloud]);
    }
  }

  for (const [filePath, bindings] of wxml) {
    for (const binding of bindings) {
      add({ ...binding, kind: 'client_event', filePath, sourcePath: filePath, detectionSource: 'wxml_binding' },
        [filePath, binding.event, binding.name]);
    }
  }
  return entries;
}
