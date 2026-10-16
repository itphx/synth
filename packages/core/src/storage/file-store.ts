import { readFile, writeFile, rename, mkdir, unlink, access, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Session, Message, SessionStatus, SessionSettings, Part, SessionOrigin, SessionReference, PromptState, PromptMeta } from '@itphx/synth-shared';
import { atomicWrite, safeJsonParse, AsyncLock, generateId, makeTextPart, buildContentFromParts, normalizeIconKey, normalizeColorKey } from '@itphx/synth-shared';
import type { SessionFilter, SessionRepository } from './ports/session-repository.js';

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

interface SerializedPart {
  id: string;
  type: string;
  data: unknown;
}

interface SerializedMessage {
  id?: string;
  role: string;
  seq?: number;
  origin?: string;
  source_msg_id?: string;
  parts?: SerializedPart[];
  content: string;
  tool_calls?: Record<string, unknown>[];
  tool_call_id?: string;
  created_at: string;
  disabled: boolean;
  pinned: boolean;
  hidden: boolean;
  /** ADR-046 §7.1: локальные `/`-команды — вне LLM-контекста. */
  ephemeral?: boolean;
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
  /** ADR-070 §2.4: предсказание/валидация prompt-cache (camelCase внутри). */
  prompt_meta?: PromptMeta;
  summary_of?: number[];
  /** ADR-034: результат проверки качества ответа (QC-бейдж в UI). */
  qa_pass?: boolean;
  qa_reason?: string;
}

interface SerializedSessionReference {
  session_id: string;
  label: string;
  message_range: [number, number];
  auto_summary?: string;
  created_at: string;
}

interface SerializedSession {
  id: string;
  title?: string;
  icon?: string;
  color?: string;
  parent_id?: string;
  branch_point?: string;
  plan_approved?: boolean;
  mode?: string;
  todos?: unknown[];
  /** ADR-070 §2.4/§2.7: состояние промпта per-agent. */
  prompt_states?: Record<string, PromptState>;
  /** Карта обфускации LLM Gateway (ADR-036). */
  obfuscation_map?: Record<string, string>;
  session_origin?: string;
  user_id?: string;
  owner_id?: string;
  project_id?: string;
  messages: SerializedMessage[];
  pending_messages: SerializedMessage[];
  status: Record<string, unknown>;
  settings: Record<string, unknown>;
  references: SerializedSessionReference[];
  branches: unknown[];
  checkpoints: SerializedCheckpoint[];
  sticky_notes: StickyNoteData[];
  current_stream?: Record<string, unknown>;
  summarization_pending: boolean;
  can_summarize: boolean;
  input_cost: number;
  output_cost: number;
  cache_read_cost: number;
  cache_write_cost: number;
  cache_hit_rate?: number;
  created_at: string;
  updated_at: string;
  /** ADR-089: время авто-архивации ephemeral-сессии. */
  expires_at?: string;
  /** ADR-089: время архивации сессии. */
  archived_at?: string;
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
  created_at: string;
}

function serializePart(part: Part): SerializedPart {
  return {
    id: part.id,
    type: part.type,
    data: part.data,
  };
}

function deserializePart(data: SerializedPart): Part {
  return {
    id: data.id,
    type: data.type as Part['type'],
    data: data.data,
  };
}

function serializeMessage(msg: Message): SerializedMessage {
  return {
    id: msg.id,
    role: msg.role,
    seq: msg.seq,
    origin: msg.origin,
    source_msg_id: msg.sourceMsgId,
    parts: msg.parts.map(serializePart),
    content: msg.content,
    tool_calls: msg.toolCalls,
    tool_call_id: msg.toolCallId,
    created_at: msg.createdAt,
    disabled: msg.disabled,
    pinned: msg.pinned,
    hidden: msg.hidden,
    ephemeral: msg.ephemeral,
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
    prompt_meta: msg.promptMeta,
    summary_of: msg.summaryOf,
    qa_pass: msg.qa_pass,
    qa_reason: msg.qa_reason,
  };
}

function deserializeMessage(data: SerializedMessage): Message {
  const hasParts = Array.isArray(data.parts) && data.parts.length > 0;
  let parts: Part[];

  if (hasParts) {
    parts = data.parts!.map(deserializePart);
  } else {
    parts = [];
    if (data.content) {
      parts.push(makeTextPart(data.content));
    }
    if (data.reasoning) {
      parts.push({ id: generateId(), type: 'reasoning' as const, data: data.reasoning });
    }
    if (data.tool_calls && data.tool_calls.length > 0) {
      for (const tc of data.tool_calls) {
        const func = tc.function as { name: string; arguments: unknown } | undefined;
        parts.push({
          id: generateId(),
          type: 'tool_use' as const,
          data: { name: func?.name ?? 'unknown', args: func?.arguments ?? {} },
        });
      }
    }
    if (data.role === 'tool' && data.tool_call_id) {
      parts.push({
        id: generateId(),
        type: 'tool_result' as const,
        data: { content: data.content, isError: false },
      });
    }
  }

  const content = buildContentFromParts(parts);

  return {
    id: data.id || generateId(),
    role: data.role as Message['role'],
    seq: data.seq ?? 0,
    origin: (data.origin || 'local') as Message['origin'],
    sourceMsgId: data.source_msg_id,
    parts,
    content,
    toolCalls: data.tool_calls,
    toolCallId: data.tool_call_id,
    createdAt: data.created_at,
    disabled: data.disabled,
    pinned: data.pinned,
    hidden: data.hidden,
    ephemeral: data.ephemeral,
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
    promptMeta: data.prompt_meta,
    summaryOf: data.summary_of,
    // Обратная совместимость: legacy-сессии без полей → undefined (без дефолтов).
    qa_pass: data.qa_pass,
    qa_reason: data.qa_reason,
  };
}

function serializeSession(session: Session): SerializedSession {
  return {
    id: session.id,
    title: session.title,
    icon: session.icon,
    color: session.color,
    parent_id: session.parentId,
    branch_point: session.branchPoint,
    plan_approved: session.planApproved,
    mode: session.mode,
    todos: session.todos,
    prompt_states: session.promptStates,
    obfuscation_map: session.obfuscationMap,
    session_origin: session.sessionOrigin,
    user_id: session.userId,
    owner_id: session.ownerId,
    project_id: session.projectId,
    messages: session.messages.map(serializeMessage),
    pending_messages: session.pendingMessages.map(serializeMessage),
    status: session.status as unknown as Record<string, unknown>,
    settings: session.settings as unknown as Record<string, unknown>,
    references: (session.references || []).map((ref) => ({
      session_id: ref.sessionId,
      label: ref.label,
      message_range: ref.messageRange,
      auto_summary: ref.autoSummary,
      created_at: ref.createdAt,
    })),
    branches: [],
    checkpoints: session.checkpoints.map((c) => ({
      id: c.id,
      session_id: c.sessionId,
      messages: c.messages.map(serializeMessage),
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
    can_summarize: session.canSummarize,
    input_cost: session.inputCost,
    output_cost: session.outputCost,
    cache_read_cost: session.cacheReadCost,
    cache_write_cost: session.cacheWriteCost,
    cache_hit_rate: session.cacheHitRate,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    expires_at: session.expiresAt,
    archived_at: session.archivedAt,
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
    icon: normalizeIconKey(data.icon),
    color: normalizeColorKey(data.color),
    parentId: data.parent_id,
    branchPoint: data.branch_point,
    planApproved: data.plan_approved,
    mode: data.mode as Session['mode'],
    todos: data.todos as Session['todos'],
    promptStates: data.prompt_states,
    obfuscationMap: data.obfuscation_map,
    sessionOrigin: (data.session_origin as SessionOrigin) || 'user',
    userId: data.user_id,
    ownerId: data.owner_id,
    projectId: data.project_id,
    messages: data.messages.map(deserializeMessage),
    pendingMessages: data.pending_messages.map(deserializeMessage),
    status: data.status as unknown as SessionStatus,
    settings: data.settings as unknown as SessionSettings,
    checkpoints: (data.checkpoints || []).map((c: SerializedCheckpoint) => ({
      id: c.id,
      sessionId: c.session_id,
      messages: c.messages.map(deserializeMessage),
      createdAt: c.created_at,
    })),
    references: (data.references || []).map((ref: SerializedSessionReference): SessionReference => ({
      type: 'session_reference' as const,
      sessionId: ref.session_id,
      label: ref.label,
      messageRange: ref.message_range,
      autoSummary: ref.auto_summary,
      createdAt: ref.created_at,
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
    canSummarize: data.can_summarize ?? false,
    inputCost: data.input_cost ?? 0,
    outputCost: data.output_cost ?? 0,
    cacheReadCost: data.cache_read_cost ?? 0,
    cacheWriteCost: data.cache_write_cost ?? 0,
    cacheHitRate: data.cache_hit_rate,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    expiresAt: data.expires_at,
    archivedAt: data.archived_at,
    inputTokens: data.input_tokens,
    outputTokens: data.output_tokens,
    totalTokens: data.total_tokens,
    cacheReadTokens: data.cache_read_tokens ?? 0,
    cacheWriteTokens: data.cache_write_tokens ?? 0,
    reasoningTokens: data.reasoning_tokens ?? 0,
  };
}

export class FileStore implements SessionRepository {
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
      await unlink(path).catch((err) => {
        console.warn(`[FileStore] Не удалось удалить файл сессии ${sessionId}: ${String(err)}`);
      });
    } finally {
      lock.release();
      this._sessionLocks.delete(sessionId);
    }
  }

  async list(filter?: SessionFilter): Promise<Session[]> {
    const dir = this._sessionsDir();
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const sessions: Session[] = [];

    const loaded = await Promise.all(jsonFiles.map((file) => this.load(file.replace('.json', ''))));

    for (const session of loaded) {
      if (!session) continue;
      if (filter?.projectId && session.projectId !== filter.projectId) continue;
      if (filter?.parentId !== undefined) {
        if (filter.parentId === null && session.parentId) continue;
        if (filter.parentId !== null && session.parentId !== filter.parentId) continue;
      }
      if (filter?.search) {
        const search = filter.search.toLowerCase();
        const matchTitle = session.title?.toLowerCase().includes(search);
        const matchMsg = session.messages.some(
          (m) => m.content.toLowerCase().includes(search),
        );
        if (!matchTitle && !matchMsg) continue;
      }
      sessions.push(session);
    }
    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /**
   * Лёгкий список (порт `SessionRepository.listLight`): тот же набор id и порядок,
   * что у `list`, но `messages`/`pendingMessages`/`checkpoints` очищены. Сессия
   * хранится одним JSON-файлом, поэтому `JSON.parse` неизбежно читает историю —
   * экономится только десериализация сообщений; для БД-бэкенда (PROP-032) это
   * полноценная выборка без join.
   */
  async listLight(filter?: SessionFilter): Promise<Session[]> {
    const sessions = await this.list(filter);
    return sessions.map((s) => ({ ...s, messages: [], pendingMessages: [], checkpoints: [] }));
  }

  async exists(sessionId: string): Promise<boolean> {
    try {
      await access(this._sessionPath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Поиск сессий по содержимому (заголовок + сообщения) — доменный метод порта
   * `SessionRepository` (для SQL-бэкенда PROP-032: полнотекстовый поиск). Файловая
   * реализация делегирует сканирующему `list`.
   */
  async search(query: string, filter?: SessionFilter): Promise<Session[]> {
    return this.list({ ...filter, search: query });
  }

  async listForUser(userId: string, ownerIds: string[] = []): Promise<Session[]> {
    const all = await this.list();
    if (ownerIds.length === 0) return all.filter((s) => s.userId === userId || s.ownerId === userId);
    // ADR-089 (standalone): `ownerIds` — дополнительные id, трактуемые как владелец
    // (legacy-UUID профиля `local`, нормализованный при чтении). Без записи данных.
    const ids = new Set<string>([userId, ...ownerIds]);
    const match = (id: string | undefined): boolean => id !== undefined && ids.has(id);
    return all.filter((s) => match(s.userId) || match(s.ownerId));
  }

  /**
   * ADR-089: сессии владельца ИЛИ любого из его проектов (командная видимость).
   * `projectIds` — проекты, участником которых является пользователь; пустой
   * список эквивалентен `listForUser` (только свои сессии). `ownerIds` —
   * дополнительные id владельца (legacy-нормализация, см. `listForUser`).
   */
  async listForUserScope(userId: string, projectIds: string[], ownerIds: string[] = []): Promise<Session[]> {
    if (projectIds.length === 0) return this.listForUser(userId, ownerIds);
    const all = await this.list();
    const ids = new Set<string>([userId, ...ownerIds]);
    const match = (id: string | undefined): boolean => id !== undefined && ids.has(id);
    return all.filter(
      (s) =>
        match(s.userId)
        || match(s.ownerId)
        || (s.projectId !== undefined && projectIds.includes(s.projectId)),
    );
  }

  async addReference(sessionId: string, ref: SessionReference): Promise<void> {
    const lock = this._getLock(sessionId);
    await lock.acquire();
    try {
      const session = await this.load(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      if (!session.references) session.references = [];
      session.references.push(ref);
      await this.save(session);
    } finally {
      lock.release();
    }
  }

  async removeReference(sessionId: string, refSessionId: string): Promise<void> {
    const lock = this._getLock(sessionId);
    await lock.acquire();
    try {
      const session = await this.load(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      if (session.references) {
        session.references = session.references.filter((r) => r.sessionId !== refSessionId);
      }
      await this.save(session);
    } finally {
      lock.release();
    }
  }

  async getReferences(sessionId: string): Promise<SessionReference[]> {
    const session = await this.load(sessionId);
    if (!session) return [];
    return session.references || [];
  }
}
