import { useI18nStore, formatMessage, type I18nParams } from './store'

/**
 * Локализованная строка вне React (zustand-сторы, не-React код).
 * Читает текущий словарь/локаль из `useI18nStore`.
 *
 * `params` — подстановка `{name}` в шаблон (как в `t()` из `useI18n`).
 */
export function i18nText(key: string, params?: I18nParams): string {
  const { dictionary, locale } = useI18nStore.getState()
  return formatMessage(dictionary, key, params, locale)
}
