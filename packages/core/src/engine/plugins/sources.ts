/**
 * PROP-090 §«Источники установки» (долги Д1): резолвинг источника бандла
 * плагина в **локальный каталог**, который принимает `installFromDirectory`.
 *
 * ```text
 * dir      → каталог на диске (synth.pack уже рядом)             → без копирования
 * archive  → локальный .tar.gz/.tgz → extractPluginArchive        → tmp-каталог
 * npm      → registry.npmjs.org metadata → tarball (SRI sha512)    → tmp-каталог
 * url      → https + обязательный sha256 (pin)                    → tmp-каталог
 * ```
 *
 * **Почему это отдельный слой.** Установщик (`installer.ts`) работает с уже
 * распакованным каталогом и ничего не знает про сеть/архивы; политика доверия,
 * скан и раскладка остаются в нём. Здесь — только «откуда взять байты» плюс
 * проверка целостности до того, как бандл попадёт в установщик.
 *
 * **Сеть — только через `egressFetch`** (ADR-099: политика, прокси, TLS) или
 * инъекцию `ctx.fetch` (тесты, CLI). `globalThis.fetch` напрямую не вызывается:
 * иначе запрос ушёл бы мимо доверия TLS и прокси-маршрута инстанса.
 *
 * **Fail-closed по целостности.** npm: `dist.integrity` (SRI) обязателен —
 * без него бандл не устанавливается (реестр, не публикующий SRI, не даёт
 * воспроизводимости); `dist.shasum` проверяется дополнительно, если есть.
 * URL: `sha256` — **обязательный** pin в запросе (произвольный адрес без пина
 * не устанавливается). Архив/каталог: `ref` вычисляется по факту (`sha256`
 * байтов архива) и уходит в lock — update сможет сверить источник.
 *
 * **Редиректы.** `redirect: 'manual'`, до 3 переходов; каждый — повторная
 * проверка схемы `https:` (переход на `http:` = отказ). Ответ не-2xx — отказ с
 * кодом статуса. Таймаут — 30 с (`AbortSignal.timeout`).
 */
import { createHash, type Hash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { PluginLogger } from './activation.js';
import { extractPluginArchive, PluginArchiveError } from './archive.js';
import { egressFetch } from '../../security/tls.js';

/** Виды источников установки (PROP-090 §«Источники установки»). */
export const PLUGIN_INSTALL_SOURCE_KINDS = ['dir', 'archive', 'npm', 'url'] as const;
export type PluginInstallSourceKind = (typeof PLUGIN_INSTALL_SOURCE_KINDS)[number];

/** Проверка значения из HTTP-тела/CLI-флага. */
export function isPluginInstallSourceKind(value: unknown): value is PluginInstallSourceKind {
  return (
    typeof value === 'string' &&
    (PLUGIN_INSTALL_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

/** Предел скачиваемого файла по умолчанию (32 МиБ — npm-тарболы плагинов). */
export const DEFAULT_PLUGIN_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;

/** Таймаут одного сетевого вызова (мс). */
const FETCH_TIMEOUT_MS = 30_000;

/** Максимум редиректов (каждый — с повторной проверкой схемы). */
const MAX_REDIRECTS = 3;

/** npm-имя пакета: `name` или `@scope/name` (ни URL, ни путь). */
const NPM_NAME_REGEX = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Код причины отказа источника (для HTTP-маппинга: 400 vs 502). */
export type PluginSourceErrorCode = 'invalid_request' | 'network' | 'integrity' | 'archive';

/**
 * Отказ резолвинга источника: неверный запрос (имя/путь/pin), сеть/реестр,
 * несовпадение целостности, непринятый архив.
 */
export class PluginSourceError extends Error {
  /** Класс причины — вызывающий различает «плохой запрос» и «источник недоступен». */
  readonly code: PluginSourceErrorCode;

  constructor(message: string, code: PluginSourceErrorCode) {
    super(message);
    this.name = 'PluginSourceError';
    this.code = code;
  }
}

/** Инъекция зависимостей источника (сеть/лимиты/лог). */
export interface PluginSourceContext {
  /** Инъекция fetch (по умолчанию — `egressFetch` из `security/tls.js`). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Предел размера скачиваемого файла (по умолчанию 32 МиБ). */
  maxDownloadBytes?: number;
  logger?: PluginLogger;
}

/** Запрос источника: что и откуда взять. */
export interface PluginSourceRequest {
  kind: PluginInstallSourceKind;
  /** `dir`/`archive` — путь; `npm` — имя пакета (`name` или `@scope/name`); `url` — https-URL. */
  ref: string;
  /** `npm`: точная версия или `latest` (по умолчанию `latest`). */
  version?: string;
  /** `url`: обязательный ожидаемый sha256 (hex) — pin. */
  sha256?: string;
}

/** Разрешённый источник: каталог бандла + провенанс для lock-записи. */
export interface ResolvedPluginSource {
  /** Каталог распакованного бандла (готов для `installFromDirectory`). */
  dir: string;
  /** Освободить временный каталог (для `dir` — no-op; идемпотентно). */
  cleanup(): Promise<void>;
  /** `source` lock-записи (`local`/`npm`/`url`). */
  source: string;
  /** `identifier` lock-записи (путь/npm-имя/URL). */
  identifier?: string;
  /** `ref` lock-записи (точная версия / `sha256:<hex>`). */
  ref?: string;
}

/** Проверка npm-имени (fail-closed: URL/путь не проходят). */
export function isValidNpmPackageName(name: string): boolean {
  return NPM_NAME_REGEX.test(name);
}

/**
 * Угадать источник по строке (CLI: `install <ref>` без `--source`).
 *
 * Правила: `https?://` → `url`; явный путь (`.`/`/`/`~`, обратный слэш,
 * `.tgz`/`.tar.gz`) → `archive`/`dir`; валидное npm-имя → `npm`; иначе `dir`
 * (ошибку даст резолвинг с понятным текстом про отсутствующий манифест).
 */
export function inferPluginSourceKind(ref: string): PluginInstallSourceKind {
  const value = ref.trim();
  if (/^https?:\/\//i.test(value)) return 'url';
  const looksLikePath =
    value.startsWith('.') ||
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.includes('\\') ||
    /\.(tgz|tar\.gz)$/i.test(value);
  if (looksLikePath) return /\.(tgz|tar\.gz)$/i.test(value) ? 'archive' : 'dir';
  if (isValidNpmPackageName(value)) return 'npm';
  return 'dir';
}

/** Хеш байтов в заданном алгоритме (hex). */
function hashHex(data: Uint8Array, algorithm: 'sha256' | 'sha512' | 'sha1'): string {
  const hash: Hash = createHash(algorithm);
  hash.update(data);
  return hash.digest('hex');
}

/** `fetch` по умолчанию — единая точка исходящих запросов (ADR-099). */
function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  return egressFetch(url, init);
}

/** Проверка схемы: только `https:` (http-адреса и редиректы отклоняются). */
function requireHttps(url: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PluginSourceError(`Некорректный URL (${what}): «${url}».`, 'invalid_request');
  }
  if (parsed.protocol !== 'https:') {
    throw new PluginSourceError(
      `Источник (${what}) должен быть https: получено «${parsed.protocol}//…» — отказ.`,
      'invalid_request',
    );
  }
  return parsed;
}

/** Прочитать тело ответа с ограничением размера (стрим, без «сначала всё в память»). */
async function readBodyLimited(
  response: Response,
  maxBytes: number,
  what: string,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PluginSourceError(
      `Размер ${what} превышает предел (${declared} > ${maxBytes} байт) — загрузка отклонена.`,
      'network',
    );
  }

  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new PluginSourceError(
        `Размер ${what} превышает предел (${buffer.length} > ${maxBytes} байт) — загрузка отклонена.`,
        'network',
      );
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PluginSourceError(
        `Размер ${what} превышает предел (${maxBytes} байт) — загрузка отклонена.`,
        'network',
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * `GET` с ручной обработкой редиректов: до 3 переходов, каждый — `https:`,
 * не-2xx — отказ с кодом статуса, тело — с пределом размера.
 */
async function fetchBuffer(
  url: string,
  ctx: PluginSourceContext,
  what: string,
  headers?: Record<string, string>,
): Promise<Buffer> {
  const doFetch = ctx.fetch ?? defaultFetch;
  const maxBytes = ctx.maxDownloadBytes ?? DEFAULT_PLUGIN_DOWNLOAD_MAX_BYTES;
  let current = requireHttps(url, what).toString();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await doFetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...(headers ? { headers } : {}),
      });
    } catch (err) {
      throw new PluginSourceError(
        `Не удалось получить ${what} (${current}): ${err instanceof Error ? err.message : String(err)}`,
        'network',
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new PluginSourceError(
          `Редирект ${what} без заголовка Location (HTTP ${response.status}).`,
          'network',
        );
      }
      // Схема проверяется на каждом шаге: уход на http: — отказ, а не «докачаем».
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new PluginSourceError(
          `Редирект ${what} ведёт на некорректный адрес «${location}».`,
          'network',
        );
      }
      current = requireHttps(next, what).toString();
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PluginSourceError(
        `Источник (${what}) ответил HTTP ${response.status} — бандл не получен.`,
        'network',
      );
    }

    return readBodyLimited(response, maxBytes, what);
  }

  throw new PluginSourceError(
    `Слишком много редиректов при получении ${what} ( > ${MAX_REDIRECTS }).`,
    'network',
  );
}

/** Источник `dir`: каталог с бандлом; проверяется наличие `synth.pack`. */
async function resolveDirectory(request: PluginSourceRequest): Promise<ResolvedPluginSource> {
  const dir = resolve(request.ref);
  let isDirectory = false;
  try {
    isDirectory = (await stat(dir)).isDirectory();
  } catch {
    throw new PluginSourceError(`Каталог бандла не найден: «${dir}».`, 'invalid_request');
  }
  if (!isDirectory) {
    throw new PluginSourceError(`Источник «${dir}» — не каталог.`, 'invalid_request');
  }
  try {
    await readFile(join(dir, 'synth.pack'));
  } catch {
    throw new PluginSourceError(
      `В каталоге «${dir}» нет манифеста «synth.pack» — это не бандл плагина.`,
      'invalid_request',
    );
  }
  return {
    dir,
    cleanup: async () => undefined,
    source: 'local',
    identifier: dir,
  };
}

/** Источник `archive`: локальный `.tar.gz`/`.tgz` → tmp-каталог. */
async function resolveArchive(
  request: PluginSourceRequest,
  ctx: PluginSourceContext,
): Promise<ResolvedPluginSource> {
  const path = resolve(request.ref);
  const maxBytes = ctx.maxDownloadBytes ?? DEFAULT_PLUGIN_DOWNLOAD_MAX_BYTES;
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new PluginSourceError(`Источник «${path}» — не файл архива.`, 'invalid_request');
    }
    size = info.size;
  } catch (err) {
    if (err instanceof PluginSourceError) throw err;
    throw new PluginSourceError(`Архив не найден: «${path}».`, 'invalid_request');
  }
  if (size > maxBytes) {
    throw new PluginSourceError(
      `Архив больше допустимого (${size} > ${maxBytes} байт) — распаковка отклонена.`,
      'invalid_request',
    );
  }
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) {
    throw new PluginSourceError(
      `Архив больше допустимого (${bytes.length} > ${maxBytes} байт) — распаковка отклонена.`,
      'invalid_request',
    );
  }

  const extracted = await extractArchiveOrThrow(bytes, undefined, path);
  return {
    dir: extracted.dir,
    cleanup: extracted.cleanup,
    source: 'local',
    identifier: path,
    ref: `sha256:${hashHex(bytes, 'sha256')}`,
  };
}

/** Распаковка с превращением `PluginArchiveError` в `PluginSourceError`. */
async function extractArchiveOrThrow(
  bytes: Uint8Array,
  stripPrefix: string | undefined,
  label: string,
): Promise<Awaited<ReturnType<typeof extractPluginArchive>>> {
  try {
    return await extractPluginArchive(bytes, stripPrefix ? { stripPrefix } : {});
  } catch (err) {
    if (err instanceof PluginArchiveError) {
      throw new PluginSourceError(`Архив «${label}» отклонён: ${err.message}`, 'archive');
    }
    throw err;
  }
}

/** Проверить SRI (`sha512-…`) скачанного тарбола; без sha512 — отказ. */
function verifySri(integrity: string, bytes: Buffer, label: string): void {
  const digests = integrity
    .trim()
    .split(/\s+/)
    .filter((part) => part.startsWith('sha512-'))
    .map((part) => part.slice('sha512-'.length));
  if (digests.length === 0) {
    throw new PluginSourceError(
      `Целостность «${label}» не проверяема: в dist.integrity нет sha512 — установка отклонена.`,
      'integrity',
    );
  }
  const actual = createHash('sha512').update(bytes).digest('base64');
  if (!digests.includes(actual)) {
    throw new PluginSourceError(
      `Несовпадение integrity «${label}»: sha512 скачанного тарбола не совпал с dist.integrity.`,
      'integrity',
    );
  }
}

/** Кодирование npm-имени в путь реестра (`@scope/name` → `@scope%2Fname`). */
function encodeNpmRegistryName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2F') : encodeURIComponent(name);
}

/** Источник `npm`: metadata реестра + tarball с проверкой SRI/shasum. */
async function resolveNpm(
  request: PluginSourceRequest,
  ctx: PluginSourceContext,
): Promise<ResolvedPluginSource> {
  const name = request.ref.trim();
  if (!isValidNpmPackageName(name)) {
    throw new PluginSourceError(
      `«${name}» не является npm-именем пакета (ожидается «name» или «@scope/name») — ` +
        'для пути используйте kind=dir/archive, для ссылки — kind=url.',
      'invalid_request',
    );
  }

  const metadataUrl = `https://registry.npmjs.org/${encodeNpmRegistryName(name)}`;
  // Abbreviated packument: реестр отдаёт только нужное (dist-tags + versions[].dist),
  // полный документ популярных пакетов — десятки мегабайт и упирался бы в лимит.
  const metadataBytes = await fetchBuffer(metadataUrl, ctx, `метаданных npm «${name}»`, {
    accept: 'application/vnd.npm.install-v1+json',
  });
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataBytes.toString('utf-8'));
  } catch {
    throw new PluginSourceError(
      `Реестр npm вернул не JSON для «${name}» — источник недоступен.`,
      'network',
    );
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new PluginSourceError(`Метаданные npm «${name}» имеют неожиданный формат.`, 'network');
  }
  const meta = metadata as Record<string, unknown>;
  const versions =
    typeof meta['versions'] === 'object' && meta['versions'] !== null
      ? (meta['versions'] as Record<string, unknown>)
      : {};
  const distTags =
    typeof meta['dist-tags'] === 'object' && meta['dist-tags'] !== null
      ? (meta['dist-tags'] as Record<string, unknown>)
      : {};

  const wanted = request.version?.trim() || 'latest';
  const tagged = distTags[wanted];
  const version =
    typeof tagged === 'string'
      ? tagged
      : Object.prototype.hasOwnProperty.call(versions, wanted)
        ? wanted
        : undefined;
  if (!version) {
    throw new PluginSourceError(
      `Версия «${wanted}» пакета «${name}» не найдена в реестре npm (есть: ${
        Object.keys(distTags).join(', ') || '—'
      }).`,
      'invalid_request',
    );
  }

  const versionEntry = versions[version];
  if (typeof versionEntry !== 'object' || versionEntry === null || Array.isArray(versionEntry)) {
    throw new PluginSourceError(
      `Метаданные «${name}@${version}» в реестре npm неполные — установка отклонена.`,
      'network',
    );
  }
  const distRaw = (versionEntry as Record<string, unknown>)['dist'];
  const dist =
    typeof distRaw === 'object' && distRaw !== null && !Array.isArray(distRaw)
      ? (distRaw as Record<string, unknown>)
      : {};
  const tarball = typeof dist['tarball'] === 'string' ? dist['tarball'].trim() : '';
  if (!tarball) {
    throw new PluginSourceError(
      `У «${name}@${version}» нет dist.tarball — установка отклонена.`,
      'network',
    );
  }
  const integrity = typeof dist['integrity'] === 'string' ? dist['integrity'] : '';
  if (!integrity) {
    // Fail-closed: без SRI нельзя утверждать, что скачанный тарбол — тот самый.
    throw new PluginSourceError(
      `Пакет «${name}@${version}» не публикует dist.integrity (SRI) — установка отклонена ` +
        '(воспроизводимость не подтверждается).',
      'integrity',
    );
  }

  const tarballBytes = await fetchBuffer(tarball, ctx, `тарбола npm «${name}@${version}»`);
  verifySri(integrity, tarballBytes, `${name}@${version}`);
  const shasum = typeof dist['shasum'] === 'string' ? dist['shasum'].trim() : '';
  if (shasum && hashHex(tarballBytes, 'sha1') !== shasum.toLowerCase()) {
    throw new PluginSourceError(
      `Несовпадение shasum «${name}@${version}»: sha1 скачанного тарбола не совпал с dist.shasum.`,
      'integrity',
    );
  }

  // npm-тарбол всегда упакован в каталог `package/`.
  const extracted = await extractArchiveOrThrow(tarballBytes, 'package', `${name}@${version}`);
  return {
    dir: extracted.dir,
    cleanup: extracted.cleanup,
    source: 'npm',
    identifier: name,
    ref: version,
  };
}

/** Источник `url`: https + обязательный `sha256` (pin). */
async function resolveUrl(
  request: PluginSourceRequest,
  ctx: PluginSourceContext,
): Promise<ResolvedPluginSource> {
  const url = request.ref.trim();
  requireHttps(url, 'url');
  const expected = request.sha256?.trim().toLowerCase() ?? '';
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new PluginSourceError(
      'Для источника url обязателен pin sha256 (64 hex-символа): произвольный адрес без ' +
        'контрольной суммы не устанавливается.',
      'invalid_request',
    );
  }

  const bytes = await fetchBuffer(url, ctx, 'архива по URL');
  const actual = hashHex(bytes, 'sha256');
  if (actual !== expected) {
    throw new PluginSourceError(
      `Несовпадение sha256 архива по URL: ожидалось ${expected}, получено ${actual}.`,
      'integrity',
    );
  }

  const extracted = await extractArchiveOrThrow(bytes, undefined, url);
  return {
    dir: extracted.dir,
    cleanup: extracted.cleanup,
    source: 'url',
    identifier: url,
    ref: `sha256:${actual}`,
  };
}

/**
 * Разрешить источник установки в локальный каталог бандла.
 *
 * Возвращённый `cleanup` обязателен к вызову (установщик делает это в `finally`):
 * для `dir` он ничего не делает, для остальных удаляет временный каталог.
 */
export async function resolvePluginSource(
  request: PluginSourceRequest,
  ctx: PluginSourceContext = {},
): Promise<ResolvedPluginSource> {
  switch (request.kind) {
    case 'dir':
      return resolveDirectory(request);
    case 'archive':
      return resolveArchive(request, ctx);
    case 'npm':
      return resolveNpm(request, ctx);
    case 'url':
      return resolveUrl(request, ctx);
    default: {
      const unknown: never = request.kind;
      throw new PluginSourceError(
        `Неизвестный источник установки «${String(unknown)}».`,
        'invalid_request',
      );
    }
  }
}
