/**
 * Отображение строк PostgreSQL ↔ доменных объектов порта `SessionRepository`
 * (PROP-032, волна 3b).
 *
 * Эталон семантики — файловая реализация (`core/src/storage/file-store.ts`):
 * `serializeSession`/`serializeMessage` и `deserializeSession`/`deserializeMessage`
 * воспроизводятся здесь **дословно** (имена полей в snake_case — как в JSON
 * файлового backend и как в колонках `001_init`). Это осознанная копия: домен и
 * UI полагаются на конкретные детали чтения —
 *   - `normalizeIconKey`/`normalizeColorKey` (невалидные ключи → `undefined`);
 *   - `sessionOrigin || 'user'`;
 *   - числовые дефолты `0` (токены/стоимость), булевы `false`;
 *   - legacy-сообщение без `parts` восстанавливается из `content`/`reasoning`/
 *     `tool_calls`/`tool_call_id`;
 *   - `content` собирается из `parts` (`buildContentFromParts`).
 *
 * Типы домена и утилиты (`normalizeIconKey`/`normalizeColorKey`, `makeTextPart`,
 * `buildContentFromParts`, `generateId`) берутся напрямую из
 * `@itphx/synth-shared` — обычной зависимости драйвера (ADR-097).
 */

import {
  type Checkpoint,
  type Message,
  type Part,
  type Session,
  type SessionReference,
  type StickyNote,
  buildContentFromParts,
  generateId,
  makeTextPart,
  normalizeColorKey,
  normalizeIconKey,
} from '@itphx/synth-shared';

// ── Строки БД (колонки `001_init`) ──────────────────────────────────────────

/** Строка `sessions` (jsonb — уже разобранные значения; `bigint` — строка). */
export interface SessionRow {
  id: string;
  title: string | null;
  icon: string | null;
  color: string | null;
  session_origin: string;
  parent_id: string | null;
  branch_point: string | null;
  plan_approved: boolean | null;
  mode: string | null;
  user_id: string | null;
  owner_id: string | null;
  project_id: string | null;
  todos: unknown;
  prompt_states: unknown;
  obfuscation_map: unknown;
  status: unknown;
  settings: unknown;
  mcp_servers: unknown;
  pending_messages: unknown;
  current_stream: unknown;
  summarization_pending: boolean;
  can_summarize: boolean;
  created_at: string | Date;
  updated_at: string | Date;
  expires_at: string | Date | null;
  archived_at: string | Date | null;
  input_tokens: string | number;
  output_tokens: string | number;
  total_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  reasoning_tokens: string | number;
  input_cost: number | string;
  output_cost: number | string;
  cache_read_cost: number | string;
  cache_write_cost: number | string;
  cache_hit_rate: number | string | null;
}

/** Строка `messages` (или элемент jsonb-массива `pending_messages`/`checkpoints.messages`). */
export interface MessageRow {
  id: string;
  session_id?: string;
  seq: number;
  role: string;
  origin: string;
  source_msg_id?: string | null;
  content: string;
  parts: unknown;
  tool_calls?: unknown;
  tool_call_id?: string | null;
  usage?: unknown;
  metadata?: unknown;
  prompt_meta?: unknown;
  debug_data?: unknown;
  summary_of?: unknown;
  model?: string | null;
  provider?: string | null;
  provider_type?: string | null;
  reasoning?: string | null;
  source?: string | null;
  author?: string | null;
  agent_role?: string | null;
  qa_pass?: boolean | null;
  qa_reason?: string | null;
  disabled?: boolean | null;
  pinned?: boolean | null;
  hidden?: boolean | null;
  ephemeral?: boolean | null;
  created_at: string | Date;
}

/** Строка `session_references` (суррогатный `id` + `ordinal` — порядок добавления). */
export interface SessionReferenceRow {
  id: string;
  session_id: string;
  ref_session_id: string;
  label: string;
  message_range: unknown;
  auto_summary: string | null;
  ordinal: number;
  created_at: string | Date;
}

/** Строка `checkpoints`. */
export interface CheckpointRow {
  id: string;
  session_id: string;
  messages: unknown;
  created_at: string | Date;
}

/** Строка `sticky_notes`. */
export interface StickyNoteRow {
  id: string;
  session_id: string;
  content: string;
  disabled: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Child-данные одной сессии (загружаются батчем, отдельными запросами). */
export interface SessionChildren {
  messages: MessageRow[];
  references: SessionReferenceRow[];
  checkpoints: CheckpointRow[];
  stickyNotes: StickyNoteRow[];
}

/** Пустой набор child-данных (сессия без сообщений/ссылок/чекпоинтов). */
export function emptySessionChildren(): SessionChildren {
  return { messages: [], references: [], checkpoints: [], stickyNotes: [] };
}

// ── Сериализованные формы (как в JSON файловой реализации) ──────────────────

/** Часть сообщения в форме хранения (`{id, type, data}`). */
export interface SerializedPart {
  id: string;
  type: string;
  data: unknown;
}

/** Usage сообщения в форме хранения (snake_case — как в файловом backend). */
export interface SerializedUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

/** Сообщение в форме файловой реализации (совпадает с колонками `messages`). */
export interface SerializedMessage {
  id: string;
  role: string;
  seq: number;
  origin: string;
  source_msg_id?: string;
  parts: SerializedPart[];
  content: string;
  tool_calls?: Record<string, unknown>[];
  tool_call_id?: string;
  created_at: string;
  disabled: boolean;
  pinned: boolean;
  hidden: boolean;
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
  prompt_meta?: unknown;
  summary_of?: number[];
  qa_pass?: boolean;
  qa_reason?: string;
}

// ── Вспомогательные преобразования значений ─────────────────────────────────

/** `timestamptz` (Date) либо уже готовую строку → ISO-строку. */
export function toIso(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'string') return value;
  return '';
}

/** Необязательное время: `null`/пусто → `undefined`. */
export function toIsoOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const iso = toIso(value);
  return iso === '' ? undefined : iso;
}

/** `bigint`/`double precision` (число или строка) → число; `null`/NaN → `fallback`. */
export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** Необязательное число (nullable-колонка). */
export function toNumberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function serializePart(part: Part): SerializedPart {
  return { id: part.id, type: part.type, data: part.data };
}

function deserializePart(data: SerializedPart): Part {
  return { id: data.id, type: data.type as Part['type'], data: data.data };
}

// ── Сообщения ───────────────────────────────────────────────────────────────

/** Сообщение → форма хранения (дословно `serializeMessage` файловой реализации). */
export function serializeMessage(msg: Message): SerializedMessage {
  return {
    id: msg.id,
    role: msg.role,
    seq: msg.seq,
    origin: msg.origin,
    source_msg_id: msg.sourceMsgId,
    parts: (msg.parts ?? []).map(serializePart),
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
    usage: msg.usage
      ? {
          input_tokens: msg.usage.inputTokens,
          output_tokens: msg.usage.outputTokens,
          total_tokens: msg.usage.totalTokens,
          cache_read_tokens: msg.usage.cacheReadTokens,
          cache_write_tokens: msg.usage.cacheWriteTokens,
          reasoning_tokens: msg.usage.reasoningTokens,
        }
      : undefined,
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

/**
 * Сообщение → строка `messages`: к сериализованной форме добавляются обязательные
 * колонки (`session_id`, дефолты NOT NULL-полей, `id`). Значения `undefined` для
 * nullable-колонок остаются как есть — их приводит к `NULL` слой параметров.
 *
 * `seq` — **позиционный**: драйвер передаёт номер сообщения в массиве (`1..n`),
 * поэтому порядок сообщений в БД однозначен даже для legacy-сессий, где у всех
 * сообщений исторически `seq = 0` (снятие коллизии `UNIQUE (session_id, seq)`).
 * Без явного `seq` используется значение домена (или `0`).
 */
export function messageRow(
  msg: Message,
  sessionId: string,
  seq?: number,
): Record<string, unknown> {
  const serialized = serializeMessage(msg) as unknown as Record<string, unknown>;
  return {
    ...serialized,
    id: serialized.id ?? generateId(),
    session_id: sessionId,
    seq: seq ?? serialized.seq ?? 0,
    role: serialized.role ?? 'user',
    origin: serialized.origin ?? 'local',
    content: serialized.content ?? '',
    created_at: serialized.created_at ?? new Date().toISOString(),
    disabled: serialized.disabled ?? false,
    pinned: serialized.pinned ?? false,
    hidden: serialized.hidden ?? false,
    ephemeral: serialized.ephemeral ?? false,
  };
}

/**
 * Строка `messages` (или jsonb-элемент) → доменное сообщение: дословный
 * `deserializeMessage` файловой реализации, включая legacy-ветку без `parts`.
 */
export function deserializeMessage(row: MessageRow): Message {
  const hasParts = Array.isArray(row.parts) && row.parts.length > 0;
  let parts: Part[];

  if (hasParts) {
    parts = (row.parts as SerializedPart[]).map(deserializePart);
  } else {
    parts = [];
    if (row.content) parts.push(makeTextPart(row.content));
    if (row.reasoning) {
      parts.push({ id: generateId(), type: 'reasoning' as const, data: row.reasoning });
    }
    const toolCalls = row.tool_calls as Record<string, unknown>[] | undefined;
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const func = tc.function as { name: string; arguments: unknown } | undefined;
        parts.push({
          id: generateId(),
          type: 'tool_use' as const,
          data: { name: func?.name ?? 'unknown', args: func?.arguments ?? {} },
        });
      }
    }
    if (row.role === 'tool' && row.tool_call_id) {
      parts.push({
        id: generateId(),
        type: 'tool_result' as const,
        data: { content: row.content, isError: false },
      });
    }
  }

  const content = buildContentFromParts(parts);
  const usage = row.usage as SerializedUsage | undefined;

  return {
    id: row.id || generateId(),
    role: row.role as Message['role'],
    seq: row.seq ?? 0,
    origin: (row.origin || 'local') as Message['origin'],
    sourceMsgId: row.source_msg_id ?? undefined,
    parts,
    content,
    toolCalls: (row.tool_calls ?? undefined) as Message['toolCalls'],
    toolCallId: row.tool_call_id ?? undefined,
    createdAt: toIso(row.created_at),
    disabled: row.disabled ?? false,
    pinned: row.pinned ?? false,
    hidden: row.hidden ?? false,
    ephemeral: row.ephemeral ?? undefined,
    debugData: (row.debug_data ?? undefined) as Message['debugData'],
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    providerType: row.provider_type ?? undefined,
    usage: usage
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
          cacheReadTokens: usage.cache_read_tokens,
          cacheWriteTokens: usage.cache_write_tokens,
          reasoningTokens: usage.reasoning_tokens,
        }
      : undefined,
    reasoning: row.reasoning ?? undefined,
    source: (row.source ?? undefined) as Message['source'],
    author: row.author ?? undefined,
    agentRole: row.agent_role ?? undefined,
    metadata: (row.metadata ?? undefined) as Message['metadata'],
    promptMeta: (row.prompt_meta ?? undefined) as Message['promptMeta'],
    summaryOf: (row.summary_of ?? undefined) as Message['summaryOf'],
    // Обратная совместимость: legacy-сессии без полей → undefined (без дефолтов).
    qa_pass: row.qa_pass ?? undefined,
    qa_reason: row.qa_reason ?? undefined,
  };
}

// ── Сессия ──────────────────────────────────────────────────────────────────

/**
 * Сессия → строка `sessions` (колонки — как в `serializeSession` файловой
 * реализации; jsonb-поля остаются нативными значениями, их сериализует слой
 * параметров `jsonParam`).
 */
export function serializeSession(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title ?? null,
    icon: session.icon ?? null,
    color: session.color ?? null,
    session_origin: session.sessionOrigin || 'user',
    parent_id: session.parentId ?? null,
    branch_point: session.branchPoint ?? null,
    plan_approved: session.planApproved ?? null,
    mode: session.mode ?? null,
    user_id: session.userId ?? null,
    owner_id: session.ownerId ?? null,
    project_id: session.projectId ?? null,
    todos: session.todos ?? null,
    prompt_states: session.promptStates ?? null,
    obfuscation_map: session.obfuscationMap ?? null,
    status: session.status ?? {},
    settings: session.settings ?? {},
    mcp_servers: session.mcpServers ?? null,
    pending_messages: (session.pendingMessages ?? []).map((msg) => serializeMessage(msg)),
    current_stream: session.currentStream
      ? {
          stream_id: session.currentStream.streamId,
          message: session.currentStream.message,
          agent_role: session.currentStream.agentRole,
          started_at: session.currentStream.startedAt,
          cancelled: session.currentStream.cancelled,
        }
      : null,
    summarization_pending: session.summarizationPending ?? false,
    can_summarize: session.canSummarize ?? false,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    expires_at: session.expiresAt ?? null,
    archived_at: session.archivedAt ?? null,
    input_tokens: session.inputTokens ?? 0,
    output_tokens: session.outputTokens ?? 0,
    total_tokens: session.totalTokens ?? 0,
    cache_read_tokens: session.cacheReadTokens ?? 0,
    cache_write_tokens: session.cacheWriteTokens ?? 0,
    reasoning_tokens: session.reasoningTokens ?? 0,
    input_cost: session.inputCost ?? 0,
    output_cost: session.outputCost ?? 0,
    cache_read_cost: session.cacheReadCost ?? 0,
    cache_write_cost: session.cacheWriteCost ?? 0,
    cache_hit_rate: session.cacheHitRate ?? null,
  };
}

/**
 * Строка `session_references` ← доменная ссылка. `id` — суррогатный
 * (генерируется при записи), `ordinal` — позиция в списке ссылок сессии
 * (порядок добавления, `addReference` — append; дубликаты разрешены).
 */
export function referenceRow(
  sessionId: string,
  ref: SessionReference,
  ordinal: number,
): Record<string, unknown> {
  return {
    id: generateId(),
    session_id: sessionId,
    ref_session_id: ref.sessionId,
    label: ref.label,
    message_range: ref.messageRange,
    auto_summary: ref.autoSummary ?? null,
    ordinal,
    created_at: ref.createdAt,
  };
}

/** Строка `session_references` → доменная ссылка. */
export function deserializeReference(row: SessionReferenceRow): SessionReference {
  return {
    type: 'session_reference',
    sessionId: row.ref_session_id,
    label: row.label,
    messageRange: row.message_range as [number, number],
    autoSummary: row.auto_summary ?? undefined,
    createdAt: toIso(row.created_at),
  };
}

/** Строка `checkpoints` ← доменный чекпоинт (сообщения — jsonb-массив). */
export function checkpointRow(cp: Checkpoint): Record<string, unknown> {
  return {
    id: cp.id,
    session_id: cp.sessionId,
    messages: cp.messages.map((msg) => serializeMessage(msg)),
    created_at: cp.createdAt,
  };
}

/** Строка `checkpoints` → доменный чекпоинт. */
export function deserializeCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    sessionId: row.session_id,
    messages: ((row.messages as MessageRow[] | null) ?? []).map(deserializeMessage),
    createdAt: toIso(row.created_at),
  };
}

/** Строка `sticky_notes` ← доменная заметка. */
export function stickyNoteRow(sessionId: string, note: StickyNote): Record<string, unknown> {
  return {
    id: note.id,
    session_id: sessionId,
    content: note.content,
    disabled: note.disabled,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
  };
}

/** Строка `sticky_notes` → доменная заметка. */
export function deserializeStickyNote(row: StickyNoteRow): StickyNote {
  return {
    id: row.id,
    content: row.content,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    disabled: row.disabled,
  };
}

/**
 * Строка `sessions` + child-данные → доменная сессия: дословный
 * `deserializeSession` файловой реализации (нормализация иконки/цвета,
 * `sessionOrigin || 'user'`, числовые/булевы дефолты, сборка
 * `references`/`checkpoints`/`stickyNotes`).
 */
export function deserializeSession(
  row: SessionRow,
  children: SessionChildren,
): Session {
  const currentStream = row.current_stream as Record<string, unknown> | null | undefined;

  return {
    id: row.id,
    title: row.title ?? undefined,
    icon: normalizeIconKey(row.icon),
    color: normalizeColorKey(row.color),
    parentId: row.parent_id ?? undefined,
    branchPoint: row.branch_point ?? undefined,
    planApproved: row.plan_approved ?? undefined,
    mode: (row.mode ?? undefined) as Session['mode'],
    todos: (row.todos ?? undefined) as Session['todos'],
    promptStates: (row.prompt_states ?? undefined) as Session['promptStates'],
    obfuscationMap: (row.obfuscation_map ?? undefined) as Session['obfuscationMap'],
    sessionOrigin: (row.session_origin as Session['sessionOrigin']) || 'user',
    userId: row.user_id ?? undefined,
    ownerId: row.owner_id ?? undefined,
    projectId: row.project_id ?? undefined,
    messages: children.messages.map(deserializeMessage),
    pendingMessages: ((row.pending_messages as MessageRow[] | null) ?? []).map(deserializeMessage),
    status: (row.status ?? {}) as Session['status'],
    settings: (row.settings ?? {}) as Session['settings'],
    mcpServers: (row.mcp_servers ?? undefined) as Session['mcpServers'],
    checkpoints: children.checkpoints.map(deserializeCheckpoint),
    stickyNotes: children.stickyNotes.map(deserializeStickyNote),
    references: children.references.map(deserializeReference),
    currentStream: currentStream
      ? {
          streamId: currentStream.stream_id as string,
          message: currentStream.message as string,
          agentRole: currentStream.agent_role as string | undefined,
          startedAt: currentStream.started_at as string,
          cancelled: currentStream.cancelled as boolean,
        }
      : undefined,
    summarizationPending: row.summarization_pending ?? false,
    canSummarize: row.can_summarize ?? false,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    expiresAt: toIsoOrUndefined(row.expires_at),
    archivedAt: toIsoOrUndefined(row.archived_at),
    inputTokens: toNumber(row.input_tokens),
    outputTokens: toNumber(row.output_tokens),
    totalTokens: toNumber(row.total_tokens),
    cacheReadTokens: toNumber(row.cache_read_tokens),
    cacheWriteTokens: toNumber(row.cache_write_tokens),
    reasoningTokens: toNumber(row.reasoning_tokens),
    inputCost: toNumber(row.input_cost),
    outputCost: toNumber(row.output_cost),
    cacheReadCost: toNumber(row.cache_read_cost),
    cacheWriteCost: toNumber(row.cache_write_cost),
    cacheHitRate: toNumberOrUndefined(row.cache_hit_rate),
  };
}

/**
 * Строка `sessions` → доменная сессия **без истории** (`SessionRepository.listLight`,
 * PROP-032): `messages`/`pendingMessages`/`checkpoints` пусты, child-таблицы не
 * читаются. Метаданные (id/статус/settings/projectId/expiresAt/…) идентичны
 * `deserializeSession` — механика переиспользуется.
 */
export function deserializeSessionLight(row: SessionRow): Session {
  const session = deserializeSession(row, emptySessionChildren());
  session.messages = [];
  session.pendingMessages = [];
  session.checkpoints = [];
  return session;
}
