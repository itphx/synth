/**
 * ADR-041 × continuation: служебное сообщение «ответ обрезан лимитом вывода».
 *
 * Когда финальный ответ провайдер завершил по `finish_reason: length`
 * (нормализованный `max_tokens`), ответ **не** считается финальным: модели
 * отдаётся инструкция продолжить, разбив работу на меньшие части (паритет с
 * opencode `session/runner/llm.ts`: `CONTINUE_AFTER_OUTPUT_LIMIT`).
 *
 * Текст — **системным контекстным файлом** `prompts/system/OUTPUT_LIMIT.{lang}.md`
 * (раздел «Контекст → Системные»), а не i18n-ключом: прецедент — шаблон
 * `ATTACHMENTS_DROPPED` (ADR-115), это шаблон сообщения модели, а не постоянный
 * блок промпта. Геттер — `ContextFileRepository.getOutputLimitNotice`;
 * плейсхолдеры `{attempt}`, `{max}`, `{limit}`, `{reasoning}` подставляются
 * здесь (split/join — безопасно для `$`-символов), как `{items}` у вложений.
 *
 * Сообщение — служебное (`role: 'user'`, `author: 'System'`,
 * `metadata.type: 'output_limit_notice'`): оно видно модели и в ленте, но не
 * считается репликой человека (`sessions/user-messages.ts`), не открывает ход
 * пользователя и не попадает в текст результата для родителя.
 */

import type { ContextFileRepository } from '../storage/ports/context-file-repository.js';

/** `metadata.type` служебного сообщения продолжения. */
export const OUTPUT_LIMIT_NOTICE_TYPE = 'output_limit_notice';

/**
 * Сколько продолжений разрешено подряд. 2 продолжения = не более **3**
 * assistant-сообщений с `finish: 'length'` (текущее + два продолжения): на
 * третьем обрезанном ответе ход/прогон завершается исходом `output_limit`.
 */
export const MAX_OUTPUT_LIMIT_CONTINUATIONS = 2;

/** Предел серии обрезанных ответов (`продолжений + 1`). */
export const MAX_OUTPUT_LIMIT_STREAK = MAX_OUTPUT_LIMIT_CONTINUATIONS + 1;

/** Параметры подстановки в шаблон инструкции. */
export interface OutputLimitNoticeParams {
  /** Номер продолжения (1…max). */
  attempt: number;
  /** Максимум продолжений. */
  max: number;
  /** Фактический расход вывода (токенов). */
  limit?: number;
  /** Сколько вывода ушло на размышления. */
  reasoning?: number;
}

/**
 * Резервный текст, если шаблона нет (кастомная сборка без `prompts/`).
 * Формулировки совпадают с `prompts/system/OUTPUT_LIMIT.{lang}.md`.
 */
const FALLBACK_NOTICE: Record<'ru' | 'en', string> = {
  ru: '[OUTPUT LIMIT] Ответ упёрся в лимит вывода (stop reason: length) — продолжение {attempt} из {max}. '
    + 'Потрачено {limit} токенов вывода, из них на размышления {reasoning}. '
    + 'Не извиняйся, не пересказывай и не повторяйся — разбей оставшуюся работу на меньшие части.',
  en: '[OUTPUT LIMIT] Your response hit the output token limit (stop reason: length) — continuation {attempt} of {max}. '
    + 'Spent {limit} output tokens, of which {reasoning} were spent on reasoning. '
    + 'Do not apologize, recap, or repeat yourself — break the remaining work into smaller parts.',
};

/** `{key}` → значение (split/join: безопасно для `$` в значениях). */
function subst(template: string, params: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(params)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

/**
 * Текст инструкции продолжения: шаблон из `prompts/system/OUTPUT_LIMIT.{lang}.md`
 * (с пользовательским override) либо технический фоллбэк, если шаблона нет.
 */
export function buildOutputLimitNotice(
  source: Pick<ContextFileRepository, 'getOutputLimitNotice'> | null | undefined,
  language: string,
  params: OutputLimitNoticeParams,
): string {
  const values: Record<string, string> = {
    attempt: String(params.attempt),
    max: String(params.max),
    limit: String(params.limit ?? 0),
    reasoning: String(params.reasoning ?? 0),
  };
  let template = '';
  try {
    template = source?.getOutputLimitNotice?.(language) ?? '';
  } catch {
    // fail-open: шаблон не должен ломать ход
  }
  if (template.trim() === '') {
    template = language === 'en' ? FALLBACK_NOTICE.en : FALLBACK_NOTICE.ru;
  }
  return subst(template, values);
}

/**
 * Ответ срезан лимитом вывода (`max_tokens` у Anthropic/OpenAI, `length` у
 * части API/Ollama — оба нормализованы в `LlmFinishReason`).
 */
export function isOutputLimitFinish(finishReason: string | undefined | null): boolean {
  return finishReason === 'max_tokens' || finishReason === 'length';
}
