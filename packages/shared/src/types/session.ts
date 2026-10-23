import type { PermissionConfig, McpServerToolSettings } from './permission.js';
import type { Message } from './message.js';
import type { PromptState } from './prompt.js';

// --- SessionOrigin ---
export type SessionOrigin = 'user' | 'fork' | 'subagent';

// --- Session ---
export interface SessionStatus {
  blocked?: string;
  blockedAt?: string;
  /**
   * Персистентный флаг запроса отмены генерации (кнопка «Стоп», `/stop`).
   * Живёт в JSON-хранилище (ADR-005): позволяет остановить сессию, когда
   * `currentStream`/cancel-token ещё не установлены (очередь, backoff).
   * Сбрасывается процессором очереди после обработки.
   */
  cancelRequested?: boolean;
  /** Время запроса отмены (ISO) — для диагностики/аудита. */
  cancelRequestedAt?: string;
}

export const PLAN_MODES = ['auto', 'strict', 'off'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

export const SESSION_MODES = ['plan', 'act', 'yolo'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/**
 * ADR-071 §2.3: политика включения инструментов в запрос.
 * - `consistency` — в запрос идут все определения, недоступность кодируется
 *   permission-слоем (`unavailable(mode|role)`); приоритет — валидность кэша;
 * - `available` — в запрос идут только доступные агенту/режиму/роли тулы;
 *   приоритет — экономия контекстного окна;
 * - `auto` — выбор по провайдеру/модели: локальные → `available`, облачные → `consistency`.
 */
export const TOOLS_POLICIES = ['consistency', 'available', 'auto'] as const;
export type ToolsPolicy = (typeof TOOLS_POLICIES)[number];

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_PRIORITIES = ['high', 'medium', 'low'] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  /** Связь с пунктом плана проекта (ADR-039). */
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
  /** ADR-071 §2.4: явно включённые в сессии серверы (session level). */
  mcpServers?: string[];
  /**
   * ADR-071 §2.4: явные opt-out серверы сессии (включая системные). Вычитаются
   * из эффективного набора (`(seed ∪ enabled) − disabled`).
   */
  mcpDisabledServers?: string[];
  /**
   * ADR-071 §2.4: СНАПШОТ MCP-серверов «по умолчанию» на момент создания сессии
   * (снимок `project.defaultOn` либо системного дефолта `enabledByDefault`).
   * Изменение дефолта проекта/системы не влияет на существующие сессии.
   */
  mcpDefaultOn?: string[];
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
  // === Роутинг (ADR-034) ===
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
  // === Микро-слой (ADR-035) ===
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
  /**
   * ADR-084: включить decision-уровень в микро-каскаде (перед локальной LLM).
   * Не задано — берётся `config.decision.enabled`; `false` — принудительное
   * отключение уровня в сессии.
   */
  decisionFirst?: boolean;
  // === Permissions (ADR-029) ===
  /** Гранулярные permissions сессии. Приоритетнее глобальной секции permission в config.yaml. */
  permission?: PermissionConfig;
  /** Доступность MCP-инструментов по режимам plan/act (serverName → настройки). */
  mcpToolSettings?: Record<string, McpServerToolSettings>;
  // === Инструменты (ADR-071 §2.3) ===
  /**
   * Per-session override политики включения **встроенных** инструментов. Если
   * задан — перекрывает глобальную `tools.policy` из config.yaml. `auto`
   * резолвится по провайдеру/модели текущего запроса.
   */
  toolsPolicy?: ToolsPolicy;
  /**
   * Per-session override политики включения **MCP**-инструментов. Если задан —
   * перекрывает глобальную `mcp.policy` из config.yaml. Независима от
   * `toolsPolicy`; `auto` резолвится по провайдеру/модели текущего запроса.
   */
  mcpPolicy?: ToolsPolicy;
  // === Plan/Act (ADR-025, ADR-028) ===
  /** Строгость цикла Plan→Build: auto — модель сама решает, strict — план обязателен, off — планирование отключено. */
  planMode?: PlanMode;
  // === Скиллы (ADR-046 §4.5) ===
  /** ADR-046: явно включённые в сессии имена скиллов (session level, volatile-каталог). */
  skills?: string[];
  /** ADR-046: opt-out сессии — имена, категории или группы скиллов (volatile-каталог). */
  skillsDisabled?: string[];
  /**
   * ADR-046: СНАПШОТ скиллов «по умолчанию» на момент создания сессии (снимок
   * `project.skills.defaultOn` либо системного дефолта). Изменение дефолта
   * проекта/системы не влияет на существующие сессии.
   */
  skillsDefaultOn?: string[];
  // === LLM Gateway (ADR-036) ===
  /** Per-session override LLM Gateway (ADR-036). */
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
  /** Канонический ключ иконки (PROJECT_ICON_KEYS); legacy-значения → undefined. */
  icon?: string;
  /** Канонический ключ цвета (PROJECT_COLOR_KEYS); невалидные значения сбрасываются. */
  color?: string;
  sessionOrigin: SessionOrigin;
  parentId?: string;
  branchPoint?: string;
  /** Флаг «план утверждён через plan_exit» (ADR-039), нужен для strict-режима ADR-028. */
  planApproved?: boolean;
  /** Текущий runtime-режим сессии (ADR-025): 'plan' — только чтение, 'act' — полный доступ. */
  mode?: SessionMode;
  /** Todo-список сессии (тул todo_write), как в OpenCode. */
  todos?: TodoItem[];
  /**
   * ADR-070 §2.4/§2.7: состояние промпта per-agent (ключ — agentRole или
   * `__default__`). Пишется только при смене generation.
   */
  promptStates?: Record<string, PromptState>;
  /** Карта обфускации LLM Gateway (ADR-036). Живёт всю сессию независимо от глобального тумблера. */
  obfuscationMap?: Record<string, string>;
  userId?: string;
  ownerId?: string;
  projectId?: string;
  messages: Message[];
  pendingMessages: Message[];
  /**
   * ADR-104: очередь инъекций (steering) — сообщения, отправленные во время
   * активного хода (`mode: 'steer'`). Отдельно от `pendingMessages`: оркестратор
   * вычитывает её на границе шага и вплетает в контекст текущего хода.
   * Необязательное поле — сессии, созданные до ADR-104, его не имеют.
   */
  steerInbox?: Message[];
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
  /**
   * ADR-089: ISO-8601 — время авто-архивации ephemeral-сессии (server-managed,
   * клиент задать не может). Задан — сессия скрывается из списков по умолчанию.
   */
  expiresAt?: string;
  /** ADR-089: ISO-8601 — время архивации сессии (server-managed). */
  archivedAt?: string;
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
   * ADR-070 §2.3: доля кэшированных входных токенов сессии —
   * `cacheReadTokens / inputTokens` (0 при `inputTokens === 0`).
   */
  cacheHitRate?: number;
}

// --- Queue ---
export interface QueueItem {
  message: Message;
  streamId: string;
  enqueuedAt: string;
}
