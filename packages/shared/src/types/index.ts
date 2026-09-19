import type { ToolCapability } from './tools.js';
import type { PermissionConfig, McpServerToolSettings } from './permission.js';

// Core enums
export enum MessageRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
  SUMMARY = 'summary',
  DEBUG = 'debug',
  INFO = 'info',
  ERROR = 'error',
}

export enum GlobalRole {
  ADMIN = 'ADMIN',
  USER = 'USER',
  LEAD = 'LEAD',
  AUDITOR = 'AUDITOR',
}

export enum ProjectRole {
  OWNER = 'owner',
  EDITOR = 'editor',
  VIEWER = 'viewer',
}

export enum StatusMessageType {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  STREAM = 'stream',
}

// --- Part ---
export type PartType = 'text' | 'tool_use' | 'tool_result' | 'reasoning' | 'session_reference';

export interface Part {
  id: string;
  type: PartType;
  data: unknown;
}

// --- MessageOrigin ---
export type MessageOrigin = 'local' | 'inherited' | 'merged' | 'crosspost';

/**
 * metadata.i18n сообщения/tool_result (i18n ядра): стабильный en-like ключ
 * системного сообщения + параметры подстановки. UI рендерит перевод по ключу
 * (formatMessage), fallback — на content (en). Плейсхолдеры — `{param}`.
 */
export interface MessageI18n {
  key: string;
  params?: Record<string, string>;
}

// --- SessionOrigin ---
export type SessionOrigin = 'user' | 'fork' | 'subagent';

// --- Prompt state (AD-070 §2.4) ---
/** Состояние одного блока системного промпта (хэш/размер для диагностики). */
export interface PromptBlockState {
  key: string;
  hash: string;
  chars: number;
}

/**
 * AD-070 §2.4: состояние системного промпта per-agent. Хранится в сессии
 * (`Session.promptStates`) и пишется только при смене generation.
 */
export interface PromptState {
  generation: number;
  /** sha256(stablePrefix). */
  staticPrefixHash: string;
  /** Закреплённые байты кэшируемого префикса. */
  staticPrefix: string;
  /** sha256(полного system). */
  systemHash: string;
  blocks: PromptBlockState[];
  reason: 'init' | 'compaction' | 'generation-change' | 'override' | 'agent-change';
  updatedAt: string;
}

/** AD-070 §2.4: компактная мета промпта, кладётся в assistant-сообщение. */
export interface PromptMeta {
  /** agentKey, к которому относится ход (agentRole или `__default__`). */
  agentRole?: string;
  generation: number;
  /** Предсказание по staticPrefixHash. */
  expected: 'hit' | 'miss';
  /** Фактический cacheRead из usage. */
  cachedTokens: number;
  /** expected подтверждён/опровергнут фактом. */
  validated: boolean;
}

// --- Prompt manifest (AD-070 §2.5) ---
/** Тир консистентности блока системного промпта (AD-070 §2.1). */
export type PromptTier = 'stable' | 'context' | 'volatile';

/** Статус блока в манифесте промпта. */
export type PromptManifestStatus = 'loaded' | 'truncated' | 'empty' | 'blocked' | 'suppressed';

/** AD-070 §2.5: запись манифеста — источник системного промпта. */
export interface PromptManifestEntry {
  key: string;
  label: string;
  tier: PromptTier;
  chars: number;
  /** Эвристика: Math.ceil(chars / 4). */
  estTokens: number;
  status: PromptManifestStatus;
  provenance?: string;
}

/** AD-070 §2.5: манифест состава системного промпта (для API/UI/тестов). */
export interface PromptManifest {
  generation?: number;
  totalChars: number;
  estTokens: number;
  staticPrefixChars: number;
  entries: PromptManifestEntry[];
}

// --- Session statistics (AD-070 §2.6) ---
/**
 * Статистика по агенту в рамках сессии (`GET /sessions/:id/stats`).
 * Usage — по сообщениям агента; `subagent_*` — рекурсивно подтянутый usage
 * дочерних сессий (tool `task`), инициированных агентом.
 */
export interface SessionAgentStats {
  agent_role: string;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  /** cache_read / input (0 при input = 0). */
  cache_hit_rate: number;
  duration_ms: number;
  /** output_tokens / (duration_ms / 1000); 0 при отсутствии длительности. */
  output_tps: number;
  subagent_sessions: number;
  subagent_tokens: number;
}

/** Статистика по автору user-сообщений (атрибуция usage последующего ответа). */
export interface SessionUserStats {
  author: string;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  cache_hit_rate: number;
}

/** Ответ `GET /api/v2/sessions/:id/stats`. */
export interface SessionStats {
  session_id: string;
  agents: SessionAgentStats[];
  users: SessionUserStats[];
}

// --- Message ---
export interface Message {
  id: string;
  role: MessageRole;
  seq: number;
  origin: MessageOrigin;
  sourceMsgId?: string;
  parts: Part[];
  content: string;
  toolCalls?: Record<string, unknown>[];
  toolCallId?: string;
  createdAt: string;
  disabled: boolean;
  pinned: boolean;
  hidden: boolean;
  debugData?: Record<string, unknown>;
  model?: string;
  provider?: string;
  providerType?: string;
  usage?: TokenUsage;
  reasoning?: string;
  source?: 'web' | 'cli' | 'api';
  author?: string;
  agentRole?: string;
  metadata?: Record<string, unknown>;
  /** AD-070 §2.4: предсказание/валидация prompt-cache для этого хода. */
  promptMeta?: PromptMeta;
  summaryOf?: number[];
  qa_pass?: boolean;
  qa_reason?: string;
}

// --- Session ---
export interface SessionStatus {
  blocked?: string;
  blockedAt?: string;
}

export const PLAN_MODES = ['auto', 'strict', 'off'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

export const SESSION_MODES = ['plan', 'act', 'yolo'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_PRIORITIES = ['high', 'medium', 'low'] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  /** Связь с пунктом плана проекта (AD-039). */
  planItemId?: string;
}

export type ReasoningLevel = 'default' | 'none' | 'low' | 'medium' | 'high';

export interface SessionSettings {
  provider?: string;
  model?: string;
  /** Уровень размышлений модели. Для openai/generic — reasoning_effort, anthropic — thinking, ollama — think. */
  reasoningLevel?: ReasoningLevel;
  temperature: number;
  maxTokens: number;
  systemPrompt?: string;
  debugEnabled: boolean;
  streamEnabled: boolean;
  agentRole?: string;
  mcpServers?: string[];
  contextOptimization: 'none' | 'sliding_window' | 'summarization' | 'sticky_notes';
  slidingWindowMode: 'messages' | 'tokens';
  slidingWindowMessageLimit: number;
  slidingWindowTokenThreshold: number;
  summarizationEnabled: boolean;
  summarizationTriggerMode: 'messages' | 'tokens';
  summarizeAfterN: number;
  summarizeTokenThreshold: number;
  summarizationHeadMessages: number;
  summarizationTailMessages: number;
  showInterview: boolean;
  websocketEnabled: boolean;
  language?: string;
  // === Роутинг (AD-034) ===
  routingEnabled: boolean;
  routingStrategy: 'content' | 'cost' | 'content+cost' | 'auto';
  routingContent: {
    coding?: { provider: string; model: string };
    chat?: { provider: string; model: string };
    research?: { provider: string; model: string };
  };
  routingEscalation: {
    enabled: boolean;
    fallbackProvider: string;
    fallbackModel: string;
    checks: ('min_length' | 'constraint' | 'self_check')[];
    minLength: number;
  };
  routingCost: {
    enabled: boolean;
    cheapProvider: string;
    cheapModel: string;
    maxCheapTokens: number;
  };
  subagentRouting: {
    enabled: boolean;
    model?: string;
    provider?: string;
  };
  /** Категория, установленная моделью через classify_conversation. Приоритет над keyword-классификатором. */
  routingCategory?: 'coding' | 'chat' | 'research';
  // === Микро-слой (AD-035) ===
  /** Включить микро-слой: обработка простых запросов без LLM (приветствия, классификация, enum-решения). */
  microFirst: boolean;
  /** Порог уверенности микро-слоя. confidence >= порог → OK, иначе UNSURE → LLM fallback. */
  microConfidenceThreshold: number;
  /** Включить embedding-слой в микро-каскаде. */
  embeddingEnabled: boolean;
  /** Провайдер для embedding-модели. */
  embedProvider?: string;
  /** Модель для embedding. */
  embedModel?: string;
  // === Permissions (AD-029) ===
  /** Гранулярные permissions сессии. Приоритетнее глобальной секции permission в config.yaml. */
  permission?: PermissionConfig;
  /** Доступность MCP-инструментов по режимам plan/act (serverName → настройки). */
  mcpToolSettings?: Record<string, McpServerToolSettings>;
  // === Plan/Act (AD-025, AD-028) ===
  /** Строгость цикла Plan→Build: auto — модель сама решает, strict — план обязателен, off — планирование отключено. */
  planMode?: PlanMode;
  // === LLM Gateway (AD-036) ===
  /** Per-session override LLM Gateway (AD-036). */
  llmGateway?: { enabled?: boolean };
}

export interface StreamInfo {
  streamId: string;
  message: string;
  agentRole?: string;
  startedAt: string;
  cancelled: boolean;
}

export interface Branch {
  id: string;
  parentId?: string;
  name: string;
  messages: Message[];
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  messages: Message[];
  createdAt: string;
}

export interface StickyNote {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  disabled: boolean;
}

export interface SessionReference {
  type: 'session_reference';
  sessionId: string;
  label: string;
  messageRange: [number, number];
  autoSummary?: string;
  createdAt: string;
}

export interface Session {
  id: string;
  title?: string;
  sessionOrigin: SessionOrigin;
  parentId?: string;
  branchPoint?: string;
  /** Флаг «план утверждён через plan_exit» (AD-039), нужен для strict-режима AD-028. */
  planApproved?: boolean;
  /** Текущий runtime-режим сессии (AD-025): 'plan' — только чтение, 'act' — полный доступ. */
  mode?: SessionMode;
  /** Todo-список сессии (тул todo_write), как в OpenCode. */
  todos?: TodoItem[];
  /**
   * AD-070 §2.4/§2.7: состояние промпта per-agent (ключ — agentRole или
   * `__default__`). Пишется только при смене generation.
   */
  promptStates?: Record<string, PromptState>;
  /** Карта обфускации LLM Gateway (AD-036). Живёт всю сессию независимо от глобального тумблера. */
  obfuscationMap?: Record<string, string>;
  userId?: string;
  ownerId?: string;
  projectId?: string;
  engine: 'synth' | 'opencode' | 'cline';
  messages: Message[];
  pendingMessages: Message[];
  status: SessionStatus;
  settings: SessionSettings;
  mcpServers?: string[];
  checkpoints: Checkpoint[];
  stickyNotes: StickyNote[];
  references: SessionReference[];
  currentStream?: StreamInfo;
  summarizationPending: boolean;
  canSummarize: boolean;
  createdAt: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  /**
   * AD-070 §2.3: доля кэшированных входных токенов сессии —
   * `cacheReadTokens / inputTokens` (0 при `inputTokens === 0`).
   */
  cacheHitRate?: number;
}

// --- Git ---
export interface GitRepoConfig {
  path: string;
  defaultBranch?: string;
}

export interface RepoStatus {
  path: string;
  isRepo: boolean;
  currentBranch?: string;
  lastCommitAt?: string;
  lastCommitSubject?: string;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
  relativeDate: string;
  branch: string;
}

export interface CommitFileInfo {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface CommitDetail extends CommitInfo {
  files: CommitFileInfo[];
  diff: string;
}

// --- Project ---
export interface StatusMessage {
  id: string;
  text: string;
  type: StatusMessageType;
  timestamp: string;
}

export interface ProjectLogEntry {
  id: string;
  text: string;
  createdAt: string;
  sessionId?: string;
  author?: string;
}

export interface Project {
  id: string;
  name: string;
  ownerId: string;
  members: Record<string, ProjectRole>;
  description: string;
  currentTask: string;
  invariants: string;
  icon?: string;
  color?: string;
  workspace?: string;
  repos?: GitRepoConfig[];
  statusMessages: StatusMessage[];
  /** Kanban-план проекта (AD-039). Владеет проектом, а не сессией. */
  plan?: ProjectPlan;
  /** Лог работ проекта (ведётся моделью через project_log_write). */
  log?: ProjectLogEntry[];
  createdAt: string;
  updatedAt: string;
}

// --- Plan (AD-039) ---
export interface PlanColumn {
  id: string;
  name: string;
  order: number;
  wipLimit?: number;
}

export interface PlanDependency {
  projectId?: string;       // пусто = тот же проект
  itemId: string;           // пункт, от которого зависит текущий
  relation: 'blocked_by' | 'blocks' | 'relates_to';
}

export interface PlanItem {
  id: string;
  title: string;
  description?: string;
  columnId: string;         // статус = колонка
  priority: 'high' | 'medium' | 'low';
  order: number;
  dependsOn: PlanDependency[];
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPlan {
  version: number;
  updatedAt: string;
  columns: PlanColumn[];
  items: PlanItem[];
}

// --- User & Auth ---
export interface User {
  id: string;
  username: string;
  email?: string;
  roles: string[];
  preferredLanguage: string;
  createdAt: string;
  teamRole: string;
  notes: string;
  interviewCompleted: boolean;
  isLocal?: boolean;
  isTestUser?: boolean;
}

export interface TestUser {
  username: string;
  apiKey: string;
  roles: string[];
  displayName: string;
}

export interface AuthConfig {
  debugMode: boolean;
  apiKey?: string;
  testUsers?: TestUser[];
  sessionMaxAgeMinutes: number;
  oidc?: {
    enabled: boolean;
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** Public client_id для локального CLI/core (ROPC/device flow). Не секрет. */
    cliClientId?: string;
  };
}

// --- Agent ---
export type AgentMode = 'primary' | 'subagent' | 'system';

export interface AgentDefinition {
  id: string;
  displayName: string;
  contextFile?: string;
  capabilities: ToolCapability[];
  enabled: boolean;
  provider?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  /** Уровень размышлений агента. Не задано — используется session.settings.reasoningLevel. */
  reasoningLevel?: ReasoningLevel;
  agentMode?: AgentMode | AgentMode[];
  subagentPrompt?: string;
  maxSteps?: number; // 0 = без ограничений, undefined = default (0 для primary, 15 для subagent)
  sshKeys: string[];
  isOverridden: boolean;
  icon?: string;
  color?: string;
  description?: string;
}

// --- Provider ---
export interface ProviderConfig {
  name: string;
  type: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  timeout?: number;
  enabled?: boolean;
  icon?: string;
}

export type ContextSource = 'api' | 'reference' | 'manual' | 'unknown';

export type ContextCategory = 'user' | 'role' | 'system';

export interface ContextFileInfo {
  filename: string;
  isSystem: boolean;
  isOverridden: boolean;
  category: ContextCategory;
  size: number;
  modifiedAt?: number;
  enabled?: boolean;
}

export interface ContextFileContent {
  filename: string;
  content: string;
  isSystem: boolean;
  isOverridden: boolean;
  category: ContextCategory;
}

export interface ProfileData {
  id: string;
  username: string;
  email?: string;
  phone?: string;
  roles: string[];
  teamRoles: string[];
  isActive: boolean;
  preferences: Record<string, unknown>;
  notes: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
  lastLogin?: string;
}

export interface InterviewQuestion {
  id: string;
  question: string;
  order: number;
}

export interface InterviewStatus {
  inProgress: boolean;
  completed: boolean;
  currentQuestion?: InterviewQuestion;
  totalQuestions: number;
  answered: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  description?: string;
  enabled: boolean;
  isDefault?: boolean;
  contextWindow?: number;
  contextSource?: ContextSource;
  maxOutputTokens?: number;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
}

// --- LLM ---
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface LLMChunk {
  content: string;
  isFinal: boolean;
  usage?: TokenUsage;
  toolCalls?: Record<string, unknown>[];
  reasoning?: string;
  model?: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: TokenUsage;
  toolCalls?: Record<string, unknown>[];
  reasoning?: string;
  debugInfo?: Record<string, unknown>;
}

// --- Queue ---
export interface QueueItem {
  message: Message;
  streamId: string;
  enqueuedAt: string;
}

// --- Event types ---
export type EventType =
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'session.renamed'
  | 'session.forked'
  | 'session.fork.created'
  | 'session.reference.added'
  | 'session.reference.removed'
  | 'session.messages.merged'
  | 'session.moved'
  | 'message.added'
  | 'message.updated'
  | 'child.message.added'
  | 'child.session.updated'
  | 'stream.start'
  | 'stream.chunk'
  | 'stream.done'
  | 'stream.cancelled'
  | 'stream.error'
  | 'stream.retry'
  | 'queue.stalled'
  | 'message.queued'
  | 'permission.asked'
  | 'permission.replied'
  | 'permission.hold'
  | 'question.asked'
  | 'question.replied'
  | 'context.summarization_pending'
  | 'context.summarized'
  | 'context.sliding_window_applied'
  | 'context.limit_warning'
  | 'context.sticky_note_added'
  | 'context.sticky_note_updated'
  | 'context.sticky_note_deleted'
  | 'tool_call.started'
  | 'tool_call.result'
  | 'tool_call.loop'
  | 'subagent.progress'
  | 'subagent.retry'
  | 'subagent.resume.started'
  | 'subagent.resume.finished'
  | 'permission.asked'
  | 'permission.replied'
  | 'permission.denied'
  | 'message.quality_check'
  | 'session.routing_category'
  | 'plan.approved'
  | 'todos.updated'
  | 'error';

export interface BusEvent {
  type: EventType;
  sessionId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// --- File System ---
export enum FsErrorCode {
  PATH_TRAVERSAL = 'PATH_TRAVERSAL',
  NOT_FOUND = 'NOT_FOUND',
  NOT_A_DIRECTORY = 'NOT_A_DIRECTORY',
  IS_DIRECTORY = 'IS_DIRECTORY',
  BINARY_FILE = 'BINARY_FILE',
  WORKSPACE_NOT_SET = 'WORKSPACE_NOT_SET',
  WORKSPACE_NOT_FOUND = 'WORKSPACE_NOT_FOUND',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  DIR_NOT_EMPTY = 'DIR_NOT_EMPTY',
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export interface DirectoryListResult {
  path: string;
  entries: FileEntry[];
}

export interface FileReadResult {
  path: string;
  content: string;
  size: number;
  encoding: 'utf-8' | 'binary';
}

export interface FileWriteBody {
  projectId: string;
  path: string;
  content: string;
}

export interface FileMkdirBody {
  projectId: string;
  path: string;
}

export interface FsError {
  error: string;
  code: FsErrorCode;
}

// Tool types — re-exported from tools.ts
export * from './tools.js';
// Permission types (AD-029) — re-exported from permission.ts
export * from './permission.js';
