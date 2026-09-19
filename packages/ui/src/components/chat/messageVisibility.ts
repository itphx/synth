import type { MessageData } from '@/stores/chatStore'

/** metadata.type durable state-сообщений (AD-070 §2.8). */
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
 * (`metadata.tool_chain`) и state-сообщения (AD-070 §2.8). `hidden` здесь не
 * используется — он исключает сообщение и из LLM-запроса.
 */
export function isVisibleMessage(m: Pick<MessageData, 'metadata'>): boolean {
  if (m.metadata?.tool_chain === true) return false
  if (isStateMessage(m)) return false
  return true
}
