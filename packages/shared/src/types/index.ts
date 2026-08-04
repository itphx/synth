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

export enum TsmState {
  PLANNING = 'planning',
  EXECUTION = 'execution',
  VALIDATION = 'validation',
  DONE = 'done',
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

// --- SessionOrigin ---
export type SessionOrigin = 'user' | 'fork' | 'subagent';

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
  summaryOf?: number[];
  qa_pass?: boolean;
  qa_reason?: string;
}

// --- Session ---
export interface TsmStatus {
  state: TsmState;
  iteration: number;
  validationAttempts: number;
  lastError?: string;
  project?: string;
  taskName: string;
  progress?: number;
  approvedPlan?: string;
  alreadyDone?: string;
  currentlyDoing?: string;
  currentTaskInfo?: string;
  updatedProjectInfo?: string;
  blocked?: string;
  blockedAt?: string;
}

export const PLAN_MODES = ['auto', 'strict', 'off'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

export const SESSION_MODES = ['plan', 'act'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_PRIORITIES = ['high', 'medium', 'low'] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

export interface TodoItem {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

export interface SessionSettings {
  provider?: string;
  model?: string;
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
  tsmState: TsmState;
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
  planPath?: string;
  /** Содержимое утверждённого плана (AD-027) — встраивается в system prompt. */
  planContent?: string;
  /** Текущий runtime-режим сессии (AD-025): 'plan' — только чтение, 'act' — полный доступ. */
  mode?: SessionMode;
  /** Todo-список сессии (тул todo_write), как в OpenCode. */
  todos?: TodoItem[];
  userId?: string;
  ownerId?: string;
  projectId?: string;
  engine: 'synth' | 'opencode' | 'cline';
  messages: Message[];
  pendingMessages: Message[];
  status: TsmStatus;
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
  createdAt: string;
  updatedAt: string;
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
  };
}

// --- Agent ---
export interface AgentDefinition {
  id: string;
  displayName: string;
  contextFile?: string;
  capabilities: ToolCapability[];
  enabled: boolean;
  hidden?: boolean;
  provider?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  agentMode?: 'primary' | 'subagent' | 'all';
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

export type ContextCategory = 'user' | 'role' | 'system' | 'tsm';

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
  | 'message.added'
  | 'message.updated'
  | 'child.message.added'
  | 'child.session.updated'
  | 'stream.start'
  | 'stream.chunk'
  | 'stream.done'
  | 'stream.cancelled'
  | 'stream.error'
  | 'queue.stalled'
  | 'message.queued'
  | 'permission.asked'
  | 'permission.replied'
  | 'question.asked'
  | 'question.replied'
  | 'context.summarization_pending'
  | 'context.summarized'
  | 'context.sliding_window_applied'
  | 'context.sticky_note_added'
  | 'context.sticky_note_updated'
  | 'context.sticky_note_deleted'
  | 'tool_call.started'
  | 'tool_call.result'
  | 'tool_call.loop'
  | 'permission.asked'
  | 'permission.replied'
  | 'permission.denied'
  | 'message.quality_check'
  | 'session.routing_category'
  | 'plan.approved'
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
