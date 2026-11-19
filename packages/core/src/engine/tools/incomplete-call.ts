/**
 * Обрезанный tool-call: аргументы не дописаны лимитом вывода (ADR-041).
 *
 * Паритет с opencode `tool.input-incomplete` (`publish-llm-event.ts`): когда
 * провайдер сигнализирует `finish_reason: length`/`max_tokens`, JSON аргументов
 * вызова может прийти **недописанным**. Раньше такой вызов молча получал
 * `args = {}` (`JSON.parse` падал → `{}`) и исполнялся — модель видела ошибку
 * схемы аргументов (`tool.args_error` вида `path: Required`) и повторяла тот же
 * вызов, снова упираясь в лимит: причина («ответ обрезан лимитом вывода»)
 * оставалась невысказанной.
 *
 * Теперь такой вызов **не исполняется**, а модели возвращается внятная причина
 * с подсказкой: разбить payload на меньшие вызовы и повторить с полными
 * аргументами (`tool.input_incomplete`, RU/EN — i18n ядра).
 *
 * Границы: ошибка «обрезано» ставится только при **обоих** признаках —
 * `finish_reason` лимита вывода И невалидный JSON аргументов. Полный
 * tool-call, пришедший с тем же `finish_reason` (модель дописала вызов и
 * упёрлась в лимит на тексте), исполняется как обычно.
 */
import type { ToolResult } from '@itphx/synth-shared';
import { i18n as i18nMeta, t as sm } from '../system-messages.js';
import { isOutputLimitFinish } from '../output-limit-notice.js';

/**
 * Аргументы вызова недописаны: строка не является целым JSON-объектом.
 *
 * Пустая строка тоже считается недописанной — при `finish_reason` лимита это
 * оборванный на самом начале payload, а не «вызов без аргументов» (полный
 * вызов без аргументов несёт `{}`).
 */
export function isIncompleteArguments(raw: string): boolean {
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

/**
 * Нужен ли исход «аргументы обрезаны лимитом вывода».
 *
 * `finishReason` — причина завершения **своего** шага (не хода: шаг без
 * `finish_reason` не должен наследовать `length` предыдущего шага).
 */
export function isIncompleteToolCall(
  finishReason: string | undefined | null,
  rawArguments: unknown,
): boolean {
  if (!isOutputLimitFinish(finishReason)) return false;
  if (typeof rawArguments !== 'string') return false;
  return isIncompleteArguments(rawArguments);
}

/**
 * Error-результат «аргументы обрезаны лимитом вывода»: текст для модели и
 * `metadata.i18n` строятся вместе (ADR-041 — UI локализует по ключу, при
 * отсутствии перевода деградирует на `content`).
 */
export function inputIncompleteResult(tool: string): ToolResult {
  const params = { tool };
  return {
    content: sm('tool.input_incomplete', params),
    isError: true,
    metadata: {
      i18n: i18nMeta('tool.input_incomplete', params),
      isError: true,
      input_incomplete: true,
    },
  };
}
