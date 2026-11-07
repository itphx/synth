/**
 * Нормализация первого сообщения истории для LLM-запроса.
 *
 * После сжатия контекста хвост может начинаться с `assistant` (срез по шагу
 * в `ContextOptimizer._buildCompressionBoundary`): прежнее правило «хвост
 * начинается с user» разворачивало хвост на весь длинный ход и сжатие не
 * уменьшало контекст.
 *
 * Часть провайдеров (Anthropic) требует, чтобы первое сообщение в `messages`
 * было `user`. Поэтому, когда хвост начинается с `assistant`, резюме уходит
 * из системного блока в **синтетическое user-сообщение чекпоинта** в начале
 * истории (`overflowCheckpointMessage` — тот же формат, что и при повторе
 * после overflow).
 *
 * Правило чистое и не зависит от тяжёлых зависимостей `process-setup` —
 * его можно тестировать отдельно.
 */
import type { Message } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { LLMMessage } from '../../providers/base.js';
import { overflowCheckpointMessage } from './overflow.js';

/** Результат нормализации истории. */
export interface HistoryNormalization {
  /**
   * Содержимое для системного блока `summary`. Пустая строка — блок не
   * добавляется (резюме ушло в чекпоинт).
   */
  summaryContent: string;
  /**
   * Синтетическое user-сообщение чекпоинта (начало истории) — `null`,
   * когда нормализация не нужна.
   */
  checkpoint: LLMMessage | null;
}

/**
 * Роль первого «живого» сообщения истории: без SUMMARY, без
 * disabled/hidden/ephemeral и без INFO. `null` — живых сообщений нет.
 */
export function firstLiveMessageRole(messages: Message[]): MessageRole | null {
  for (const msg of messages) {
    if (msg.role === MessageRole.SUMMARY) continue;
    if (msg.disabled || msg.hidden || msg.ephemeral) continue;
    if (msg.role === MessageRole.INFO) continue;
    return msg.role;
  }
  return null;
}

/**
 * Нормализация истории: вернуть содержимое системного блока `summary` и
 * (при необходимости) чекпоинт в начало запроса.
 *
 * Резюме остаётся в системном блоке, пока хвост начинается с `user`
 * (прежнее поведение). Если хвост начинается с `assistant` — резюме
 * переносится в user-чекпоинт (системный блок остаётся пустым).
 */
export function resolveHistoryNormalization(input: {
  /** Живая выборка истории (`optimizedMessages`). */
  messages: Message[];
  /** Содержимое резюме (склейка SUMMARY-сообщений). */
  summaryContent: string;
}): HistoryNormalization {
  const summaryContent = input.summaryContent ?? '';
  if (!summaryContent.trim()) {
    return { summaryContent: '', checkpoint: null };
  }
  if (firstLiveMessageRole(input.messages) !== MessageRole.ASSISTANT) {
    return { summaryContent, checkpoint: null };
  }
  return {
    summaryContent: '',
    checkpoint: overflowCheckpointMessage(summaryContent),
  };
}
