/**
 * Встроенные умолчания оформления инстанса — один источник для standalone
 * (core) и managed (backend).
 *
 * Значения совпадают с тем, что UI использует по умолчанию
 * (`packages/ui/src/lib/defaults.ts` + `uiScale.ts`). `null` — «умолчание не
 * задано»: клиент берёт собственный встроенный дефолт.
 *
 * Вынесено в core, чтобы `GET /auth/defaults` в standalone и в backend
 * отвечал одинаково (раньше объект жил только в backend, а standalone
 * отвечал 404 и UI писал ошибку в консоль на экране входа).
 */
import type { AppearanceDefaults, DefaultsRepository } from '../storage/ports/index.js';

/** Встроенные умолчания оформления (без `locale` — он приходит от вызывающего). */
export interface BuiltInAppearanceDefaults {
  themeMode: 'system' | 'light' | 'dark';
  theme: string;
  uiScaleMobile: number | null;
  uiScaleDesktop: number | null;
  chatViewMode: 'detailed' | 'feed' | null;
  chatDensity: 'normal' | 'compact' | null;
  chatScaleMobile: number | null;
  chatScaleDesktop: number | null;
}

/** Ответ `GET /auth/defaults`: встроенные умолчания + сохранённые поверх. */
export type ResolvedAppearanceDefaults = BuiltInAppearanceDefaults & {
  locale: 'ru' | 'en';
};

export const BUILT_IN_APPEARANCE_DEFAULTS: BuiltInAppearanceDefaults = {
  themeMode: 'system',
  theme: 'synthesis',
  uiScaleMobile: null,
  uiScaleDesktop: null,
  chatViewMode: null,
  chatDensity: null,
  chatScaleMobile: null,
  chatScaleDesktop: null,
};

/**
 * Эффективные умолчания оформления: сохранённые значения перекрывают
 * встроенные; `locale` по умолчанию — аргумент (standalone — `ru`,
 * backend — язык инстанса из i18n-конфига). Нет стора — только встроенные.
 */
export async function resolveAppearanceDefaults(
  defaultsStore: DefaultsRepository | null | undefined,
  locale: 'ru' | 'en' = 'ru',
): Promise<ResolvedAppearanceDefaults> {
  const stored: AppearanceDefaults = defaultsStore ? await defaultsStore.loadDefaults() : {};
  return {
    locale: stored.locale ?? locale,
    themeMode: stored.themeMode ?? BUILT_IN_APPEARANCE_DEFAULTS.themeMode,
    theme: stored.theme ?? BUILT_IN_APPEARANCE_DEFAULTS.theme,
    uiScaleMobile: stored.uiScaleMobile ?? BUILT_IN_APPEARANCE_DEFAULTS.uiScaleMobile,
    uiScaleDesktop: stored.uiScaleDesktop ?? BUILT_IN_APPEARANCE_DEFAULTS.uiScaleDesktop,
    chatViewMode: stored.chatViewMode ?? BUILT_IN_APPEARANCE_DEFAULTS.chatViewMode,
    chatDensity: stored.chatDensity ?? BUILT_IN_APPEARANCE_DEFAULTS.chatDensity,
    chatScaleMobile: stored.chatScaleMobile ?? BUILT_IN_APPEARANCE_DEFAULTS.chatScaleMobile,
    chatScaleDesktop: stored.chatScaleDesktop ?? BUILT_IN_APPEARANCE_DEFAULTS.chatScaleDesktop,
  };
}
