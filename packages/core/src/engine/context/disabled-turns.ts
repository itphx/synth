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
 * часть выключенного хода.
 *
 * Отключённый assistant с `toolCalls` подавляет свои tool-результаты: иначе
 * они остаются сиротами и провайдер получает `tool` без `tool_use`.
 *
 * Функция не мутирует исходные сообщения: изменённые возвращаются копиями.
 */
import { MessageRole, type Message } from '@itphx/synth-shared';

export function suppressDisabledTurns(messages: readonly Message[]): Message[] {
  /** id tool-вызовов отключённых assistant-сообщений. */
  const suppressedToolCalls = new Set<string>();
  let turnDisabled = false;

  return messages.map((message) => {
    if (message.role === MessageRole.USER) {
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
