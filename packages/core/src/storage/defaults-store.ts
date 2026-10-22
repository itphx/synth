import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite, AsyncLock } from '@itphx/synth-shared';
import type { AppearanceDefaults, DefaultsRepository } from './ports/index.js';

// ADR-096 (W2.3): реализация перенесена из backend (`lib/defaults-store.ts`) —
// это `{dataDir}/defaults.json` + атомарная запись, без backend-специфики.
// Backend оставляет реэкспорт для обратной совместимости импортов.

/** Минимальный допустимый масштаб интерфейса. */
export const UI_SCALE_MIN = 0.5;
/** Максимальный допустимый масштаб интерфейса. */
export const UI_SCALE_MAX = 1.2;

/**
 * Валидирует масштаб интерфейса: число в диапазоне 0.5..1.2.
 * Некорректное значение → undefined (поле отбрасывается).
 */
function sanitizeScale(value: unknown): number | undefined {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= UI_SCALE_MIN &&
    value <= UI_SCALE_MAX
  ) {
    return value;
  }
  return undefined;
}

/**
 * Оставляет только валидные поля умолчаний оформления: locale ru/en,
 * themeMode system/light/dark, theme — непустая строка, uiScaleMobile и
 * uiScaleDesktop — каждое независимо число в диапазоне 0.5..1.2.
 * Некорректные поля отбрасываются (без исключений).
 */
function sanitize(raw: unknown): AppearanceDefaults {
  if (typeof raw !== 'object' || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: AppearanceDefaults = {};

  if (src.locale === 'ru' || src.locale === 'en') {
    out.locale = src.locale;
  }
  if (src.themeMode === 'system' || src.themeMode === 'light' || src.themeMode === 'dark') {
    out.themeMode = src.themeMode;
  }
  if (typeof src.theme === 'string' && src.theme.trim() !== '') {
    out.theme = src.theme;
  }
  const mobile = sanitizeScale(src.uiScaleMobile);
  if (mobile !== undefined) {
    out.uiScaleMobile = mobile;
  }
  const desktop = sanitizeScale(src.uiScaleDesktop);
  if (desktop !== undefined) {
    out.uiScaleDesktop = desktop;
  }

  return out;
}

/**
 * Файловая реализация порта умолчаний оформления
 * (locale/themeMode/theme/uiScaleMobile/uiScaleDesktop) для всех пользователей.
 *
 * Хранятся одним JSON-файлом `{dataDir}/defaults.json`. Запись атомарная:
 * временный файл `.tmp.{uuid}` → `rename()`. Значения переживают рестарт.
 */
export class DefaultsStore implements DefaultsRepository {
  private _lock = new AsyncLock();

  constructor(private _opts: { dataDir: string }) {}

  private _filePath(): string {
    return join(this._opts.dataDir, 'defaults.json');
  }

  async loadDefaults(): Promise<AppearanceDefaults> {
    try {
      const data = await readFile(this._filePath(), 'utf-8');
      return sanitize(JSON.parse(data));
    } catch {
      return {};
    }
  }

  async saveDefaults(patch: AppearanceDefaults): Promise<AppearanceDefaults> {
    await this._lock.acquire();
    try {
      const current = await this.loadDefaults();
      const next = { ...current, ...sanitize(patch) };

      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        JSON.stringify(next, null, 2),
      );

      return next;
    } finally {
      this._lock.release();
    }
  }
}
