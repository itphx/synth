/**
 * AD-070 §2.8: режим/план/todo — durable chronological-сообщения истории, а не
 * блоки system prompt. Сообщение в хранилище имеет `role: system`,
 * `metadata: { type, state: true }` и скрыто только в UI; в LLM-запрос оно
 * отдаётся как синтетическое user-сообщение с обёрткой
 * `<system-state type="…">…</system-state>` (Anthropic не принимает role system
 * в messages) — см. `ChatOrchestrator._sessionMessagesToLlm`.
 *
 * `syncStateMessages` идемпотентен: он сравнивает актуальный контент с последним
 * сообщением каждого типа и добавляет новое только при отличии. Пустые контент не
 * добавляются, уже существующие сообщения не трогаются.
 */

import type { Message, ProjectPlan, Session, SessionMode, PlanMode, TodoItem } from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { ContextConfig } from './config.js';
import { renderPlanMarkdown } from '../tools/plan.js';
import { renderTodosMarkdown } from '../tools/todo.js';

export type StateMessageType = 'mode_change' | 'plan_updated' | 'todos_updated' | 'agent_switch';

/** AD-070 §2.9.1: недоступный тул и причина — режим, роль или зависимость окружения. */
export interface UnavailableTool {
  name: string;
  reason: 'mode' | 'role' | 'dependency';
  /** Для `dependency` — человекочитаемое имя отсутствующей программы. */
  binary?: string;
}

/** Обёртка state-сообщения для LLM: role system недопустим в messages. */
export function wrapStateContent(type: string, content: string): string {
  return `<system-state type="${type}">\n${content}\n</system-state>`;
}

/** Создаёт durable state-сообщение (роль system, скрыто только в UI). */
export function createStateMessage(type: StateMessageType, content: string): Message {
  return {
    id: generateId(),
    role: MessageRole.SYSTEM,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    metadata: { type, state: true },
  };
}

/**
 * AD-070 §2.9.1: компактная секция недоступных сейчас тулов с причиной и
 * подсказкой. Одна строка на тул; пустой список → '' (секции нет).
 */
export function renderUnavailableTools(tools: UnavailableTool[], language: string): string {
  if (tools.length === 0) return '';
  const en = language === 'en';
  const header = en ? '[UNAVAILABLE TOOLS]' : '[НЕДОСТУПНЫЕ ТУЛЫ]';
  const lines = tools.map(({ name, reason, binary }) => {
    if (reason === 'dependency') {
      const program = binary ?? (en ? 'required program' : 'необходимая программа');
      const cause = en
        ? `the required program "${program}" is not installed`
        : `не установлена программа «${program}»`;
      const hint = en
        ? 'install the program or contact the administrator'
        : 'установите программу или обратитесь к администратору';
      return `- ${name} — ${cause}: ${hint}`;
    }
    const cause = reason === 'mode'
      ? (en ? 'unavailable in the current mode' : 'недоступно в текущем режиме')
      : (en ? 'unavailable for the current agent' : 'недоступно для текущего агента');
    const hint = reason === 'mode'
      ? (en ? 'switch the mode (plan/act/yolo)' : 'переключите режим (plan/act/yolo)')
      : (en ? 'delegate via @' : 'делегируйте через @');
    return `- ${name} — ${cause}: ${hint}`;
  });
  return [header, ...lines].join('\n');
}

/**
 * AD-025/AD-028: текст смены режима — промпт текущего режима (plan/act/yolo) и
 * строгость цикла Plan→Build. Раньше это были блоки `mode.prompt`/
 * `plan.strictness` в system prompt.
 *
 * AD-070 §2.9.1: дополнительно перечисляет недоступные сейчас тулы с причиной
 * (`mode` → предложить переключение, `role` → делегировать через `@`).
 */
export function buildModeChangeContent(
  sessionMode: SessionMode,
  planMode: PlanMode,
  planApproved: boolean,
  language: string,
  contextConfig: ContextConfig | null | undefined,
  unavailableTools?: UnavailableTool[],
): string {
  if (!contextConfig) return '';
  const modePrompt = contextConfig.getModePrompt(sessionMode, language) ?? '';
  const planModePrompt = contextConfig.getPlanModePrompt(planMode, planApproved, language) ?? '';
  const base = [modePrompt, planModePrompt].filter((part) => part !== '').join('\n\n');
  const unavailable = renderUnavailableTools(unavailableTools ?? [], language);
  return [base, unavailable].filter((part) => part !== '').join('\n\n');
}

/**
 * AD-070 §2.8/§2.9.1: текст переключения агента — активный агент и
 * недоступные ему по роли тулы (причина `role`), которые можно делегировать
 * через `@`.
 */
export function buildAgentSwitchContent(
  agentRole: string,
  language: string,
  unavailableTools?: UnavailableTool[],
): string {
  if (!agentRole) return '';
  const en = language === 'en';
  const header = en ? '[AGENT]' : '[АГЕНТ]';
  const activeLine = en ? `Active agent: ${agentRole}.` : `Активный агент: ${agentRole}.`;
  const roleTools = (unavailableTools ?? []).filter((tool) => tool.reason === 'role');
  const section = renderUnavailableTools(roleTools, language);
  return [header, activeLine, section].filter((part) => part !== '').join('\n');
}

/** AD-039: актуальное состояние плана проекта (`[APPROVED PLAN]` + markdown). */
export function buildPlanUpdatedContent(plan: ProjectPlan | null | undefined): string {
  if (!plan || plan.items.length === 0) return '';
  return `[APPROVED PLAN]\n${renderPlanMarkdown(plan)}`;
}

/** AD-039: актуальный список todo сессии (`[TODO]` + markdown). Пустой → ''. */
export function buildTodosUpdatedContent(todos: TodoItem[] | null | undefined): string {
  const markdown = renderTodosMarkdown(todos ?? []);
  return markdown ? `[TODO]\n${markdown}` : '';
}

export interface SyncStateMessagesDeps {
  contextConfig?: ContextConfig | null;
  language?: string;
  /** Актуальный план проекта (`project.plan`) — источник `plan_updated`. */
  plan?: ProjectPlan | null;
  /** AD-070 §2.8: активный агент — источник `agent_switch` (если задан). */
  agentRole?: string;
  /** AD-070 §2.9.1: недоступные сейчас тулы (причина `mode`/`role`). */
  unavailableTools?: UnavailableTool[];
}

export interface SyncStateMessagesResult {
  added: Message[];
  changed: boolean;
}

/** Последнее state-сообщение указанного типа в истории (или null). */
export function findLastStateMessage(messages: Message[], type: StateMessageType): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.metadata?.state === true && msg.metadata?.type === type) return msg;
  }
  return null;
}

/**
 * Идемпотентно синхронизирует состояние режима/плана/todo с историей.
 * Возвращает добавленные сообщения (не сохранённые) и признак изменения —
 * вызывающая сторона сохраняет их через `SessionManager.addMessage`.
 */
export function syncStateMessages(
  session: Session,
  deps: SyncStateMessagesDeps,
): SyncStateMessagesResult {
  const language = deps.language || session.settings.language || 'ru';
  const unavailableTools = deps.unavailableTools ?? [];
  const candidates: Array<{ type: StateMessageType; content: string }> = [
    {
      type: 'mode_change',
      content: buildModeChangeContent(
        session.mode ?? 'act',
        session.settings.planMode ?? 'auto',
        Boolean(session.planApproved),
        language,
        deps.contextConfig,
        unavailableTools,
      ),
    },
  ];
  if (deps.agentRole) {
    candidates.push({
      type: 'agent_switch',
      content: buildAgentSwitchContent(deps.agentRole, language, unavailableTools),
    });
  }
  candidates.push(
    { type: 'plan_updated', content: buildPlanUpdatedContent(deps.plan ?? null) },
    { type: 'todos_updated', content: buildTodosUpdatedContent(session.todos ?? []) },
  );

  const added: Message[] = [];
  for (const { type, content } of candidates) {
    if (content === '') continue; // пустые не добавляем
    const last = findLastStateMessage(session.messages, type);
    if (last && last.content === content) continue; // без изменений — идемпотентно
    added.push(createStateMessage(type, content));
  }

  return { added, changed: added.length > 0 };
}
