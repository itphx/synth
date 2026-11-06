/**
 * ADR-119: занятость контекстного окна сессии — общий расчёт для движка и
 * HTTP-слоя.
 *
 * Источник истины — тот же счётчик, что триггерит авто-сжатие
 * (`ContextOptimizer.estimatePromptTokens`), и то же окно модели
 * (`getContextWindow`): после компактизации значение отражает «прямо сейчас»,
 * а не до-сжатый usage последнего assistant-сообщения.
 *
 * Модуль живёт в слое движка (`engine/context` рядом с оптимизатором): его
 * используют и HTTP-сериализатор (`server/serialize.ts` — ре-экспорт), и
 * оркестратор сжатия — без инверсии слоёв.
 */
import type { Session } from '@itphx/synth-shared';
import { DEFAULT_CONTEXT_WINDOW } from '@itphx/synth-shared';

/**
 * ADR-119: занятость контекстного окна сессии «прямо сейчас».
 *
 * `tokens` — оценка объёма контекста **после** учёта компактизации (тот же
 * счётчик, что триггерит авто-сжатие), `limit` — окно модели, `estimated` —
 * окно неизвестно (фолбэк-оценка).
 */
export interface ContextUsage {
  /** Оценка токенов в контексте сессии. */
  tokens: number;
  /** Окно модели (или фолбэк-оценка). */
  limit: number;
  /** Окно — фолбэк-оценка: у модели не задан `context_window`. */
  estimated: boolean;
}

/**
 * ADR-119: источник занятости контекста — оптимизатор контекста.
 *
 * Структурный минимум (`estimatePromptTokens` + `getContextWindow`), чтобы
 * потребитель не зависел от конкретной реализации оптимизатора. Методы
 * необязательны: у источника без счётчика/окна занятость считается
 * неизвестной (`tokens: 0`, окно — фолбэк-оценка).
 */
export interface ContextUsageSource {
  /** Оценка объёма текущего промпта в токенах (счётчик триггера сжатия). */
  estimatePromptTokens?(session: Session): number;
  /** Окно модели: `0` — неизвестно (не «выключено», а отсутствие данных). */
  getContextWindow?(modelId?: string): number;
}

/**
 * ADR-119: посчитать занятость контекста по оптимизатору.
 *
 * Окно неизвестно (`0` или источник его не знает) → фолбэк-оценка
 * `DEFAULT_CONTEXT_WINDOW` — тот же порог, что используют триггеры сжатия
 * (значение — из shared, правило — одно на ядро и UI).
 */
export function computeContextUsage(
  source: ContextUsageSource,
  session: Session,
): ContextUsage {
  const window = typeof source.getContextWindow === 'function'
    ? source.getContextWindow(session.settings.model)
    : 0;
  const limit = window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
  const rawTokens = typeof source.estimatePromptTokens === 'function'
    ? source.estimatePromptTokens(session)
    : 0;
  const tokens = Number.isFinite(rawTokens) && rawTokens > 0 ? Math.round(rawTokens) : 0;
  return {
    tokens,
    limit,
    estimated: window <= 0,
  };
}
