/**
 * ADR-039/ADR-070: отключение сообщения из контекста.
 *
 * Флаг `disabled` исторически ставился на конкретное сообщение. Этого
 * недостаточно: у пользовательской реплики есть «хвост» — ответ ассистента,
 * вызовы инструментов и их результаты. Если отключить только реплику,
 * хвост продолжает уходить модели, и она видит обрывки выключенного хода
 * (tool-результаты без вопроса, ответы без причины).
 *
 * Поэтому отключённая **пользовательская** реплика выключает весь свой ход:
 * assistant/tool/error-сообщения до следующей пользовательской реплики.
 * System-state (mode/agent) и summary не подавляются — это состояние, а не
 * часть выключенного хода. Служебные сообщения без своего хода (вложение
 * тула — `metadata.source === 'tool-attachment'`, ADR-115; уведомление о
 * переносе сессии — `metadata.type === 'session_moved'`, PROP-141) — тоже
 * часть текущего хода, а не новая реплика: границу хода они не сдвигают и
 * наследуют состояние (отключённый ход гасит и их).
 *
 * Отключённый assistant с `toolCalls` подавляет свои tool-результаты: иначе
 * они остаются сиротами и провайдер получает `tool` без `tool_use`.
 *
 * Функция не мутирует исходные сообщения: изменённые возвращаются копиями.
 */
import { MessageRole, type Message } from '@itphx/synth-shared';
import { isNonTurnServiceUserMessage } from '../../sessions/user-messages.js';

export function suppressDisabledTurns(messages: readonly Message[]): Message[] {
  /** id tool-вызовов отключённых assistant-сообщений. */
  const suppressedToolCalls = new Set<string>();
  let turnDisabled = false;

  return messages.map((message) => {
    if (message.role === MessageRole.USER) {
      // Служебное сообщение без своего хода — часть текущего хода, а не новая
      // пользовательская реплика: границу хода оно не сдвигает, применяет
      // текущее состояние (вложение тула ADR-115, уведомление о переносе
      // сессии PROP-141).
      if (isNonTurnServiceUserMessage(message)) {
        return turnDisabled ? { ...message, disabled: true } : message;
      }
      // Новая пользовательская реплика — новая граница хода.
      turnDisabled = message.disabled === true;
      return message;
    }

    if (message.role === MessageRole.ASSISTANT && message.disabled) {
      for (const call of message.toolCalls ?? []) {
        if (typeof call.id === 'string' && call.id) suppressedToolCalls.add(call.id);
      }
      return message;
    }

    // Состояние сессии и summary — не часть выключенного хода: режим/агент
    // должны оставаться в контексте, даже если реплика рядом отключена.
    if (
      turnDisabled
      && message.role !== MessageRole.SYSTEM
      && message.role !== MessageRole.SUMMARY
    ) {
      return { ...message, disabled: true };
    }

    if (
      message.role === MessageRole.TOOL
      && message.toolCallId
      && suppressedToolCalls.has(message.toolCallId)
    ) {
      return { ...message, disabled: true };
    }

    return message;
  });
}
