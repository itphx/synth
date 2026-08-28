import { useI18nStore } from './store';
import { resolveI18n } from './resolveI18n';

/**
 * Хук: возвращает резолвер (i18nMeta, content) => локализованный текст
 * для текущей locale UI. Dictionary берётся из useI18nStore — та же точка,
 * что и у formatMessage во всём UI (localStorage synth-ui.i18n.v1).
 */
export function useResolveI18n(): (i18nMeta: unknown, content: string) => string {
  const dictionary = useI18nStore((state) => state.dictionary);
  return (i18nMeta: unknown, content: string) => resolveI18n(i18nMeta, content, dictionary);
}
