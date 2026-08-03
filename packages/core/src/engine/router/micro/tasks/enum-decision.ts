/**
 * Обработчик enum-decision (AD-035).
 * Проверяет, что лейбл валидный (в допустимом наборе).
 */
import type { MicroResult } from '../types.js';

/** Допустимые лейблы для enum-решений. */
const VALID_LABELS = new Set([
  'yes', 'no', 'approve', 'reject',
  'mode_plan', 'mode_act',
]);

/** Готовые ответы для каждого валидного лейбла (аналог small-talk). */
const ENUM_ANSWERS: Record<string, string[]> = {
  yes: ['Да.', 'Подтверждено.', 'Принято.'],
  no: ['Нет.', 'Отклонено.'],
  approve: ['Утверждено.', 'Продолжаем.'],
  reject: ['Отклонено.', 'Отменено.'],
  mode_plan: ['Переключаюсь в режим планирования. Исследую и составляю план.'],
  mode_act: ['Переключаюсь в рабочий режим. Выполняю.'],
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
  const choices = ENUM_ANSWERS[label] ?? [`${label}`];
  const answer = choices[Math.floor(Math.random() * choices.length)]!;

  return {
    ...modelResult,
    answer,
    signals: [...modelResult.signals, `valid_enum:${label}`],
  };
}
