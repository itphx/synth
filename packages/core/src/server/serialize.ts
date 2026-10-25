import type { Session, Message, Project, StatusMessage } from '@itphx/synth-shared';
import { isModeApplicable } from '../engine/agents/mode.js';

/** Минимальный тип реестра агентов для вычисления modeApplicable. */
export interface SerializeAgentRegistry {
  get(id: string): { capabilities?: readonly string[] } | undefined;
}

export interface SerializeSessionOptions {
  agentRegistry?: SerializeAgentRegistry | null;
  /**
   * ADR-036: убрать РЕАЛЬНЫЕ значения секретов из `metadata.secrets`
   * (плейсхолдер → значение) в ответе. Ключи-плейсхолдеры сохраняются —
   * клиент по ним показывает «значение скрыто» (UI, ADR-036).
   *
   * Значения по умолчанию отдаются: право видеть реальные секреты — привилегия
   * читателя, её решает вызывающий (см. `canRevealSecrets` в роутах сессий).
   */
  redactSecrets?: boolean;
}

/**
 * ADR-036: копия `metadata` сообщения БЕЗ реальных значений секретов.
 *
 * Убираются только значения (`{ '⟦SYNTH_SECRET_1⟧': 'sk-…' }` →
 * `{ '⟦SYNTH_SECRET_1⟧': '' }`); ключи-плейсхолдеры остаются — по ним клиент
 * понимает, что в тексте есть секрет, и показывает его скрытым. Остальные
 * поля `metadata` (в т.ч. `tool_results`) не трогаются.
 *
 * Исходный объект НЕ мутируется (очистка — на ответе, сохранённая сессия
 * остаётся как есть).
 */
function redactSecretValues(metadata: Message['metadata']): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const secrets = metadata.secrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return metadata;
  const cleared: Record<string, string> = {};
  for (const key of Object.keys(secrets as Record<string, unknown>)) cleared[key] = '';
  return { ...metadata, secrets: cleared };
}

/** Опции сериализации одного сообщения. */
export interface SerializeMessageOptions {
  /** ADR-036: убрать реальные значения секретов из `metadata.secrets`. */
  redactSecrets?: boolean;
}

/**
 * ADR-036: копия СЫРОЙ сессии без реальных значений секретов.
 *
 * Для ответов, где сессия отдаётся не в DTO (`serializeSession`), а объектом
 * `Session` (например, дерево сессий `GET /:id/tree`). Значения секретов
 * убираются, ключи-плейсхолдеры остаются; исходная сессия не мутируется.
 */
export function redactSessionSecretValues(session: Session): Session {
  const redact = (m: Message): Message => ({
    ...m,
    metadata: redactSecretValues(m.metadata) ?? undefined,
  });
  return {
    ...session,
    messages: session.messages.map(redact),
    pendingMessages: session.pendingMessages.map(redact),
  };
}

export function serializeSession(session: Session, opts?: SerializeSessionOptions) {
  const agentId = session.settings.agentRole;
  const agent = agentId && opts?.agentRegistry ? opts.agentRegistry.get(agentId) : undefined;
  const messageOpts: SerializeMessageOptions = { redactSecrets: opts?.redactSecrets === true };
  return {
    id: session.id,
    origin: 'local' as const,
    name: session.title || null,
    icon: session.icon || null,
    color: session.color || null,
    parent_id: session.parentId || null,
    branch_point: session.branchPoint || null,
    plan_approved: session.planApproved ?? false,
    mode: session.mode || 'act',
    /**
     * ADR-106 Ф4 (шаг C): режим по принципалу — переопределения режима сессии
     * для отдельных участников (`yolo` одного участника не действует на ходы
     * другого). Пусто — у всех режим сессии (`mode`).
     */
    mode_by_principal: session.modeByPrincipal ?? null,
    /** ADR-025: применим ли переключатель режимов к агенту сессии (по capabilities). */
    mode_applicable: isModeApplicable(agent),
    todos: session.todos || null,
    session_origin: session.sessionOrigin,
    user_id: session.userId || null,
    owner_id: session.ownerId || null,
    project_id: session.projectId || null,
    messages: session.messages.map((m, i) => serializeMessage(m, i, messageOpts)),
    pending_messages: session.pendingMessages.map((m, i) => serializeMessage(m, i, messageOpts)),
    pending_count: session.pendingMessages.length,
    current_stream: session.currentStream
      ? {
          stream_id: session.currentStream.streamId,
          message: session.currentStream.message,
          agent_role: session.currentStream.agentRole || null,
          cancelled: session.currentStream.cancelled,
        }
      : null,
    status: {
      blocked: session.status.blocked || null,
      cancel_requested: session.status.cancelRequested || false,
      cancel_requested_at: session.status.cancelRequestedAt || null,
    },
    settings: session.settings,
    /** ADR-070 §2.4: состояние промпта per-agent (generation/hash/prefix). */
    prompt_states: session.promptStates ?? null,
    sticky_notes: session.stickyNotes.map((n) => ({
      id: n.id,
      content: n.content,
      created_at: n.createdAt,
      updated_at: n.updatedAt,
      disabled: n.disabled,
    })),
    references: (session.references || []).map((ref) => ({
      session_id: ref.sessionId,
      label: ref.label,
      message_range: ref.messageRange,
      auto_summary: ref.autoSummary || null,
      created_at: ref.createdAt,
    })),
    summarization_pending: session.summarizationPending,
    can_summarize: session.canSummarize,
    input_tokens: session.inputTokens,
    output_tokens: session.outputTokens,
    total_tokens: session.totalTokens,
    cache_read_tokens: session.cacheReadTokens,
    cache_write_tokens: session.cacheWriteTokens,
    reasoning_tokens: session.reasoningTokens,
    input_cost: session.inputCost,
    output_cost: session.outputCost,
    cache_read_cost: session.cacheReadCost,
    cache_write_cost: session.cacheWriteCost,
    cache_hit_rate: session.cacheHitRate ?? 0,
    processor_running: null,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

export function serializeMessage(msg: Message, index: number, opts?: SerializeMessageOptions) {
  return {
    index,
    id: msg.id,
    seq: msg.seq,
    origin: msg.origin,
    source_msg_id: msg.sourceMsgId || null,
    role: msg.role,
    content: msg.content,
    parts: msg.parts.map((p) => ({
      id: p.id,
      type: p.type,
      data: p.data,
    })),
    author: msg.author || null,
    disabled: msg.disabled,
    pinned: msg.pinned,
    hidden: msg.hidden,
    /** ADR-046 §7.1: локальный ответ `/`-команды — вне LLM-контекста. */
    ephemeral: msg.ephemeral ?? false,
    agent_role: msg.agentRole || null,
    model: msg.model || null,
    provider: msg.provider || null,
    provider_type: msg.providerType || null,
    reasoning: msg.reasoning || null,
    debug_data: msg.debugData || null,
    /** ADR-070 §2.4: предсказание/валидация prompt-cache для хода. */
    prompt_meta: msg.promptMeta ?? null,
    summary_of: msg.summaryOf || null,
    // ADR-034: QC-бейдж. Поля опускаются, если проверки не было — `null`
    // включил бы бейдж в UI (проверка `qa_pass !== undefined`).
    ...(msg.qa_pass !== undefined ? { qa_pass: msg.qa_pass } : {}),
    ...(msg.qa_reason !== undefined ? { qa_reason: msg.qa_reason } : {}),
    usage: msg.usage
      ? {
          input_tokens: msg.usage.inputTokens,
          output_tokens: msg.usage.outputTokens,
          total_tokens: msg.usage.totalTokens,
          ...(msg.usage.cacheReadTokens != null ? { cache_read_tokens: msg.usage.cacheReadTokens } : {}),
          ...(msg.usage.cacheWriteTokens != null ? { cache_write_tokens: msg.usage.cacheWriteTokens } : {}),
          ...(msg.usage.reasoningTokens != null ? { reasoning_tokens: msg.usage.reasoningTokens } : {}),
        }
      : null,
    timestamp: msg.createdAt,
    /** ADR-036: реальные значения секретов — только читателю с правом раскрытия. */
    metadata: opts?.redactSecrets ? redactSecretValues(msg.metadata) : msg.metadata || null,
    source: msg.source || null,
    tool_calls: (msg.metadata?.tool_results as Array<Record<string, unknown>>) || msg.toolCalls || null,
    tool_call_id: msg.toolCallId || null,
  };
}

export function serializeProject(project: Project) {
  return {
    id: project.id,
    origin: 'local' as const,
    name: project.name,
    owner_id: project.ownerId,
    members: project.members,
    description: project.description,
    current_task: project.currentTask,
    invariants: project.invariants,
    icon: project.icon || null,
    color: project.color || null,
    workspace: project.workspace || null,
    repos: project.repos || null,
    /** ADR-071 §2.4: проектный скоуп MCP (owner/lead). */
    mcp: project.mcp ?? null,
    /** ADR-107: политика памяти проекта (`{enabled}`; null — наследует). */
    memory: project.memory ?? null,
    status_messages: (project.statusMessages || []).map((sm: StatusMessage) => ({
      id: sm.id,
      text: sm.text,
      type: sm.type,
      timestamp: sm.timestamp,
    })),
    log: (project.log || []).map((e) => ({
      id: e.id,
      text: e.text,
      created_at: e.createdAt,
      session_id: e.sessionId || null,
      author: e.author || null,
    })),
    plan: project.plan ?? null,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}
