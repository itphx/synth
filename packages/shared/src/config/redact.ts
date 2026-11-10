/**
 * Редактирование секретов в дампе конфигурации (`synth config show`).
 *
 * `SynthConfig` может содержать значения секретов (`core.apiKey`,
 * `security.secretKey`, `remote.auth.apiKey`, `auth.oidc.clientSecret`,
 * `storage.postgres.password` и т.п.). Печатать такой дамп целиком нельзя:
 * это утечка в журнал/терминал/CI. Хелпер возвращает **глубокую копию** с
 * замаскированными непустыми значениями секретных ключей — исходный объект не
 * мутируется.
 *
 * Маскируются только ключи с **точным** (case-insensitive) именем из списка;
 * `timeout`, `tokenizer`, `apiKeyRoles` и другие похожие по подстроке ключи
 * остаются как есть. Значение-маска — строка `'***'`.
 */
import type { SynthConfig } from './types.js';

/** Имена ключей, значения которых считаются секретами (без учёта регистра). */
const SECRET_KEY_NAMES = new Set(
  [
    'apiKey',
    'tokenSecret',
    'secretKey',
    'password',
    'token',
    'clientSecret',
    'privateKey',
    'passphrase',
    'secret',
    'signingKey',
    'webhookSecret',
  ].map((key) => key.toLowerCase()),
);

/** Строка-маска для скрытого значения. */
const MASK = '***';

/** Непустое значение (пустая строка/пробелы, null и undefined — не секрет). */
function isNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/** Рекурсивно замаскировать секретные ключи в копии значения. */
function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      result[key] =
        SECRET_KEY_NAMES.has(key.toLowerCase()) && isNonEmpty(child)
          ? MASK
          : maskSecrets(child);
    }
    return result;
  }
  return value;
}

/**
 * Вернуть копию конфигурации с замаскированными секретами.
 *
 * Копирование — `structuredClone` (конфиг состоит из JSON-совместимых данных);
 * fallback на JSON-клон для сред без `structuredClone`.
 */
export function redactConfigSecrets(config: SynthConfig): SynthConfig {
  const clone: unknown =
    typeof structuredClone === 'function'
      ? structuredClone(config)
      : JSON.parse(JSON.stringify(config));
  return maskSecrets(clone) as SynthConfig;
}
