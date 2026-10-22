/**
 * Общие примитивы PostgreSQL-реализации портов группы `events` (ADR-097, волна 3b).
 *
 * Здесь только то, что переиспользуют файлы `events-*.ts`: ленивая загрузка core
 * (доменные ошибки, крипто-хелперы), хелперы дат/чисел и деталь отображения
 * секрета. Доменные типы берутся напрямую из `@itphx/synth-shared` (обычная
 * зависимость драйвера, ADR-097), типы портов core — `import type` в файлах-группах.
 */

import { PostgresUniqueViolationError } from '../errors.js';

/** Длина видимой части секрета в `prefix` (`synth_evt_abcd…`/`whsec_abcd…`) — деталь отображения. */
export const SECRET_PREFIX_VISIBLE = 12;

// ── Ленивая загрузка core (доменные ошибки + крипто-хелперы) ─────────────────

type CoreModule = typeof import('@itphx/synth-core');

let corePromise: Promise<CoreModule> | null = null;

/**
 * Ленивая загрузка `@itphx/synth-core`.
 *
 * Верхнеуровневый runtime-импорт core драйверу запрещён (ADR-097): core —
 * `peerDependency`, а статический импорт не должен тянуть ядро при загрузке
 * модуля драйвера (цикл core ↔ драйвер). Используется только внутри
 * async-методов — для доменных классов ошибок (`EventApiKeyConflictError`,
 * `WebhookConflictError`) и крипто-хелперов webhooks. Промис кэшируется; при
 * ошибке кэш сбрасывается, чтобы следующий вызов повторил попытку.
 */
export function loadCore(): Promise<CoreModule> {
  if (!corePromise) {
    corePromise = import('@itphx/synth-core').catch((err: unknown) => {
      corePromise = null;
      throw err;
    });
  }
  return corePromise;
}

// ── Хелперы ──────────────────────────────────────────────────────────────────

/** `timestamptz`/ISO → ISO-8601; `null`/`undefined` → `undefined`. */
export function toIso(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : String(value);
}

/** Обязательная дата: `null` недопустим (для `NOT NULL timestamptz`). */
export function toIsoRequired(value: unknown): string {
  return toIso(value) ?? new Date().toISOString();
}

/** `int8`/`int4`/numeric → число; `null` → `undefined`. */
export function toInt(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Убирает ключи со значением `undefined` — чистое доменное представление. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

/** Нарушение уникальности PG (в т.ч. `lower(label)`-индекс) → доменный конфликт. */
export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof PostgresUniqueViolationError) return true;
  return (
    typeof err === 'object'
    && err !== null
    && (err as { code?: unknown }).code === 'STORAGE_POSTGRES_UNIQUE_VIOLATION'
  );
}

/** Дни retention → SQL-выражение `now() - interval` (общий для журналов). */
export function retentionCutoffExpr(param = '$1'): string {
  return `now() - interval '1 day' * ${param}::double precision`;
}
