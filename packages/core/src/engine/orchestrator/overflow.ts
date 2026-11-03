/**
 * Восстановление после переполнения контекста (`context_length`).
 *
 * Чистая функция сборки сообщений для повтора: system prompt НЕ пересобирается,
 * вместо старых резюме в начало кладётся авторитетный чекпоинт, затем живой
 * хвост и сообщения текущего хода. Tool-пары сохраняются, иначе повтор
 * запрещён (`null`).
 */
import type { LLMMessage } from '../../providers/base.js';

/** Признак сообщения для дедупликации хвоста и текущего хода. */
function messageKey(message: LLMMessage): string {
  const toolIds = (message.toolUse ?? [])
    .map((call) => (typeof call.id === 'string' ? call.id : ''))
    .join(',');
  return [
    message.role,
    message.content,
    message.toolCallId ?? '',
    toolIds,
  ].join('\u0000');
}

/** Длина наибольшего суффикса `tail`, совпадающего с префиксом `currentTurn`. */
function longestOverlap(tail: LLMMessage[], currentTurn: LLMMessage[]): number {
  const max = Math.min(tail.length, currentTurn.length);
  for (let size = max; size > 0; size--) {
    let matches = true;
    for (let i = 0; i < size; i++) {
      if (messageKey(tail[tail.length - size + i]!) !== messageKey(currentTurn[i]!)) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

/**
 * Проверка пар tool-вызовов: каждый `tool`-результат имеет предшествующий
 * assistant(tool_use) с тем же id, и все вызовы закрыты результатами.
 */
export function hasValidToolPairs(messages: LLMMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolUse && message.toolUse.length > 0) {
      for (const call of message.toolUse) {
        if (typeof call.id === 'string' && call.id) pending.add(call.id);
      }
      continue;
    }
    if (message.role === 'tool') {
      if (!message.toolCallId || !pending.has(message.toolCallId)) return false;
      pending.delete(message.toolCallId);
    }
  }
  return pending.size === 0;
}

/** Сообщение-чекпоинт (в историю не пишется, только для текущего запроса). */
export function overflowCheckpointMessage(summary: string): LLMMessage {
  return {
    id: '',
    role: 'user',
    content: `[CONTEXT CHECKPOINT]\n${summary.trim()}\n\nЭтот чекпоинт заменяет более ранние резюме.`,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: '',
  };
}

/**
 * Собрать `stepMessages` для повтора после сжатия.
 *
 * `tail` — LLM-сообщения живого хвоста (после последнего SUMMARY, без него).
 * `currentTurn` — сообщения текущего хода (включая его user-реплику) в
 * порядке отправки. Пересечение хвоста и текущего хода схлопывается по
 * наибольшему суффиксу, чтобы не дублировать user-реплику/шаги.
 *
 * `null` — порядок восстановить нельзя (нет резюме или разорваны tool-пары).
 */
export function buildOverflowRetryMessages(input: {
  summary: string;
  tail: LLMMessage[];
  currentTurn: LLMMessage[];
}): LLMMessage[] | null {
  const summary = input.summary.trim();
  if (!summary) return null;

  const overlap = longestOverlap(input.tail, input.currentTurn);
  const merged = [...input.tail, ...input.currentTurn.slice(overlap)];
  if (!hasValidToolPairs(merged)) return null;

  return [overflowCheckpointMessage(summary), ...merged];
}
