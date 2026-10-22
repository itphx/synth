/**
 * Порт `defaults` (умолчания оформления) PostgreSQL-драйвера
 * (ADR-097, волна 3b).
 *
 * Эталон семантики — `DefaultsStore`/`MemoryDefaultsRepository`: `loadDefaults`
 * на пустом сторе — `{}`; `saveDefaults` — частичный патч, сливается поверх
 * текущих значений; некорректные поля отбрасываются (санитизация). Санитизация
 * воспроизводится локально: core не экспортирует хелпер, а поведение обязано
 * совпадать с файловой реализацией.
 *
 * Хранение — ключ `defaults` в таблице `settings` (`jsonb`). Read-modify-write
 * (как в файловой реализации) выполняется в транзакции с блокировкой строки.
 */

import type { AppearanceDefaults, StorageContext } from '@itphx/synth-core';
import type { PostgresExecutor } from '../pool.js';
import type { PostgresConnection } from '../pool.js';
import { readSetting, writeSetting } from './principals-shared.js';

type DefaultsPort = StorageContext['defaults'];

/** Ключ секции умолчаний оформления в таблице `settings`. */
export const DEFAULTS_SETTINGS_KEY = 'defaults';

/** Минимальный/максимальный допустимый масштаб интерфейса (паритет `DefaultsStore`). */
const UI_SCALE_MIN = 0.5;
const UI_SCALE_MAX = 1.2;

/** Масштаб интерфейса: число в диапазоне 0.5..1.2, иначе `undefined`. */
function sanitizeScale(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= UI_SCALE_MIN && value <= UI_SCALE_MAX) {
    return value;
  }
  return undefined;
}

/** Оставить только валидные поля умолчаний оформления (паритет `DefaultsStore`). */
function sanitize(raw: unknown): AppearanceDefaults {
  if (typeof raw !== 'object' || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: AppearanceDefaults = {};

  if (src.locale === 'ru' || src.locale === 'en') out.locale = src.locale;
  if (src.themeMode === 'system' || src.themeMode === 'light' || src.themeMode === 'dark') {
    out.themeMode = src.themeMode;
  }
  if (typeof src.theme === 'string' && src.theme.trim() !== '') out.theme = src.theme;
  const mobile = sanitizeScale(src.uiScaleMobile);
  if (mobile !== undefined) out.uiScaleMobile = mobile;
  const desktop = sanitizeScale(src.uiScaleDesktop);
  if (desktop !== undefined) out.uiScaleDesktop = desktop;

  return out;
}

/** Прочитать умолчания оформления (без блокировки — чтение). */
async function readDefaults(exec: PostgresExecutor): Promise<AppearanceDefaults> {
  return sanitize(await readSetting(exec, DEFAULTS_SETTINGS_KEY));
}

/** Собрать порт умолчаний оформления поверх SQL. */
export function createPrincipalDefaultsPort(conn: PostgresConnection): DefaultsPort {
  return {
    async loadDefaults(): Promise<AppearanceDefaults> {
      return readDefaults(conn);
    },

    async saveDefaults(patch: AppearanceDefaults): Promise<AppearanceDefaults> {
      return conn.withTransaction(async (tx) => {
        // Блокируем строку секции, чтобы конкурентный патч не потерялся (как AsyncLock в файловой реализации).
        const rows = await tx.query<{ value: unknown }>(
          'SELECT value FROM settings WHERE key = $1 FOR UPDATE',
          [DEFAULTS_SETTINGS_KEY],
        );
        const next: AppearanceDefaults = { ...sanitize(rows[0]?.value), ...sanitize(patch) };
        await writeSetting(tx, DEFAULTS_SETTINGS_KEY, next);
        return next;
      });
    },
  };
}
