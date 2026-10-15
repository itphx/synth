import type { MessageData } from '@/stores/chatStore'

/** metadata.type durable state-сообщений (ADR-070 §2.8). */
export const STATE_MESSAGE_TYPES = new Set([
  'mode_change',
  'plan_updated',
  'todos_updated',
  'agent_switch',
])

/**
 * true — сообщение является durable state-сообщением режима/плана/todo.
 * Такие сообщения хранятся в истории с `role: system` и `metadata.state = true`
 * (для LLM), но пользователю в транскрипте не показываются.
 */
export function isStateMessage(m: Pick<MessageData, 'metadata'>): boolean {
  const meta = m.metadata
  if (!meta) return false
  if (meta.state === true) return true
  return typeof meta.type === 'string' && STATE_MESSAGE_TYPES.has(meta.type)
}

/**
 * Видимость сообщения в транскрипте: скрываем служебный tool-chain
 * (`metadata.tool_chain`), state-сообщения (ADR-070 §2.8) и user-сообщение
 * системной команды (`metadata.commandPrompt`, ADR-046 §7.1 — команда
 * объединена с локальным выводом в один блок и отдельным пузырём не нужна).
 * `hidden` здесь не используется — он исключает сообщение и из LLM-запроса.
 */
export function isVisibleMessage(m: Pick<MessageData, 'metadata'>): boolean {
  if (m.metadata?.tool_chain === true) return false
  if (m.metadata?.commandPrompt === true) return false
  if (isStateMessage(m)) return false
  return true
}
