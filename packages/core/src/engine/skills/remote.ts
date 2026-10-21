import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  atomicWrite,
  isCatalogIndexDocument,
  isCatalogSkillEntry,
  parseCatalogEntries,
  type CatalogEntry,
  type SkillDiagnostic,
} from '@itphx/synth-shared';
import { TEMPLATE_FILE_MAX_BYTES } from '../commands/template.js';
import { buildUrlSource } from './discovery.js';
import type { SkillSource } from './types.js';
// ADR-046 §4.2: общий SSRF-guard/fetch — вынесен в `engine/net/fetch.ts`,
// чтобы не дублироваться с проектными инструкциями (ADR-069).
import { describeError, fetchText, validateRemoteUrl, type FetchLike } from '../net/fetch.js';
import { egressFetch } from '../../security/tls.js';
import { resolveToolsEgressPolicy } from '../net/egress-runtime.js';
import type { EgressPolicy } from '@itphx/synth-shared';
import type { HostResolver } from '../mcp/network-policy.js';

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
 * Скачиваем внешний индекс каталога + `<base>/<path||name>/SKILL.md`
 * в детерминированный кэш `{cacheDir}/urls/<sha1(url)[:16]>`. Скиллы из кэша
 * имеют `trusted: false` (см. `buildUrlSource`) — они видны в реестре/диагностике,
 * но не попадают в каталог для модели и не грузятся. Установка/доверие/подписи/
 * `lock.json` — PROP-068, здесь не реализуются.
 *
 * **Формат индекса** — общий контракт каталога расширений (`format: 1`,
 * `@itphx/synth-shared`: `catalogIndexSchema`/`parseCatalogEntries`):
 * канонический `{ format: 1, plugins: [...] }`, а также legacy-формы
 * `{ skills: [...] }` и голый массив `[{ name, path? }]`. Загрузчик скиллов
 * берёт из индекса **только скиллы** (`kind: 'pack'` + `packType: 'skills'`);
 * записи других классов (`plugin`/`gateway`/`addon`/`storage` и пакеты других
 * `packType`) игнорируются.
 *
 * Путь скилла внутри каталога: явное поле `path` карточки (каноническая форма,
 * контент-паки вендорены в каталоге) → `extra.path` (legacy-формы) →
 * фрагмент `identifier` после `#` → имя записи.
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
/**
 * Лимит числа записей каталога, обрабатываемых за проход (по умолчанию 200).
 * Переопределяется опцией `maxSkills` (`RefreshRemoteCatalogsOptions`) — портал
 * расширений сможет поднять лимит, не меняя поведение по умолчанию.
 */
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
  /**
   * Лимит числа обрабатываемых записей-скиллов за проход (по умолчанию
   * `REMOTE_MAX_SKILLS` = 200). Записи других классов каталога в лимит не
   * входят — они игнорируются загрузчиком скиллов.
   */
  maxSkills?: number;
  maxHops?: number;
  /** Инъекция DNS-резолвера SSRF-проверки (тесты). */
  resolveHost?: HostResolver;
  /** Resolved egress-политика; не задана — живой резолвер. */
  policy?: EgressPolicy;
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

/** Запись каталога, из которой загрузчик скиллов берёт имя и путь. */
interface RemoteIndexEntry {
  name: string;
  path?: string;
}

/**
 * Путь скилла внутри каталога (относительно базового URL индекса).
 *
 * Порядок источников:
 * 1. `path` — явное поле карточки (каноническая форма: путь к вендоренному
 *    контенту, `kind: 'pack'`);
 * 2. `extra.path` — legacy-формы и прежние карточки (`{ skills: [...] }`);
 * 3. фрагмент `identifier` после `#` (устойчивый id `owner/repo#path`);
 * 4. иначе — undefined (loader возьмёт имя записи как путь).
 */
export function resolveCatalogSkillPath(entry: CatalogEntry): string | undefined {
  const explicit = entry.path?.trim();
  if (explicit) return explicit;
  const extra = entry.extra;
  const extraPath = extra && typeof extra === 'object' ? extra['path'] : undefined;
  if (typeof extraPath === 'string' && extraPath.trim().length > 0) return extraPath.trim();
  const hash = entry.identifier.indexOf('#');
  if (hash >= 0) {
    const fragment = entry.identifier.slice(hash + 1).trim();
    if (fragment.length > 0) return fragment;
  }
  return undefined;
}

/** Запись каталога → запись загрузчика (имя + путь внутри источника). */
function toRemoteIndexEntry(entry: CatalogEntry): RemoteIndexEntry {
  const path = resolveCatalogSkillPath(entry);
  return path ? { name: entry.name, path } : { name: entry.name };
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
  // ADR-099: транспорт удалённых каталогов по умолчанию — `egressFetch` (единое доверие TLS/CA).
  const fetchImpl: FetchLike = opts.fetchImpl ?? egressFetch;
  const timeoutMs = opts.timeoutMs ?? REMOTE_INDEX_TIMEOUT_MS;
  const maxIndexBytes = opts.maxIndexBytes ?? REMOTE_INDEX_MAX_BYTES;
  const maxSkills = opts.maxSkills ?? REMOTE_MAX_SKILLS;
  const maxHops = opts.maxHops ?? REMOTE_MAX_REDIRECTS;
  // Один снимок политики на весь проход каталогов.
  const policy = opts.policy ?? await resolveToolsEgressPolicy();

  const diagnostics: SkillDiagnostic[] = [];
  const sources: SkillSource[] = [];

  for (const raw of opts.urls) {
    const url = raw.trim();
    if (!url) continue;

    const source = buildUrlSource(opts.cacheDir, url);
    sources.push(source);

    const valid = await validateRemoteUrl(url, { resolveHost: opts.resolveHost, policy });
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
      resolveHost: opts.resolveHost,
      policy,
      scope: 'skills',
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

    let document: unknown;
    try {
      document = JSON.parse(index.text);
    } catch {
      diagnostics.push({
        level: 'error',
        code: 'remote',
        dir: source.dir,
        message: 'index.json: некорректный JSON',
      });
      continue;
    }
    if (!isCatalogIndexDocument(document)) {
      diagnostics.push({
        level: 'error',
        code: 'remote',
        dir: source.dir,
        message: 'index.json: ожидается каталог расширений (format: 1, { skills: [...] } или массив записей)',
      });
      continue;
    }

    // Формат индекса — общий контракт каталога (shared, PROP-068 §3/§12).
    // Загрузчик скиллов берёт только записи-скиллы (`kind: 'pack'` +
    // `packType: 'skills'`); записи других классов игнорируются.
    const skills = parseCatalogEntries(document)
      .filter((entry) => isCatalogSkillEntry(entry))
      .map((entry) => toRemoteIndexEntry(entry));

    if (skills.length > maxSkills) {
      diagnostics.push({
        level: 'warning',
        code: 'remote',
        dir: source.dir,
        message: `index.json: ${skills.length} записей скиллов, обрабатываются первые ${maxSkills}`,
      });
    }

    for (const entry of skills.slice(0, maxSkills)) {
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
        resolveHost: opts.resolveHost,
        policy,
        scope: 'skills',
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
