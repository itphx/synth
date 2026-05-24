import type { Session, Message, Project, StatusMessage } from '@synth/shared';

export function serializeSession(session: Session) {
  return {
    id: session.id,
    name: session.title || null,
    user_id: session.userId || null,
    owner_id: session.ownerId || null,
    project_id: session.projectId || null,
    engine: session.engine,
    messages: session.messages.map((m, i) => serializeMessage(m, i)),
    pending_messages: session.pendingMessages.map((m, i) => serializeMessage(m, i)),
    pending_count: session.pendingMessages.length,
    status: {
      state: session.status.state,
      blocked: session.status.blocked || null,
    },
    settings: session.settings,
    current_stream: session.currentStream ? {
      stream_id: session.currentStream.streamId,
      agent_role: session.currentStream.agentRole || null,
      started_at: session.currentStream.startedAt,
      cancelled: session.currentStream.cancelled,
    } : null,
    input_tokens: session.inputTokens,
    output_tokens: session.outputTokens,
    total_tokens: session.totalTokens,
    processor_running: null,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

export function serializeMessage(msg: Message, index: number) {
  return {
    index,
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
    usage: msg.usage
      ? {
          input_tokens: msg.usage.inputTokens,
          output_tokens: msg.usage.outputTokens,
          total_tokens: msg.usage.totalTokens,
        }
      : null,
    timestamp: msg.createdAt,
    metadata: msg.metadata || null,
    source: msg.source || null,
    tool_calls: msg.toolCalls || null,
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
    status_messages: (project.statusMessages || []).map((sm: StatusMessage) => ({
      id: sm.id,
      text: sm.text,
      type: sm.type,
      timestamp: sm.timestamp,
    })),
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}
