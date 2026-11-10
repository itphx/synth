// ADR-133: проверка обновлений пакета `@itphx/synth` по каналам.
//
// Канал выводится из установленной версии (`-beta.` в `SYNTH_VERSION` ⇒ beta),
// а не хранится файлом-маркером: состояние не расходится с фактом установки.
// Override — `updates.channel` (`auto`|`stable`|`beta`).
//
// Источники — по каналу: `stable` → `updates.stableRegistry` (npmjs, тег
// `latest`), `beta` → `updates.betaRegistry` (npm-реестр Gitea, тег `beta`;
// читается без токена — токен нужен только публикации).
//
// Кэш — `{dataDir}/update-check.json` по каналам: успех живёт
// `updates.intervalHours` (24 ч), запись с ошибкой — 1 ч (офлайн — тихо).
// Явная проверка (`force`) кэш игнорирует; сетевая ошибка в явном режиме
// пробрасывается (роут отдаёт 502), в фоновом — возвращается запись с `error`.
//
// Egress — только `egressFetch` (ADR-099: доверие TLS/CA и прокси — один слой).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SYNTH_VERSION, type UpdatesConfig } from '@itphx/synth-shared';
import { egressFetch } from './security/tls.js';

/** Канал стабильных релизов. */
export type UpdateChannel = 'stable' | 'beta';

/** Значение настройки канала: `auto` — вывести из установленной версии. */
export type UpdateChannelChoice = 'auto' | UpdateChannel;

/** Пакет, у которого запрашиваются метаданные реестра. */
export const UPDATE_PACKAGE_NAME = '@itphx/synth';

/** Реестр стабильного канала по умолчанию (npmjs). */
export const DEFAULT_STABLE_REGISTRY = 'https://registry.npmjs.org';

/** Реестр бета-канала по умолчанию (npm-реестр Gitea, чтение без токена). */
export const DEFAULT_BETA_REGISTRY = 'https://git.itphx.ru/api/packages/itphx/npm/';

/** TTL успешной проверки по умолчанию, часы. */
const DEFAULT_INTERVAL_HOURS = 24;

/** TTL записи с ошибкой — 1 час (сеть может вернуться). */
const ERROR_TTL_MS = 60 * 60 * 1000;

/** Таймаут запроса к реестру. */
const FETCH_TIMEOUT_MS = 10_000;

/** Файл кэша в каталоге данных. */
const CACHE_FILE = 'update-check.json';

/** Версия формата кэша (старый плоский объект читается как `stable`). */
const CACHE_VERSION = 2;

/** Результат проверки обновлений. */
export interface UpdateInfo {
  /** Установленная версия. */
  currentVersion: string;
  /** Последняя версия канала (при ошибке — из предыдущей записи или текущая). */
  latestVersion: string;
  /** Канал проверки. */
  channel: UpdateChannel;
  /** Целевая версия — пре-релиз (`-beta.…`). */
  prerelease: boolean;
  /** Реестр, в котором проверяли. */
  registry: string;
  /** Обновление доступно (`compareVersions(latest, current) > 0`). */
  hasUpdate: boolean;
  /** Метка проверки, ISO-8601. */
  checkedAt: string;
  /** Текст ошибки: запись кэширована, но обновление неизвестно. */
  error?: string;
}

/** Параметры проверки обновлений. */
export interface UpdateCheckOptions {
  /** Канал (`auto` — по установленной версии). */
  channel?: UpdateChannelChoice;
  /** Секция `updates` конфига/эффективная (реестры, интервал, канал). */
  updates?: Partial<UpdatesConfig>;
  /** Игнорировать кэш (явная проверка). */
  force?: boolean;
  /**
   * Фоновый режим (планировщик): сетевые ошибки не бросаются, а кэшируются в
   * запись с `error` и не ломают ход проверки.
   */
  background?: boolean;
}

/** Семвер (базовая версия + необязательный пре-релиз), без префикса `v`. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Проверяет, что строка — семвер (префикс `v` допустим). */
export function isSemver(version: string): boolean {
  return SEMVER_RE.test(version.replace(/^v/, ''));
}

export function parseVersion(version: string): [number, number, number] {
  // Отрезаем пре-релиз/сборку: `0.13.9-beta.1` → `0.13.9` (иначе `Number('9-beta')`
  // даёт NaN и patch схлопывается в 0 — beta выше текущего релиза не считалась).
  const base = version.replace(/^v/, '').split(/[-+]/, 1)[0] ?? '';
  const [major, minor, patch] = base.split('.').map(Number);
  return [major || 0, minor || 0, patch || 0];
}

export function isNewer(latest: string, current: string): boolean {
  const [lMaj, lMin, lPatch] = parseVersion(latest);
  const [cMaj, cMin, cPatch] = parseVersion(current);

  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPatch > cPatch;
}

/** Пре-релизная часть версии (`1.2.3-rc.1` → `rc.1`; нет — пустая строка). */
function _prereleaseOf(version: string): string {
  const at = version.indexOf('-');
  return at === -1 ? '' : version.slice(at + 1);
}

/**
 * Сравнение версий (ADR-092, `synth update --to`): `<0` — `a` старше `b`,
 * `0` — равны, `>0` — `a` новее. Пре-релиз (`1.2.3-rc.1`) ниже релиза (`1.2.3`).
 */
export function compareVersions(a: string, b: string): number {
  const [aMaj, aMin, aPatch] = parseVersion(a);
  const [bMaj, bMin, bPatch] = parseVersion(b);

  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  if (aPatch !== bPatch) return aPatch - bPatch;

  const aPre = _prereleaseOf(a);
  const bPre = _prereleaseOf(b);
  if (aPre === bPre) return 0;
  // Релиз новее любого пре-релиза той же базовой версии.
  if (aPre === '') return 1;
  if (bPre === '') return -1;
  return aPre < bPre ? -1 : 1;
}

/**
 * Канал проверки: `auto` — по установленной версии (`-beta.` ⇒ `beta`),
 * явный `stable`/`beta` — как задан.
 */
export function resolveUpdateChannel(
  currentVersion: string,
  configured: UpdateChannelChoice = 'auto',
): UpdateChannel {
  if (configured === 'stable' || configured === 'beta') return configured;
  return currentVersion.includes('-beta.') ? 'beta' : 'stable';
}

/** Нормализация реестра: без хвостового `/` (пусто — дефолт канала). */
function _normalizeRegistry(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return (trimmed || fallback).replace(/\/+$/, '');
}

/** Реестр канала из `updates` (нормализованный, без хвостового `/`). */
export function resolveUpdatesRegistry(
  channel: UpdateChannel,
  updates: Partial<UpdatesConfig> = {},
): string {
  return channel === 'beta'
    ? _normalizeRegistry(updates.betaRegistry, DEFAULT_BETA_REGISTRY)
    : _normalizeRegistry(updates.stableRegistry, DEFAULT_STABLE_REGISTRY);
}

/** URL метаданных пакета в реестре (`…/@itphx%2Fsynth`). */
export function packageMetadataUrl(registry: string): string {
  const base = registry.replace(/\/+$/, '');
  // npm-стиль: `@` остаётся, `/` кодируется (`@itphx%2Fsynth`).
  const encoded = encodeURIComponent(UPDATE_PACKAGE_NAME).replace(/^%40/, '@');
  return `${base}/${encoded}`;
}

/** Транспорт запроса (тесты инжектят и в сеть не ходят). */
export type EgressFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface MetadataDocument {
  'dist-tags'?: Record<string, unknown>;
  versions?: Record<string, unknown>;
}

/**
 * Запрос метаданных пакета.
 *
 * Основной путь — `@itphx%2Fsynth`; при 404 пробуем `@itphx/synth` (некоторые
 * реестры отдают метаданные только в «сыром» виде). Текст ошибки не содержит
 * URL с возможными токенами в userinfo — только HTTP-статус.
 */
async function _fetchMetadata(registry: string, fetchImpl: EgressFetchLike): Promise<MetadataDocument> {
  const base = registry.replace(/\/+$/, '');
  const candidates = [
    packageMetadataUrl(registry),
    `${base}/${UPDATE_PACKAGE_NAME}`,
  ];

  let lastStatus = 0;
  for (const url of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (response.status === 404) {
        lastStatus = 404;
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} при запросе метаданных ${UPDATE_PACKAGE_NAME}`);
      }
      return (await response.json()) as MetadataDocument;
    } catch (err) {
      // 404-ветку обработали выше; сюда попадают сетевые ошибки/таймаут.
      if (err instanceof Error && err.message.startsWith('HTTP ')) throw err;
      if (controller.signal.aborted) {
        throw new Error(`Таймаут запроса метаданных ${UPDATE_PACKAGE_NAME}`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`HTTP ${lastStatus || 404} при запросе метаданных ${UPDATE_PACKAGE_NAME}`);
}

/** `dist-tags` пакета из реестра (например `{latest, beta, next}`). */
export async function fetchDistTags(
  registry: string,
  fetchImpl: EgressFetchLike = egressFetch,
): Promise<Record<string, string>> {
  const data = await _fetchMetadata(registry, fetchImpl);
  const tags = data['dist-tags'];
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new Error('В ответе реестра нет dist-tags');
  }
  const result: Record<string, string> = {};
  for (const [tag, value] of Object.entries(tags)) {
    if (typeof value === 'string' && value) result[tag] = value;
  }
  return result;
}

/** Последняя версия канала: `latest` для stable, `beta` для beta. */
export async function fetchLatestVersion(channel: UpdateChannel, registry: string): Promise<string> {
  const tag = channel === 'beta' ? 'beta' : 'latest';
  const tags = await fetchDistTags(registry);
  const version = tags[tag];
  if (!version) {
    throw new Error(`В реестре нет dist-tag «${tag}» для ${UPDATE_PACKAGE_NAME}`);
  }
  return version.replace(/^v/, '');
}

/**
 * Список опубликованных версий `@itphx/synth` из реестра (ADR-092).
 *
 * Возвращает семвер-строки без префикса `v`, отсортированные по возрастанию
 * (`compareVersions`; пре-релизы ниже релиза с той же базовой версией).
 */
export async function fetchAvailableVersions(registry: string): Promise<string[]> {
  const data = await _fetchMetadata(registry, egressFetch);
  const versions = Object.keys(data.versions ?? {}).filter((version) => isSemver(version));
  return versions.sort(compareVersions);
}

/** Запись кэша по каналу. */
interface CachedChannel extends UpdateInfo {
  _ts: number;
}

/** Файл кэша (ADR-133: по каналам). */
interface UpdateCacheFile {
  version: number;
  channels: Partial<Record<UpdateChannel, CachedChannel>>;
}

/** Прочитать файл кэша; legacy-плоский объект трактуется как `stable`. */
async function _readCacheFile(dataDir: string): Promise<UpdateCacheFile> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, CACHE_FILE), 'utf-8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (obj.version === CACHE_VERSION && obj.channels && typeof obj.channels === 'object') {
        return { version: CACHE_VERSION, channels: obj.channels as UpdateCacheFile['channels'] };
      }
      // Legacy (до ADR-133): плоский UpdateInfo + `_ts` — это стабильный канал.
      if (typeof obj.currentVersion === 'string' && typeof obj.latestVersion === 'string') {
        return {
          version: CACHE_VERSION,
          channels: { stable: obj as unknown as CachedChannel },
        };
      }
    }
  } catch {
    // Нет файла/битый JSON — кэша нет.
  }
  return { version: CACHE_VERSION, channels: {} };
}

/** Свежая ли запись: успех — `intervalHours`, ошибка — 1 ч. */
function _isFresh(entry: CachedChannel, intervalHours: number): boolean {
  if (typeof entry._ts !== 'number' || !Number.isFinite(entry._ts)) return false;
  const ttl = entry.error ? ERROR_TTL_MS : intervalHours * 60 * 60 * 1000;
  return Date.now() - entry._ts < ttl;
}

/** Запись кэша по каналу (другие каналы сохраняются). */
async function _writeCache(dataDir: string, channel: UpdateChannel, info: UpdateInfo): Promise<void> {
  const file = await _readCacheFile(dataDir);
  file.channels[channel] = { ...info, _ts: Date.now() };
  await writeFile(join(dataDir, CACHE_FILE), JSON.stringify(file), 'utf-8');
}

/** Кэшированный ответ канала, если он ещё свежий. */
async function _readCached(
  dataDir: string,
  channel: UpdateChannel,
  intervalHours: number,
): Promise<UpdateInfo | null> {
  const file = await _readCacheFile(dataDir);
  const entry = file.channels[channel];
  if (!entry || !_isFresh(entry, intervalHours)) return null;
  const { _ts: _ignored, ...info } = entry;
  return info;
}

/** Собрать `UpdateInfo` по найденной версии. */
function _buildInfo(params: {
  channel: UpdateChannel;
  registry: string;
  latestVersion: string;
  checkedAt: string;
  error?: string;
}): UpdateInfo {
  const latestVersion = params.latestVersion.replace(/^v/, '');
  const info: UpdateInfo = {
    currentVersion: SYNTH_VERSION,
    latestVersion,
    channel: params.channel,
    prerelease: _prereleaseOf(latestVersion) !== '',
    registry: params.registry,
    // ADR-133: сравнение пре-релиз-aware (не `isNewer`).
    hasUpdate: compareVersions(latestVersion, SYNTH_VERSION) > 0,
    checkedAt: params.checkedAt,
  };
  if (params.error !== undefined) info.error = params.error;
  return info;
}

/**
 * Проверка обновлений по каналу (ADR-133).
 *
 * - канал/реестр — из `opts.channel`/`opts.updates` (нет — по установленной
 *   версии и дефолтным реестрам);
 * - кэш по каналам; `force` его игнорирует;
 * - сетевая ошибка: явный режим — `throw` (роут отдаёт 502), фоновый
 *   (`background: true`) — запись с `error` на 1 ч.
 */
export async function checkForUpdates(
  dataDir: string,
  opts: UpdateCheckOptions = {},
): Promise<UpdateInfo> {
  const updates = opts.updates ?? {};
  const channel = resolveUpdateChannel(SYNTH_VERSION, opts.channel ?? updates.channel ?? 'auto');
  const intervalHours = updates.intervalHours && updates.intervalHours > 0
    ? updates.intervalHours
    : DEFAULT_INTERVAL_HOURS;
  const registry = resolveUpdatesRegistry(channel, updates);

  if (!opts.force) {
    const cached = await _readCached(dataDir, channel, intervalHours);
    if (cached) return cached;
  }

  const previous = (await _readCacheFile(dataDir)).channels[channel];
  const checkedAt = new Date().toISOString();

  try {
    const latestVersion = await fetchLatestVersion(channel, registry);
    const info = _buildInfo({ channel, registry, latestVersion, checkedAt });
    await _writeCache(dataDir, channel, info).catch(() => {});
    return info;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const info = _buildInfo({
      channel,
      registry,
      latestVersion: previous?.latestVersion ?? SYNTH_VERSION,
      checkedAt,
      error: message,
    });
    // Ошибка кэшируется на 1 ч: офлайн не должен дёргать реестр каждый тик.
    await _writeCache(dataDir, channel, info).catch(() => {});
    if (opts.background) return info;
    throw err;
  }
}

/**
 * Фоновая проверка: только при `updates.check === true`, ошибки глотаются
 * (планировщик зовёт её на каждом тике).
 */
export function checkForUpdatesBackground(
  dataDir: string,
  opts: UpdateCheckOptions = {},
  onUpdate?: (info: UpdateInfo) => void,
): void {
  if (opts.updates?.check !== true) return;

  checkForUpdates(dataDir, { ...opts, background: true })
    .then((info) => {
      if (info.hasUpdate && onUpdate) {
        onUpdate(info);
      }
    })
    .catch(() => {});
}
