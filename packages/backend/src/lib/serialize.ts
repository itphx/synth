import type { Session, Message, Project, StatusMessage } from '@itphx/synth-shared';
import { isModeApplicable } from '@itphx/synth-core';

/** Минимальный тип реестра агентов для вычисления modeApplicable. */
export interface SerializeAgentRegistry {
  get(id: string): { capabilities?: readonly string[] } | undefined;
}

export interface SerializeSessionOptions {
  agentRegistry?: SerializeAgentRegistry | null;
}

export function serializeSession(session: Session, opts?: SerializeSessionOptions) {
  const agentId = session.settings.agentRole;
  const agent = agentId && opts?.agentRegistry ? opts.agentRegistry.get(agentId) : undefined;
  return {
    id: session.id,
    name: session.title || null,
    parent_id: session.parentId || null,
    branch_point: session.branchPoint || null,
    plan_approved: session.planApproved ?? false,
    session_origin: session.sessionOrigin,
    user_id: session.userId || null,
    owner_id: session.ownerId || null,
    project_id: session.projectId || null,
    engine: session.engine,
    mode: session.mode || 'act',
    /** AD-025: применим ли переключатель режимов к агенту сессии (по capabilities). */
    mode_applicable: isModeApplicable(agent),
    messages: session.messages.map((m, i) => serializeMessage(m, i)),
    pending_messages: session.pendingMessages.map((m, i) => serializeMessage(m, i)),
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
    },
    settings: session.settings,
    /** AD-070 §2.4: состояние промпта per-agent (generation/hash/prefix). */
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

export function serializeMessage(msg: Message, index: number) {
  return {
    index,
    origin: msg.origin,
    source_msg_id: msg.sourceMsgId || null,
    role: msg.role,
    content: msg.content,
    author: msg.author || null,
    disabled: msg.disabled,
    pinned: msg.pinned,
    hidden: msg.hidden,
    agent_role: msg.agentRole || null,
    model: msg.model || null,
    provider: msg.provider || null,
    provider_type: msg.providerType || null,
    reasoning: msg.reasoning || null,
    debug_data: msg.debugData || null,
    /** AD-070 §2.4: предсказание/валидация prompt-cache для хода. */
    prompt_meta: msg.promptMeta ?? null,
    summary_of: msg.summaryOf || null,
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
    metadata: msg.metadata || null,
    source: msg.source || null,
    tool_calls: (msg.metadata?.tool_results as Array<Record<string, unknown>>) || msg.toolCalls || null,
    tool_call_id: msg.toolCallId || null,
  };
}

export function serializeProject(project: Project) {
  return {
    id: project.id,
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
    /** AD-071 §2.4: проектный скоуп MCP (owner/lead). */
    mcp: project.mcp ?? null,
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
