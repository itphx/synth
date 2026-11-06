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
 * Есть ли у сообщения непустой список результатов инструментов шага.
 *
 * `metadata.tool_results` — источник карточек вызовов в ленте (ADR-118 §1,
 * DTO `tool_calls`). Шаг с такими данными **нельзя** скрывать: иначе после
 * завершения хода/перезагрузки карточки исчезают (в т.ч. legacy-записи со
 * старым маркером `tool_chain`; см. `MESSAGE_STREAM_V2_VISIBLE_STEPS_MIGRATION`).
 */
function hasToolResults(m: Pick<MessageData, 'metadata'>): boolean {
  const results = m.metadata?.tool_results
  return Array.isArray(results) && results.length > 0
}

/**
 * Fallback-ответы ядра, которые сохраняются с `metadata.status: 'error'`, но
 * ошибкой **не являются**: это содержательный финальный текст (лимит вывода,
 * пустой ответ модели). Статусы `stopped`/`limit` у остальных fallback-ключей
 * (`session.stopped`, `session.max_iterations`, …) под определение ошибки и так
 * не попадают — см. `resolveAssistantStatus` в
 * `packages/core/src/engine/orchestrator/persistence.ts`.
 */
const NON_ERROR_FALLBACK_KEYS = new Set([
  'session.output_limit',
  'session.empty_response',
])

/**
 * Терминальная ошибка LLM **основной** сессии, сохранённая сообщением
 * (legacy-запись или пустой шаг `step.finished error`).
 *
 * Новые ошибки основной сессии сообщением не сохраняются (решение владельца
 * 2026-11-06; пользователю — плашка `StreamErrorPanel`), но в истории остались
 * записи прежней версии. В ленте их быть не должно:
 *  - только `role: 'assistant'`;
 *  - `metadata.interrupted === true` — это **частичный ответ** после
 *    «Стопа»/прерывания, а не ошибка (бейдж «Прервано»);
 *  - терминальный статус ошибки: `status: 'error'` либо legacy
 *    `status == null && metadata.status === 'error'`;
 *  - fallback-ответы с содержательным текстом (`session.output_limit`,
 *    `session.empty_response`) — не ошибка.
 *
 * Всё остальное (`router.*`, `worktree.*`, сырой текст без i18n) — ошибка.
 */
export function isLlmFailureMessage(
  m: Pick<MessageData, 'role' | 'status' | 'metadata'>,
): boolean {
  if (m.role !== 'assistant') return false
  const meta = m.metadata
  if (meta?.interrupted === true) return false
  const isTerminalError = m.status === 'error'
    || (m.status == null && meta?.status === 'error')
  if (!isTerminalError) return false
  const key = (meta?.i18n as { key?: unknown } | undefined)?.key
  if (typeof key === 'string' && NON_ERROR_FALLBACK_KEYS.has(key)) return false
  return true
}

/**
 * Видимость сообщения в транскрипте: скрываем служебный tool-chain
 * (`metadata.tool_chain`) **после завершения** шага, state-сообщения
 * (ADR-070 §2.8) и user-сообщение системной команды (`metadata.commandPrompt`,
 * ADR-046 §7.1 — команда объединена с локальным выводом в один блок и
 * отдельным пузырём не нужна).
 *
 * Живой tool-chain шаг (`status: 'streaming'`) виден: иначе шаг, который
 * состоит только из вызовов инструментов, не показывался бы до своего финала
 * (карточки инструментов жили бы «в пустоте»). После завершения шага
 * служебный tool-результат (`role: 'tool'`) скрывается, а **assistant-шаг с
 * непустым `metadata.tool_results` виден всегда** — на нём рисуются карточки
 * вызовов, и потеря шага означала бы потерю самой истории инструментов
 * (в т.ч. у legacy-записей, где маркер `tool_chain` остался от старой сборки
 * ядра). `hidden` здесь не используется — он исключает сообщение и из
 * LLM-запроса.
 */
export function isVisibleMessage(
  m: Pick<MessageData, 'metadata' | 'status' | 'role'>,
): boolean {
  if (isStateMessage(m)) return false
  if (m.metadata?.commandPrompt === true) return false
  if (m.metadata?.tool_chain === true) {
    // Результаты инструментов (`role: 'tool'`) — всегда служебные: их
    // визуальное представление уже в карточках шага.
    if (m.role === 'tool') return false
    // Шаг с карточками инструментов видим независимо от статуса/маркера.
    if (m.role === 'assistant' && hasToolResults(m)) return true
    if (m.status !== 'streaming') return false
  }
  return true
}
