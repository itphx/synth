/**
 * Обработчик enum-decision (ADR-035).
 * Проверяет, что лейбл валидный (в допустимом наборе).
 */
import type { MicroResult } from '../types.js';
import { t as sm, type SystemMessageKey } from '../../../system-messages.js';

/** Допустимые лейблы для enum-решений. */
export const VALID_LABELS = new Set([
  'yes', 'no', 'approve', 'reject',
  'mode_plan', 'mode_act',
]);

/**
 * Готовые ответы для каждого валидного лейбла (аналог small-talk).
 * Канонический текст — из словаря SystemMessages (en); локализация — через i18nKey.
 */
export const ENUM_ANSWERS: Record<string, { key: SystemMessageKey; variants: string[] }> = {
  yes: { key: 'micro.enum.yes', variants: [sm('micro.enum.yes'), 'Confirmed.', 'Accepted.'] },
  no: { key: 'micro.enum.no', variants: [sm('micro.enum.no'), 'Rejected.'] },
  approve: { key: 'micro.enum.approve', variants: [sm('micro.enum.approve'), 'Proceeding.'] },
  reject: { key: 'micro.enum.reject', variants: [sm('micro.enum.reject'), 'Cancelled.'] },
  mode_plan: { key: 'micro.enum.mode_plan', variants: [sm('micro.enum.mode_plan')] },
  mode_act: { key: 'micro.enum.mode_act', variants: [sm('micro.enum.mode_act')] },
};

export function handleEnumDecision(modelResult: MicroResult): MicroResult {
  const label = modelResult.label || '';

  if (!VALID_LABELS.has(label)) {
    // Невалидный лейбл — понижаем до UNSURE
    return {
      ...modelResult,
      status: 'UNSURE',
      confidence: 0.3,
      signals: [...modelResult.signals, `invalid_label:${label}`],
      label: undefined,
    };
  }

  // Валидный лейбл — нормализуем, генерируем осмысленный ответ и возвращаем
  const entry = ENUM_ANSWERS[label];
  const choices = entry?.variants ?? [label];
  const answer = choices[Math.floor(Math.random() * choices.length)]!;

  return {
    ...modelResult,
    answer,
    i18nKey: entry?.key,
    signals: [...modelResult.signals, `valid_enum:${label}`],
  };
}
