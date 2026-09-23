import { useI18nStore, formatMessage } from './store'

/**
 * Локализованная строка вне React (zustand-сторы, не-React код).
 * Читает текущий словарь/локаль из `useI18nStore`.
 */
export function i18nText(key: string): string {
  const { dictionary, locale } = useI18nStore.getState()
  return formatMessage(dictionary, key, undefined, locale)
}
