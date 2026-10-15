// Хранилище credentials для гибридного режима (ADR-005: атомарная запись tmp + rename).
//
// Файл credentials — JSON-объект Record<backendUrl, RemoteCredentials>:
// {
//   "https://synth.k3s.itphx.loc": {
//     "backendUrl": "https://synth.k3s.itphx.loc",
//     "accessToken": "...",
//     "refreshToken": "...",
//     "expiresAt": "2026-09-01T00:00:00.000Z",
//     "user": { "id": "...", "username": "admin", "roles": ["ADMIN"] }
//   }
// }
// Один файл может хранить credentials для нескольких backend-серверов.
// По умолчанию путь — ~/.config/synth/credentials.json; ADR-079: при
// `--home`/`SYNTH_HOME` — `<home>/credentials.json`.

import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite, resolveCredentialsPath } from '@itphx/synth-shared';
import type { RemoteCredentials } from './types.js';

/** Права файла credentials: только владелец (0600). */
const CREDENTIALS_FILE_MODE = 0o600;

type CredentialsFile = Record<string, RemoteCredentials>;

/**
 * Путь к файлу credentials. ADR-079: при заданном home — `<home>/credentials.json`,
 * иначе XDG-дефолт `~/.config/synth/credentials.json`.
 */
export function defaultCredentialsPath(home?: string): string {
  return resolveCredentialsPath(home);
}

async function readCredentialsFile(path: string): Promise<CredentialsFile> {
  try {
    const data = await readFile(path, 'utf-8');
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CredentialsFile;
    }
    return {};
  } catch {
    return {};
  }
}

async function writeCredentialsFile(path: string, file: CredentialsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const data = JSON.stringify(file, null, 2);
  await atomicWrite(
    (p, d) => writeFile(p, d, { encoding: 'utf-8', mode: CREDENTIALS_FILE_MODE }),
    (o, n) => rename(o, n),
    path,
    data,
  );
}

/**
 * Загрузить credentials для backendUrl.
 * Возвращает null, если файл отсутствует/повреждён или сохранённый backendUrl не совпадает.
 */
export async function loadCredentials(backendUrl: string, path?: string): Promise<RemoteCredentials | null> {
  const file = await readCredentialsFile(path ?? defaultCredentialsPath());
  const entry = file[backendUrl];
  if (!entry) return null;
  if (entry.backendUrl !== backendUrl) return null;
  return entry;
}

/** Сохранить credentials (дозапись в общий файл, атомарно, права 0600). */
export async function saveCredentials(creds: RemoteCredentials, path?: string): Promise<void> {
  const filePath = path ?? defaultCredentialsPath();
  const file = await readCredentialsFile(filePath);
  file[creds.backendUrl] = creds;
  await writeCredentialsFile(filePath, file);
}

/** Список backendUrl, для которых сохранены credentials (порядок файла). */
export async function listCredentials(path?: string): Promise<string[]> {
  const file = await readCredentialsFile(path ?? defaultCredentialsPath());
  return Object.keys(file);
}

/** Удалить credentials для backendUrl. Если записей не осталось — удалить файл. */
export async function clearCredentials(backendUrl: string, path?: string): Promise<void> {
  const filePath = path ?? defaultCredentialsPath();
  const file = await readCredentialsFile(filePath);
  if (!file[backendUrl]) return;
  delete file[backendUrl];
  const remaining = Object.keys(file).length;
  if (remaining === 0) {
    await unlink(filePath).catch(() => {});
    return;
  }
  await writeCredentialsFile(filePath, file);
}
