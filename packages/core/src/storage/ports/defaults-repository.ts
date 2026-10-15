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
