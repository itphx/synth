/**
 * Умолчания оформления (locale/тема/масштаб UI).
 *
 * Тип объявлен здесь как доменный контракт порта: интерфейс — в core
 * (`DefaultsRepository`), реализация — в backend (`DefaultsStore`), поэтому
 * общий тип не должен жить ни в реализации, ни в UI.
 */
export interface AppearanceDefaults {
  locale?: 'ru' | 'en';
  themeMode?: 'system' | 'light' | 'dark';
  theme?: string;
  uiScaleMobile?: number;
  uiScaleDesktop?: number;
  /** Вид ленты чата по умолчанию (`detailed` — пузырь ответа, `feed` — плоская проза). */
  chatViewMode?: 'detailed' | 'feed';
  /** Плотность ленты чата по умолчанию (`compact` — прошлые ходы свёрнуты). */
  chatDensity?: 'normal' | 'compact';
  /**
   * Масштаб области чата по умолчанию (множитель поверх общего масштаба UI).
   * Диапазон — `0.75…1.5`; мобильный минимум `0.85` применяется на клиенте.
   */
  chatScaleMobile?: number;
  /** Масштаб области чата по умолчанию на десктопе. */
  chatScaleDesktop?: number;
}

/**
 * Порт умолчаний оформления инстанса (реализация — backend `DefaultsStore`).
 *
 * `saveDefaults` — частичный патч, сливается поверх текущих значений;
 * валидацию полей выполняет реализация (некорректные отбрасываются).
 */
export interface DefaultsRepository {
  loadDefaults(): Promise<AppearanceDefaults>;
  saveDefaults(patch: AppearanceDefaults): Promise<AppearanceDefaults>;
}
