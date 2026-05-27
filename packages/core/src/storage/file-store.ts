import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Session, SessionFilter, Message, TsmState, TsmStatus, SessionSettings } from '@synth/shared';
import { atomicWrite, generateId, safeJsonParse, AsyncLock } from '@synth/shared';

export interface StorageConfig {
  dataDir: string;
}

interface SerializedUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

interface SerializedMessage {
  role: string;
  content: string;
  tool_calls?: Record<string, unknown>[];
  tool_call_id?: string;
  created_at: string;
  disabled: boolean;
  pinned: boolean;
  hidden: boolean;
  debug_data?: Record<string, unknown>;
  model?: string;
  provider?: string;
  provider_type?: string;
  usage?: SerializedUsage;
  reasoning?: string;
  source?: string;
  author?: string;
  agent_role?: string;
  metadata?: Record<string, unknown>;
  summary_of?: number[];
}

interface SerializedSession {
  id: string;
  title?: string;
  user_id?: string;
  owner_id?: string;
  project_id?: string;
  engine: string;
  messages: SerializedMessage[];
  pending_messages: SerializedMessage[];
  status: Record<string, unknown>;
  settings: Record<string, unknown>;
  branches: unknown[];
  checkpoints: SerializedCheckpoint[];
  sticky_notes: StickyNoteData[];
  current_stream?: Record<string, unknown>;
  summarization_pending: boolean;
  input_cost: number;
  output_cost: number;
  cache_read_cost: number;
  cache_write_cost: number;
  created_at: string;
  updated_at: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
}

interface StickyNoteData {
  id: string;
  content: string;
  created_at: string;
  updated_at: string;
  disabled: boolean;
}

interface SerializedCheckpoint {
  id: string;
  session_id: string;
  messages: SerializedMessage[];
  tsm_state: string;
  created_at: string;
}

function serializeMessage(msg: Message): SerializedMessage {
  return {
    role: msg.role,
    content: msg.content,
    tool_calls: msg.toolCalls,
    tool_call_id: msg.toolCallId,
    created_at: msg.createdAt,
    disabled: msg.disabled,
    pinned: msg.pinned,
    hidden: msg.hidden,
    debug_data: msg.debugData,
    model: msg.model,
    provider: msg.provider,
    provider_type: msg.providerType,
    usage: msg.usage ? {
    input_tokens: msg.usage.inputTokens,
    output_tokens: msg.usage.outputTokens,
    total_tokens: msg.usage.totalTokens,
    cache_read_tokens: msg.usage.cacheReadTokens,
    cache_write_tokens: msg.usage.cacheWriteTokens,
    reasoning_tokens: msg.usage.reasoningTokens,
  } : undefined,
    reasoning: msg.reasoning,
    source: msg.source,
    author: msg.author,
    agent_role: msg.agentRole,
    metadata: msg.metadata,
    summary_of: msg.summaryOf,
  };
}

function deserializeMessage(data: SerializedMessage): Message {
  return {
    role: data.role as Message['role'],
    content: data.content,
    toolCalls: data.tool_calls,
    toolCallId: data.tool_call_id,
    createdAt: data.created_at,
    disabled: data.disabled,
    pinned: data.pinned,
    hidden: data.hidden,
    debugData: data.debug_data,
    model: data.model,
    provider: data.provider,
    providerType: data.provider_type,
    usage: data.usage ? {
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
    totalTokens: data.usage.total_tokens,
    cacheReadTokens: data.usage.cache_read_tokens,
    cacheWriteTokens: data.usage.cache_write_tokens,
    reasoningTokens: data.usage.reasoning_tokens,
  } : undefined,
    reasoning: data.reasoning,
    source: data.source as Message['source'],
    author: data.author,
    agentRole: data.agent_role,
    metadata: data.metadata,
    summaryOf: data.summary_of,
  };
}

function serializeSession(session: Session): SerializedSession {
  return {
    id: session.id,
    title: session.title,
    user_id: session.userId,
    owner_id: session.ownerId,
    project_id: session.projectId,
    engine: session.engine,
    messages: session.messages.map(serializeMessage),
    pending_messages: session.pendingMessages.map(serializeMessage),
    status: session.status as unknown as Record<string, unknown>,
    settings: session.settings as unknown as Record<string, unknown>,
    branches: session.branches,
    checkpoints: session.checkpoints.map((c) => ({
      id: c.id,
      session_id: c.sessionId,
      messages: c.messages.map(serializeMessage),
      tsm_state: c.tsmState,
      created_at: c.createdAt,
    })),
    sticky_notes: session.stickyNotes.map((n) => ({
      id: n.id,
      content: n.content,
      created_at: n.createdAt,
      updated_at: n.updatedAt,
      disabled: n.disabled,
    })),
    current_stream: session.currentStream
      ? {
          stream_id: session.currentStream.streamId,
          message: session.currentStream.message,
          agent_role: session.currentStream.agentRole,
          started_at: session.currentStream.startedAt,
          cancelled: session.currentStream.cancelled,
        }
      : undefined,
    summarization_pending: session.summarizationPending,
    input_cost: session.inputCost,
    output_cost: session.outputCost,
    cache_read_cost: session.cacheReadCost,
    cache_write_cost: session.cacheWriteCost,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    input_tokens: session.inputTokens,
    output_tokens: session.outputTokens,
    total_tokens: session.totalTokens,
    cache_read_tokens: session.cacheReadTokens,
    cache_write_tokens: session.cacheWriteTokens,
    reasoning_tokens: session.reasoningTokens,
  };
}

function deserializeSession(data: SerializedSession): Session {
  return {
    id: data.id,
    title: data.title,
    userId: data.user_id,
    ownerId: data.owner_id,
    projectId: data.project_id,
    engine: data.engine as Session['engine'],
    messages: data.messages.map(deserializeMessage),
    pendingMessages: data.pending_messages.map(deserializeMessage),
    status: data.status as unknown as TsmStatus,
    settings: data.settings as unknown as SessionSettings,
    branches: data.branches as Session['branches'],
    checkpoints: (data.checkpoints || []).map((c: SerializedCheckpoint) => ({
      id: c.id,
      sessionId: c.session_id,
      messages: c.messages.map(deserializeMessage),
      tsmState: c.tsm_state as TsmState,
      createdAt: c.created_at,
    })),
    stickyNotes: (data.sticky_notes || []).map((n: StickyNoteData) => ({
      id: n.id,
      content: n.content,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
      disabled: n.disabled,
    })),
    currentStream: data.current_stream
      ? {
          streamId: data.current_stream.stream_id as string,
          message: data.current_stream.message as string,
          agentRole: data.current_stream.agent_role as string | undefined,
          startedAt: data.current_stream.started_at as string,
          cancelled: data.current_stream.cancelled as boolean,
        }
      : undefined,
    summarizationPending: data.summarization_pending ?? false,
    inputCost: data.input_cost ?? 0,
    outputCost: data.output_cost ?? 0,
    cacheReadCost: data.cache_read_cost ?? 0,
    cacheWriteCost: data.cache_write_cost ?? 0,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    inputTokens: data.input_tokens,
    outputTokens: data.output_tokens,
    totalTokens: data.total_tokens,
    cacheReadTokens: data.cache_read_tokens ?? 0,
    cacheWriteTokens: data.cache_write_tokens ?? 0,
    reasoningTokens: data.reasoning_tokens ?? 0,
  };
}
export class FileStore {
  private _sessionLocks = new Map<string, AsyncLock>();

  constructor(private config: StorageConfig) {}

  private _getLock(sessionId: string): AsyncLock {
    if (!this._sessionLocks.has(sessionId)) {
      this._sessionLocks.set(sessionId, new AsyncLock());
    }
    return this._sessionLocks.get(sessionId)!;
  }

  private _sessionPath(sessionId: string): string {
    return join(this.config.dataDir, 'sessions', `${sessionId}.json`);
  }

  private _sessionsDir(): string {
    return join(this.config.dataDir, 'sessions');
  }

  async load(sessionId: string): Promise<Session | null> {
    const path = this._sessionPath(sessionId);
    try {
      const data = await readFile(path, 'utf-8');
      const parsed = safeJsonParse<SerializedSession>(data, null as unknown as SerializedSession);
      if (!parsed?.id) return null;
      return deserializeSession(parsed);
    } catch {
      return null;
    }
  }

  async save(session: Session): Promise<void> {
    const path = this._sessionPath(session.id);
    const lock = this._getLock(session.id);

    await lock.acquire();
    try {
      await mkdir(dirname(path), { recursive: true });
      const data = JSON.stringify(serializeSession(session), null, 2);
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        data,
      );
    } finally {
      lock.release();
    }
  }

  async delete(sessionId: string): Promise<void> {
    const path = this._sessionPath(sessionId);
    const lock = this._getLock(sessionId);
    await lock.acquire();
    try {
      await unlink(path).catch(() => {});
    } finally {
      lock.release();
    }
  }

  async list(filter?: SessionFilter): Promise<Session[]> {
    const dir = this._sessionsDir();
    const { readdir } = await import('node:fs/promises');
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const sessions: Session[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const session = await this.load(file.replace('.json', ''));
      if (!session) continue;
      if (filter?.projectId && session.projectId !== filter.projectId) continue;
      if (filter?.search) {
        const search = filter.search.toLowerCase();
        // Simple search in messages content
        const matchMsg = session.messages.some(
          (m) => m.content.toLowerCase().includes(search),
        );
        if (!matchMsg) continue;
      }
      sessions.push(session);
    }
    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async exists(sessionId: string): Promise<boolean> {
    return existsSync(this._sessionPath(sessionId));
  }

  async listForUser(userId: string): Promise<Session[]> {
    const all = await this.list();
    return all.filter((s) => s.userId === userId || s.ownerId === userId);
  }
}
