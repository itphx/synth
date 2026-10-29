import type { MessageI18n } from '@itphx/synth-shared';
import { ENGINE_MESSAGE_PARAMS } from '@itphx/synth-shared/i18n';

import { formatMessage, type I18nDictionary, type I18nParams } from './store';
import type { Locale } from './runtime';

/**
 * Проверка, что metadata.i18n — валидная структура { key, params? } (контракт
 * @itphx/synth-shared MessageI18n). Читается из Record<string, unknown>
 * (message.metadata / tool_result.metadata), поэтому валидируется мягко.
 */
export function isValidI18nMeta(meta: unknown): meta is MessageI18n {
  if (!meta || typeof meta !== 'object') return false;
  const candidate = meta as Partial<MessageI18n>;
  return typeof candidate.key === 'string' && candidate.key.length > 0;
}

/**
 * Все ли обязательные параметры движкового ключа переданы.
 *
 * Контракт `ENGINE_MESSAGE_PARAMS` (`@itphx/synth-shared/i18n`) знает набор
 * `{param}` для каждого ключа ядра. Ключи вне контракта (UI-ключи) сюда не
 * относятся — для них поведение прежнее (`true`).
 */
function hasRequiredParams(key: string, params: I18nParams | undefined): boolean {
  if (!Object.prototype.hasOwnProperty.call(ENGINE_MESSAGE_PARAMS, key)) return true;
  const required = ENGINE_MESSAGE_PARAMS[key as keyof typeof ENGINE_MESSAGE_PARAMS];
  return required.every((name) => {
    const value = params?.[name];
    return value !== null && value !== undefined;
  });
}

/**
 * Резолвит текст системного сообщения ядра по metadata.i18n.
 *
 * Схема «LLM = один язык / UI = локализация» (ADR-041): content — en-текст от
 * движка, metadata.i18n = { key, params } — ключ в словаре UI.
 *
 * - ключ найден в словаре текущей locale → перевод с интерполяцией {param};
 * - ключа нет (в т.ч. locale=en — core-ключи не дублируются в en.ts) → content;
 * - у движкового ключа не хватает обязательного параметра → content: `content`
 *   по контракту ADR-041 — полный текст, поэтому он лучше шаблона с сырым
 *   `{param}`, который renderTemplate оставляет как есть.
 *
 * Проверка через hasOwnProperty: ключи вроде 'toString' не должны проходить
 * как «найденные» через прототип объекта-словаря.
 */
export function resolveI18n(
  i18nMeta: MessageI18n | unknown,
  content: string,
  dictionary: I18nDictionary,
  locale?: Locale,
): string {
  if (!isValidI18nMeta(i18nMeta)) return content;
  if (!hasRequiredParams(i18nMeta.key, i18nMeta.params as I18nParams | undefined)) return content;
  if (!Object.prototype.hasOwnProperty.call(dictionary, i18nMeta.key)) return content;
  return formatMessage(dictionary, i18nMeta.key, i18nMeta.params as I18nParams | undefined, locale);
}
