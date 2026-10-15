// Реестр «профилей серверов» для гибридного режима.
//
// Профиль — мета-информация об удалённом backend для UX (форма входа: список
// известных серверов, предзаполнение адреса, последний использованный сервер).
// У сервера НЕТ отдельного каталога данных: локальные данные всех серверов лежат
// в ЕДИНОМ dataDir процесса, credentials — в едином мульти-серверном файле
// (~/.config/synth/profiles.json; ADR-079: при `--home`/`SYNTH_HOME` —
// `<home>/profiles.json`). Сам реестр — файл
// profiles.json (права 0600, атомарная запись, как credentials):
// {
//   "version": 1,
//   "lastProfileId": "synth-k3s-itphx-loc",
//   "profiles": [
//     { "id": "synth-k3s-itphx-loc", "url": "https://synth.k3s.itphx.loc",
//       "label": "synth.k3s.itphx.loc", "lastUsedAt": "2026-09-07T10:00:00.000Z",
//       "username": "admin" }
//   ]
// }
// Путь к реестру можно переопределить (для тестов и --config).

import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, resolveProfilesPath } from '@itphx/synth-shared';

/** Версия формата файла реестра профилей. */
const PROFILES_VERSION = 1;

/** Права файла реестра профилей: только владелец (0600). */
const PROFILES_FILE_MODE = 0o600;

/** Мета-информация профиля сервера (одна запись в реестре). */
export interface ProfileMeta {
  /** Стабильный идентификатор профиля (slug url, при коллизии — с коротким хэшем). */
  id: string;
  /** Нормализованный URL удалённого backend (без завершающих /). */
  url: string;
  /** Человекочитаемое имя (hostname) для UI. */
  label?: string;
  /** ISO-метка последнего использования. */
  lastUsedAt?: string;
  /** Последний пользователь, входивший на сервер (для UI-подсказок). */
  username?: string;
}

/** Содержимое файла реестра профилей. */
export interface ProfilesFile {
  version: number;
  lastProfileId?: string | null;
  profiles: ProfileMeta[];
}

/** Обрезать завершающие слэши у адреса сервера (как normalizeBaseUrl в connection.ts). */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Путь к файлу реестра профилей. ADR-079: при заданном home — `<home>/profiles.json`,
 * иначе XDG-дефолт `~/.config/synth/profiles.json`.
 */
export function getProfilesPath(home?: string): string {
  return resolveProfilesPath(home);
}

/** Slug hostname для профиля: точки → дефисы, в нижнем регистре. */
function slugHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Hostname url для label профиля (или сам url, если url не парсится). */
function labelForUrl(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname;
  } catch {
    return normalizeUrl(url);
  }
}

/** Короткий хэш url для разрешения коллизий id (стабильный для одного url). */
function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * Чистый id профиля из url: slug hostname (точки → дефисы) + порт, если он задан
 * и не является стандартным для схемы. Коллизии между разными url с одинаковым
 * hostname здесь не учитываются — их разрешает ensureProfile (добавляет хэш).
 */
export function profileIdForUrl(url: string): string {
  const normalized = normalizeUrl(url);
  let hostname = '';
  let port = '';
  try {
    const parsed = new URL(normalized);
    hostname = parsed.hostname;
    port = parsed.port;
    const defaultPort = parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '';
    if (port && port === defaultPort) port = '';
  } catch {
    // Не URL (например, голый hostname) — берём хост-часть наивно, до / или :.
    hostname = normalized.split(/[/:]/)[0] || normalized;
    port = '';
  }
  const hostSlug = slugHostname(hostname);
  const portPart = port ? `-${port}` : '';
  return `${hostSlug}${portPart}`;
}

/** Прочитать файл реестра; при отсутствии/повреждении — пустой файл. */
async function readProfilesFile(path: string): Promise<ProfilesFile> {
  try {
    const data = await readFile(path, 'utf-8');
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Partial<ProfilesFile>;
      const version = typeof obj.version === 'number' ? obj.version : PROFILES_VERSION;
      const lastProfileId = typeof obj.lastProfileId === 'string' ? obj.lastProfileId : null;
      const profiles = Array.isArray(obj.profiles)
        ? obj.profiles.filter(
            (p): p is ProfileMeta => !!p && typeof p.id === 'string' && typeof p.url === 'string',
          )
        : [];
      return { version, lastProfileId, profiles };
    }
  } catch {
    // повреждённый JSON или ошибка чтения — пустой реестр
  }
  return { version: PROFILES_VERSION, lastProfileId: null, profiles: [] };
}

/** Записать файл реестра атомарно (tmp + rename), права 0600. */
async function writeProfilesFile(path: string, file: ProfilesFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const data = JSON.stringify(file, null, 2);
  await atomicWrite(
    (p, d) => writeFile(p, d, { encoding: 'utf-8', mode: PROFILES_FILE_MODE }),
    (o, n) => rename(o, n),
    path,
    data,
  );
}

/** Загрузить реестр (пустой файл при отсутствии/повреждении). */
export async function loadProfiles(path?: string): Promise<ProfilesFile> {
  return readProfilesFile(path ?? getProfilesPath());
}

function recencyTs(p: ProfileMeta): number {
  if (!p.lastUsedAt) return 0;
  const ts = Date.parse(p.lastUsedAt);
  return Number.isNaN(ts) ? 0 : ts;
}

/** Список профилей, отсортированный по lastUsedAt desc (свежие первыми). */
export async function listProfiles(path?: string): Promise<ProfileMeta[]> {
  const file = await readProfilesFile(path ?? getProfilesPath());
  return [...file.profiles].sort((a, b) => recencyTs(b) - recencyTs(a));
}

/** Последний использованный профиль (по lastProfileId) или null. */
export async function getLastProfile(path?: string): Promise<ProfileMeta | null> {
  const file = await readProfilesFile(path ?? getProfilesPath());
  if (!file.lastProfileId) return null;
  return file.profiles.find((p) => p.id === file.lastProfileId) ?? null;
}

/** Найти профиль по нормализованному url (без завершающего /) или null. */
export async function findProfileByUrl(url: string, path?: string): Promise<ProfileMeta | null> {
  const file = await readProfilesFile(path ?? getProfilesPath());
  const wanted = normalizeUrl(url);
  return file.profiles.find((p) => normalizeUrl(p.url) === wanted) ?? null;
}

/**
 * Уникальный id для нового профиля: base = profileIdForUrl(url); при коллизии
 * с существующим профилем (другой url, тот же id) — добавляется короткий хэш url.
 */
function uniqueProfileId(profiles: ProfileMeta[], url: string): string {
  const base = profileIdForUrl(url);
  if (!profiles.some((p) => p.id === base)) return base;
  const hash = hashUrl(url);
  let len = 8;
  let candidate = `${base}-${hash.slice(0, len)}`;
  while (profiles.some((p) => p.id === candidate) && len < hash.length) {
    len += 8;
    candidate = `${base}-${hash.slice(0, len)}`;
  }
  return candidate;
}

/**
 * Создать профиль для url, если его нет, и обновить lastUsedAt/lastProfileId
 * (атомарная запись в реестр). Файлы данных не трогает.
 */
export async function ensureProfile(
  url: string,
  opts: { username?: string; label?: string } = {},
  path?: string,
): Promise<ProfileMeta> {
  const filePath = path ?? getProfilesPath();
  const file = await readProfilesFile(filePath);
  const normalizedUrl = normalizeUrl(url);
  const now = new Date().toISOString();

  let profile = file.profiles.find((p) => normalizeUrl(p.url) === normalizedUrl) ?? null;
  if (profile) {
    profile.lastUsedAt = now;
    if (opts.username !== undefined) profile.username = opts.username;
    if (opts.label !== undefined) profile.label = opts.label;
  } else {
    profile = {
      id: uniqueProfileId(file.profiles, normalizedUrl),
      url: normalizedUrl,
      label: opts.label ?? labelForUrl(normalizedUrl),
      lastUsedAt: now,
      username: opts.username,
    };
    file.profiles.push(profile);
  }

  file.version = PROFILES_VERSION;
  file.lastProfileId = profile.id;
  await writeProfilesFile(filePath, file);
  return profile;
}

/** Удалить профиль из реестра по id или url. Каталог данных НЕ удаляется. */
export async function removeProfile(urlOrId: string, path?: string): Promise<void> {
  const filePath = path ?? getProfilesPath();
  const file = await readProfilesFile(filePath);
  const wanted = normalizeUrl(urlOrId);
  const index = file.profiles.findIndex(
    (p) => p.id === urlOrId || normalizeUrl(p.url) === wanted,
  );
  if (index === -1) return;

  const [removed] = file.profiles.splice(index, 1);
  if (removed && file.lastProfileId === removed.id) {
    file.lastProfileId = null;
  }

  if (file.profiles.length === 0) {
    await unlink(filePath).catch(() => {});
    return;
  }
  await writeProfilesFile(filePath, file);
}
