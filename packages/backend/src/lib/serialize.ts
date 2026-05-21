import type { Session, Message, Project, StatusMessage } from '@synth/shared';

export function serializeSession(session: Session) {
  return {
    id: session.id,
    user_id: session.userId || null,
    owner_id: session.ownerId || null,
    project_id: session.projectId || null,
    engine: session.engine,
    messages: session.messages.map((m, i) => serializeMessage(m, i)),
    pending_messages: session.pendingMessages.map((m, i) => serializeMessage(m, i)),
    status: {
      state: session.status.state,
      blocked: session.status.blocked || null,
    },
    settings: session.settings,
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
    usage: msg.usage
      ? {
          input_tokens: msg.usage.inputTokens,
          output_tokens: msg.usage.outputTokens,
          total_tokens: msg.usage.totalTokens,
        }
      : null,
    timestamp: msg.createdAt,
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
