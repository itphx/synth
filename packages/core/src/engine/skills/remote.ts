import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite, type SkillDiagnostic } from '@itphx/synth-shared';
import { TEMPLATE_FILE_MAX_BYTES } from '../commands/template.js';
import { buildUrlSource } from './discovery.js';
import type { SkillSource } from './types.js';
// ADR-046 §4.2: общий SSRF-guard/fetch — вынесен в `engine/net/fetch.ts`,
// чтобы не дублироваться с проектными инструкциями (ADR-069).
import { describeError, fetchText, validateRemoteUrl, type FetchLike } from '../net/fetch.js';

// Обратная совместимость: исторические импорты из `./remote.js` продолжают работать.
export {
  isBlockedHost,
  isBlockedIp,
  validateRemoteUrl,
  type FetchLike,
} from '../net/fetch.js';

/**
 * ADR-046 §4.2/§4.3: read-only индексация удалённых каталогов (`skills.urls`).
 *
 * Скачиваем opencode-совместимый `index.json` + `<base>/<path||name>/SKILL.md`
 * в детерминированный кэш `{cacheDir}/urls/<sha1(url)[:16]>`. Скиллы из кэша
 * имеют `trusted: false` (см. `buildUrlSource`) — они видны в реестре/диагностике,
 * но не попадают в каталог для модели и не грузятся. Установка/доверие/подписи/
 * `lock.json` — PROP-068, здесь не реализуются.
 *
 * Сеть: только `http:`/`https:`; блокируются loopback/private/link-local/ULA,
 * `*.local`/`*.internal` и IPv4-mapped IPv6 (SSRF-guard, проверяются исходный URL
 * и каждый редирект, см. `validateRemoteUrl`). Ошибки не фатальны: отдаются диагностикой, старый кэш
 * не затирается (запись поверх — только при успешной загрузке, tmp→rename).
 */

/** Таймаут одной сетевой операции (index/SKILL.md), мс. */
export const REMOTE_INDEX_TIMEOUT_MS = 5000;
/** Лимит размера `index.json`, байт (~1 MB). */
export const REMOTE_INDEX_MAX_BYTES = 1024 * 1024;
/** Лимит числа записей в `index.json`. */
export const REMOTE_MAX_SKILLS = 200;
/** Лимит одного `SKILL.md`, байт (как `TEMPLATE_FILE_MAX_BYTES`). */
export const REMOTE_FILE_MAX_BYTES = TEMPLATE_FILE_MAX_BYTES;
/** Максимум редиректов при загрузке. */
export const REMOTE_MAX_REDIRECTS = 5;

export interface RefreshRemoteCatalogsOptions {
  /** `config.skills.urls`. */
  urls: readonly string[];
  /** Корень кэша (обычно `{dataDir}/skills-cache`). */
  cacheDir: string;
  /** Подменяемый fetch (тесты). */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxIndexBytes?: number;
  maxSkills?: number;
  maxHops?: number;
}

export interface RefreshRemoteCatalogsResult {
  diagnostics: SkillDiagnostic[];
  /** Источники в том же виде, что строит `buildSkillSources` (пути совпадают). */
  sources: SkillSource[];
}

/** URL индекса: `<url>` как есть, если оканчивается на `.json`, иначе `<url>/index.json`. */
export function resolveRemoteIndexUrl(base: URL): URL {
  if (base.pathname.endsWith('.json')) return base;
  const text = base.toString();
  return new URL('index.json', text.endsWith('/') ? text : `${text}/`);
}

interface RemoteIndexEntry {
  name: string;
  path?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Tolerant-parse `index.json`: массив `{name, description?, path?}` либо
 * `{skills: [...]}`. Невалидные записи пропускаются, не роняя разбор.
 */
export function parseRemoteIndex(text: string): { entries: RemoteIndexEntry[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'index.json: некорректный JSON' };
  }
  let raw: unknown[];
  if (Array.isArray(data)) {
    raw = data;
  } else if (isRecord(data) && Array.isArray(data.skills)) {
    raw = data.skills;
  } else {
    return { error: 'index.json: ожидается массив или { skills: [...] }' };
  }

  const entries: RemoteIndexEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    const path = typeof item.path === 'string' && item.path.trim().length > 0
      ? item.path.trim()
      : undefined;
    entries.push(path ? { name, path } : { name });
  }
  return { entries };
}

/** Безопасное имя каталога кэша (одиночный сегмент без разделителей и `..`). */
export function safeCacheDirName(name: string): string {
  const trimmed = name.trim();
  if (/^[A-Za-z0-9._-]+$/.test(trimmed) && trimmed !== '.' && trimmed !== '..') return trimmed;
  const cleaned = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'skill';
}

/** URL файла `SKILL.md` относительно индекса; null — вне источника/небезопасно. */
export function resolveSkillFileUrl(indexUrl: URL, entry: RemoteIndexEntry): URL | null {
  const rel = (entry.path ?? entry.name).trim().replace(/\/+$/, '');
  if (!rel) return null;
  let file: URL;
  try {
    file = new URL(`${rel}/SKILL.md`, indexUrl);
  } catch {
    return null;
  }
  if (file.protocol !== 'http:' && file.protocol !== 'https:') return null;
  // Скилл обязан лежать на том же origin, что и индекс (иначе — SSRF на чужой хост).
  if (file.origin !== indexUrl.origin) return null;
  return file;
}

async function writeCacheSkillFile(sourceDir: string, dirName: string, content: string): Promise<void> {
  const target = join(sourceDir, dirName, 'SKILL.md');
  await mkdir(dirname(target), { recursive: true });
  await atomicWrite(
    (p, d) => writeFile(p, d, 'utf-8'),
    (o, n) => rename(o, n),
    target,
    content,
  );
}

/**
 * Обновляет кэш удалённых каталогов. Не бросает: сетевые/форматные ошибки
 * возвращаются диагностикой (`remote`/`read-error`), при ошибке каталога его
 * старый кэш не затирается.
 */
export async function refreshRemoteCatalogs(
  opts: RefreshRemoteCatalogsOptions,
): Promise<RefreshRemoteCatalogsResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? REMOTE_INDEX_TIMEOUT_MS;
  const maxIndexBytes = opts.maxIndexBytes ?? REMOTE_INDEX_MAX_BYTES;
  const maxSkills = opts.maxSkills ?? REMOTE_MAX_SKILLS;
  const maxHops = opts.maxHops ?? REMOTE_MAX_REDIRECTS;

  const diagnostics: SkillDiagnostic[] = [];
  const sources: SkillSource[] = [];

  for (const raw of opts.urls) {
    const url = raw.trim();
    if (!url) continue;

    const source = buildUrlSource(opts.cacheDir, url);
    sources.push(source);

    const valid = validateRemoteUrl(url);
    if ('error' in valid) {
      diagnostics.push({ level: 'error', code: 'remote', dir: source.dir, message: valid.error });
      continue;
    }

    const indexUrl = resolveRemoteIndexUrl(valid.url);
    const index = await fetchText(indexUrl.toString(), {
      timeoutMs,
      maxBytes: maxIndexBytes,
      maxHops,
      fetchImpl,
    });
    if ('error' in index) {
      diagnostics.push({
        level: 'error',
        code: 'read-error',
        dir: source.dir,
        message: `не удалось загрузить ${indexUrl.toString()}: ${index.error}`,
      });
      continue;
    }

    const parsed = parseRemoteIndex(index.text);
    if ('error' in parsed) {
      diagnostics.push({ level: 'error', code: 'remote', dir: source.dir, message: parsed.error });
      continue;
    }

    if (parsed.entries.length > maxSkills) {
      diagnostics.push({
        level: 'warning',
        code: 'remote',
        dir: source.dir,
        message: `index.json: ${parsed.entries.length} записей, обрабатываются первые ${maxSkills}`,
      });
    }

    for (const entry of parsed.entries.slice(0, maxSkills)) {
      const fileUrl = resolveSkillFileUrl(indexUrl, entry);
      if (!fileUrl) {
        diagnostics.push({
          level: 'warning',
          code: 'remote',
          skill: entry.name,
          dir: source.dir,
          message: `пропущена запись "${entry.name}": путь вне источника`,
        });
        continue;
      }

      const file = await fetchText(fileUrl.toString(), {
        timeoutMs,
        maxBytes: REMOTE_FILE_MAX_BYTES,
        maxHops,
        fetchImpl,
      });
      if ('error' in file) {
        diagnostics.push({
          level: 'error',
          code: 'read-error',
          skill: entry.name,
          dir: source.dir,
          message: `не удалось загрузить ${fileUrl.toString()}: ${file.error}`,
        });
        continue;
      }

      try {
        await writeCacheSkillFile(source.dir, safeCacheDirName(entry.name), file.text);
      } catch (err) {
        diagnostics.push({
          level: 'error',
          code: 'read-error',
          skill: entry.name,
          dir: source.dir,
          message: `не удалось записать кэш скилла "${entry.name}": ${describeError(err)}`,
        });
      }
    }
  }

  return { diagnostics, sources };
}
