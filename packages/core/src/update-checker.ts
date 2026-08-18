import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SYNTH_VERSION } from '@itphx/synth-shared';

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  checkedAt: string;
}

const NPM_REGISTRY = 'https://registry.npmjs.org/@itphx/synth/latest';
const CACHE_FILE = 'update-check.json';
const TTL_MS = 6 * 60 * 60 * 1000;

function parseVersion(version: string): [number, number, number] {
  const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
  return [major || 0, minor || 0, patch || 0];
}

function isNewer(latest: string, current: string): boolean {
  const [lMaj, lMin, lPatch] = parseVersion(latest);
  const [cMaj, cMin, cPatch] = parseVersion(current);

  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPatch > cPatch;
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

async function fetchLatestVersion(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(NPM_REGISTRY, {
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
