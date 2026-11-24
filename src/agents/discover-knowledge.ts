import { readFile } from 'node:fs/promises';
import type { Repository } from '../repository/repository.ts';

let general: Promise<string> | undefined;
let miniapp: Promise<string> | undefined;

export async function discoverKnowledge(repository?: Repository) {
  general ??= readFile(new URL('../../knowledge/security-goals.md', import.meta.url), 'utf8');
  const index = repository ? await repository.index : undefined;
  const isMiniapp = index && ([...index.entries.values()].some(({ detectionSource }) =>
    ['app_json', 'wxml_binding', 'wx_cloud_call'].includes(detectionSource))
    || [...index.files.values()].some(({ language, parseStatus }) => language === 'wxml' && parseStatus !== 'skipped'));
  const knowledge = [await general];
  if (isMiniapp) {
    miniapp ??= readFile(new URL('../../knowledge/wechat-miniapp.md', import.meta.url), 'utf8');
    knowledge.push(await miniapp);
  }
  return knowledge.join('\n\n');
}
