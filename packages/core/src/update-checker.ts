import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SYNTH_VERSION } from '@itphx/synth-shared';
// ADR-099: запросы к реестру npm — через единый транспорт доверия TLS/CA.
import { egressFetch } from './security/tls.js';

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  checkedAt: string;
}

const NPM_REGISTRY = 'https://registry.npmjs.org/@itphx/synth/latest';
/** Документ реестра npm со списком опубликованных версий (ADR-092, `--to`). */
const NPM_REGISTRY_PACKAGE = 'https://registry.npmjs.org/@itphx/synth';
const CACHE_FILE = 'update-check.json';
const TTL_MS = 6 * 60 * 60 * 1000;

/** Семвер (базовая версия + необязательный пре-релиз), без префикса `v`. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Проверяет, что строка — семвер (префикс `v` допустим). */
export function isSemver(version: string): boolean {
  return SEMVER_RE.test(version.replace(/^v/, ''));
}

export function parseVersion(version: string): [number, number, number] {
  const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
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

async function readCache(dataDir: string): Promise<UpdateInfo | null> {
  try {
    const raw = await readFile(join(dataDir, CACHE_FILE), 'utf-8');
    const cached = JSON.parse(raw) as UpdateInfo & { _ts: number };
    if (cached._ts && Date.now() - cached._ts < TTL_MS) {
      return { currentVersion: cached.currentVersion, latestVersion: cached.latestVersion, hasUpdate: cached.hasUpdate, checkedAt: cached.checkedAt };
    }
  } catch {
    return null;
  }
  return null;
}

async function writeCache(dataDir: string, info: UpdateInfo): Promise<void> {
  await writeFile(join(dataDir, CACHE_FILE), JSON.stringify({ ...info, _ts: Date.now() }), 'utf-8');
}

/** Последняя версия по `latest`-тегу реестра (для `synth update` без `--to`). */
export async function fetchLatestVersion(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await egressFetch(NPM_REGISTRY, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as { version?: string };
    if (!data.version) {
      throw new Error('Версия не найдена в ответе npm');
    }

    return data.version;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Список опубликованных версий `@itphx/synth` из реестра npm (ADR-092).
 *
 * Возвращает семвер-строки без префикса `v`, отсортированные по возрастанию
 * (`compareVersions`; пре-релизы ниже релиза с той же базовой версией). Сеть
 * запрашивается только здесь: `synth update --to` валидирует существование
 * версии по этому списку, тесты инжектят `deps.fetchVersions` и сети не делают.
 */
export async function fetchAvailableVersions(): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await egressFetch(NPM_REGISTRY_PACKAGE, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as { versions?: Record<string, unknown> };
    const versions = Object.keys(data.versions ?? {}).filter((version) => isSemver(version));
    return versions.sort(compareVersions);
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkForUpdates(dataDir: string): Promise<UpdateInfo> {
  const cached = await readCache(dataDir);
  if (cached) return cached;

  const latestVersion = await fetchLatestVersion();
  const hasUpdate = isNewer(latestVersion, SYNTH_VERSION);

  const info: UpdateInfo = {
    currentVersion: SYNTH_VERSION,
    latestVersion,
    hasUpdate,
    checkedAt: new Date().toISOString(),
  };

  await writeCache(dataDir, info);
  return info;
}

export function checkForUpdatesBackground(dataDir: string, onUpdate?: (info: UpdateInfo) => void): void {
  checkForUpdates(dataDir)
    .then((info) => {
      if (info.hasUpdate && onUpdate) {
        onUpdate(info);
      }
    })
    .catch(() => {});
}
