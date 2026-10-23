import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from '@itphx/synth-shared';
import {
  MASTER_KEY_LENGTH,
  clearMasterKeyCache,
  decodeMasterKey,
  masterKeyFilePath,
  readMasterKeyFile,
} from './crypto.js';
import { SSHKeyStore, type RotateMasterKeyResult } from '../storage/ssh-key-store.js';
import { ExternalCredentialStore } from '../storage/external-credential-store.js';
import type { RotateExternalCredentialKeyResult } from '../storage/ports/external-credential-repository.js';

/**
 * ADR-076/ADR-105: one-shot ротация мастер-ключа шифрования секретов.
 *
 * Хелпер не читает `$SYNTH_DATA_DIR` в обход стора: перешифровка идёт
 * через `store.rotateMasterKey` (атомарные записи), а файл
 * `{dataDir}/secrets/master.key` перезаписывается тем же форматом, что и
 * `resolveMasterKey` (0600, каталог 0700, tmp→rename).
 *
 * Перешифровываются **две** точки: SSH-ключи агентов (ADR-076) и внешние
 * доступы к коннекторам (ADR-105 Ф4: `secretEnc`/`refreshEnc`).
 */

export type MasterKeyRotationErrorCode =
  | 'master_key_missing'
  | 'key_conflict'
  | 'key_file_read_failed'
  | 'invalid_key';

/** Типизированная ошибка ротации мастер-ключа (сообщения без утечки материала ключа). */
export class MasterKeyRotationError extends Error {
  constructor(
    readonly code: MasterKeyRotationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MasterKeyRotationError';
  }
}

export interface RotateSecretsMasterKeyOptions {
  dataDir: string;
  /** Явный старый мастер-ключ (base64 32 Б / hex 64); приоритетнее env/config/файла. */
  oldKey?: string;
  /** Файл со старым мастер-ключом (альтернатива `oldKey`). */
  oldKeyFile?: string;
  /** Явный новый мастер-ключ; пусто — сгенерировать случайные 32 байта. */
  newKey?: string;
  /** Файл с новым мастер-ключом (альтернатива `newKey`). */
  newKeyFile?: string;
  /** Эффективный ключ из env/config (`resolveSecretKey`); пусто — файл `master.key`. */
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
  /** Предпросмотр: счётчики считаются, ничего не пишется. */
  dryRun?: boolean;
}

export type MasterKeySource = 'explicit' | 'env' | 'config' | 'file';

export interface RotateSecretsMasterKeyResult extends RotateMasterKeyResult {
  dryRun: boolean;
  oldKeySource: MasterKeySource;
  newKeySource: 'explicit' | 'generated';
  /** Предупреждения для показа пользователю (ключ из env/config и т.п.). */
  warnings: string[];
  /** Сводка по внешним доступам (ADR-105 Ф4): те же счётчики, что и по SSH-ключам. */
  credentials: RotateExternalCredentialKeyResult;
}

/**
 * Ротация мастер-ключа секретов (SSH-ключи + внешние доступы).
 *
 * Старый ключ: явный материал (`oldKey`/`oldKeyFile`) → env `SYNTH_SECRET_KEY`/
 * `secretKey` (env/config) → файл `{dataDir}/secrets/master.key`. Отсутствие
 * файла — явная ошибка (`master_key_missing`), НЕ генерация нового ключа.
 * Новый ключ: явный материал либо `randomBytes(32)`.
 *
 * Порядок: сначала **preflight обеих точек** (сухой прогон — план без записи):
 * запись, которая не расшифровывается ни старым, ни новым ключом, прерывает
 * операцию ДО первой записи. Затем перешифровка SSH-ключей и внешних доступов,
 * и только потом — перезапись файла `master.key` (0600) и сброс кэша
 * мастер-ключа. Если эффективный ключ задан через env/config, файл всё равно
 * пишется, но добавляется предупреждение: при старте он будет проигнорирован —
 * ключ нужно обновить в env/config.
 */
export async function rotateSecretsMasterKey(
  opts: RotateSecretsMasterKeyOptions,
): Promise<RotateSecretsMasterKeyResult> {
  const env = opts.env ?? process.env;
  const dryRun = !!opts.dryRun;

  const { material: oldMaterial, source: oldKeySource } = await resolveOldKeyMaterial(opts, env);
  const oldKey = decodeKey(oldMaterial, 'старого');

  const newMaterial = await resolveMaterial(opts.newKey, opts.newKeyFile, 'нового');
  const newKey = newMaterial ? decodeKey(newMaterial, 'нового') : randomBytes(MASTER_KEY_LENGTH);
  const newKeySource: 'explicit' | 'generated' = newMaterial ? 'explicit' : 'generated';

  const warnings: string[] = [];
  if (oldKeySource === 'env' || oldKeySource === 'config') {
    const where = oldKeySource === 'env' ? 'env SYNTH_SECRET_KEY' : 'config.security.secretKey';
    warnings.push(
      `Эффективный мастер-ключ задан через ${where}; файл ${masterKeyFilePath(opts.dataDir)} будет записан, но при старте проигнорирован — обновите ключ в ${where}.`,
    );
  }
  if (oldKey.equals(newKey)) {
    warnings.push('Новый ключ совпадает со старым — ротация не требуется.');
  }

  // ADR-096 (W2.4): конструирование намеренно — one-shot утилита ротации
  // работает по явному `--data-dir` вне жизненного цикла инстанса (нет
  // собранного `StorageContext`, ротация запускается из CLI/скрипта).
  const sshStore = new SSHKeyStore({ dataDir: opts.dataDir });
  const credentialStore = new ExternalCredentialStore({ dataDir: opts.dataDir });

  // Preflight обеих точек ДО первой записи: сухой прогон считает план и
  // проверяет, что каждая запись расшифровывается новым либо старым ключом.
  // Иначе частичная ротация оставила бы данные нечитаемыми (в `master.key`
  // ещё старый ключ).
  const sshPlan = await sshStore.rotateMasterKey(oldKey, newKey, { dryRun: true });
  const credentialPlan = await credentialStore.rotateMasterKey(oldKey, newKey, { dryRun: true });

  if (dryRun) {
    return {
      ...sshPlan,
      credentials: credentialPlan,
      dryRun: true,
      oldKeySource,
      newKeySource,
      warnings,
    };
  }

  const summary = await sshStore.rotateMasterKey(oldKey, newKey);
  const credentialSummary = await credentialStore.rotateMasterKey(oldKey, newKey);

  await writeMasterKeyFile(opts.dataDir, newKey);
  clearMasterKeyCache();

  return {
    ...summary,
    credentials: credentialSummary,
    dryRun,
    oldKeySource,
    newKeySource,
    warnings,
  };
}

async function resolveOldKeyMaterial(
  opts: RotateSecretsMasterKeyOptions,
  env: NodeJS.ProcessEnv,
): Promise<{ material: string; source: MasterKeySource }> {
  const explicit = await resolveMaterial(opts.oldKey, opts.oldKeyFile, 'старого');
  if (explicit) return { material: explicit, source: 'explicit' };

  const secretKey = opts.secretKey?.trim();
  if (secretKey) return { material: secretKey, source: 'config' };

  const envKey = env.SYNTH_SECRET_KEY?.trim();
  if (envKey) return { material: envKey, source: 'env' };

  const fileKey = await readMasterKeyFile(opts.dataDir);
  if (!fileKey) {
    throw new MasterKeyRotationError(
      'master_key_missing',
      `Мастер-ключ не найден: ${masterKeyFilePath(opts.dataDir)}. Ротация без исходного ключа невозможна (укажите --old-key/--old-key-file).`,
    );
  }
  return { material: fileKey.toString('base64'), source: 'file' };
}

/** Единый резолвинг материала ключа из пары «значение/файл» (обе заданы — конфликт). */
async function resolveMaterial(
  value: string | undefined,
  file: string | undefined,
  label: string,
): Promise<string | null> {
  const direct = value?.trim();
  const filePath = file?.trim();
  if (direct && filePath) {
    throw new MasterKeyRotationError(
      'key_conflict',
      `Для ${label} ключа укажите что-то одно: значение или файл.`,
    );
  }
  if (direct) return direct;
  if (!filePath) return null;
  const raw = await readFile(filePath, 'utf-8').catch(() => null);
  if (raw === null) {
    throw new MasterKeyRotationError(
      'key_file_read_failed',
      `Не удалось прочитать файл ${label} ключа: ${filePath}`,
    );
  }
  const material = raw.trim();
  if (!material) {
    throw new MasterKeyRotationError(
      'key_file_read_failed',
      `Файл ${label} ключа пуст: ${filePath}`,
    );
  }
  return material;
}

function decodeKey(material: string, label: string): Buffer {
  try {
    return decodeMasterKey(material);
  } catch {
    throw new MasterKeyRotationError(
      'invalid_key',
      `Неверный формат ${label} мастер-ключа (нужно 32 байта base64 или 64 hex-символа).`,
    );
  }
}

/** Атомарная запись `master.key` (0600, каталог 0700) — формат `resolveMasterKey`. */
async function writeMasterKeyFile(dataDir: string, key: Buffer): Promise<void> {
  const filePath = masterKeyFilePath(dataDir);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  await atomicWrite(
    (p, d) => writeFile(p, d, { encoding: 'utf-8', mode: 0o600 }),
    (o, n) => rename(o, n),
    filePath,
    key.toString('base64'),
  );
  await chmod(filePath, 0o600);
}
