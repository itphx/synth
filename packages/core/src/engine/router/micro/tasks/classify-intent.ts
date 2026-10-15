/**
 * Обработчик classify-intent (ADR-035).
 * Обогащает результат модели: нормализует лейбл, добавляет описание,
 * генерирует осмысленный ответ (аналог enum-decision).
 */
import type { MicroResult } from '../types.js';
import { t as sm, type SystemMessageKey } from '../../../system-messages.js';

/** Человекочитаемые описания интентов (данные для роутера/debug). */
export const INTENT_DESCRIPTIONS: Record<string, string> = {
  question: 'Question: the user wants to learn or understand something.',
  command: 'Command: the user wants to perform an action (write, create, fix).',
  review: 'Review: the user wants to check or analyze something.',
  explain: 'Explanation: the user wants an explanation.',
  debug: 'Debug: the user hit an error or a bug.',
  fix: 'Fix: the user wants something fixed.',
  test: 'Test: the user wants to write or run tests.',
};

/**
 * Готовые ответы для валидных интентов (аналог enum-decision).
 * Канонический текст — из словаря SystemMessages (en); локализация — через i18nKey.
 */
export const CLASSIFY_ANSWERS: Record<string, { key: SystemMessageKey; variants: string[] }> = {
  question: { key: 'micro.intent.question', variants: [sm('micro.intent.question')] },
  command: { key: 'micro.intent.command', variants: [sm('micro.intent.command')] },
  review: { key: 'micro.intent.review', variants: [sm('micro.intent.review')] },
  explain: { key: 'micro.intent.explain', variants: [sm('micro.intent.explain')] },
  debug: { key: 'micro.intent.debug', variants: [sm('micro.intent.debug')] },
  fix: { key: 'micro.intent.fix', variants: [sm('micro.intent.fix')] },
  test: { key: 'micro.intent.test', variants: [sm('micro.intent.test')] },
};

export function handleClassifyIntent(modelResult: MicroResult): MicroResult {
  const label = modelResult.label || 'unknown';
  const description = INTENT_DESCRIPTIONS[label] ?? `Unknown intent: ${label}`;

  // Добавляем описание в signals для роутера (может влиять на выбор модели)
  const enrichedSignals = [...modelResult.signals, `intent:${label}`, `desc:${description}`];

  // Генерируем осмысленный ответ: интент распознан, но для полноценного
  // ответа нужен контекст (код, конкретика) — подтверждение + запрос деталей.
  const entry = CLASSIFY_ANSWERS[label];
  const choices = entry?.variants ?? [`Intent: ${label}`];
  const answer = choices[Math.floor(Math.random() * choices.length)]!;

  return {
    ...modelResult,
    answer,
    i18nKey: entry?.key,
    signals: enrichedSignals,
  };
}
