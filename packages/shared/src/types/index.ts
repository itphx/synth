import type { ToolCapability } from './tools.js';
import type { PermissionConfig, McpServerToolSettings } from './permission.js';
// Type-only импорт: конфиг-тип MCP нужен для записи реестра (AD-071 §2.5).
// Runtime-цикла нет — импорт стирается при компиляции.
import type { McpServerConfig } from '../config/types.js';

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
  /** Порядок блока внутри тира (реальный порядок отправки, AD-070 §2.5). */
  order?: number;
  chars: number;
  /** Эвристика: Math.ceil(chars / 4). */
  estTokens: number;
  status: PromptManifestStatus;
  provenance?: string;
  /**
   * Источник записи: `system` — блок системного промпта, `tools` — слой
   * встроенных инструментов (stable, AD-070 §2.5), `mcp.tools` — слой
   * MCP-инструментов (volatile, AD-071 §2.1). Слои инструментов не входят в
   * system-текст, но отражаются в манифесте и размерах.
   */
  source?: 'system' | 'tools' | 'mcp.tools';
}

/** AD-070 §2.5: манифест состава системного промпта (для API/UI/тестов). */
export interface PromptManifest {
  generation?: number;
  totalChars: number;
  estTokens: number;
  staticPrefixChars: number;
  /**
   * AD-071 §2.3: фактически применённая политика **встроенных** инструментов
   * (`auto` уже разрешён в `consistency`/`available`) — видно, какая политика
   * сработала.
   */
  toolsPolicy?: Exclude<ToolsPolicy, 'auto'>;
  /**
   * AD-071 §2.3: фактически применённая политика **MCP**-инструментов
   * (`auto` уже разрешён в `consistency`/`available`). Независима от
   * `toolsPolicy`.
   */
  mcpPolicy?: Exclude<ToolsPolicy, 'auto'>;
  /**
   * AD-071 §2.6: chars-per-token, применённый к `estTokens` (калибровка по
   * фактическому usage; 4 — без калибровки). `estTokens` — оценка, не факт.
   */
  ratio?: number;
  entries: PromptManifestEntry[];
}

// --- Оценка токенов по символам (AD-071 §2.6) ---

/** Дефолтный chars-per-token, если калибровки для модели нет. */
export const DEFAULT_CHARS_PER_TOKEN = 4;
/**
 * Нижняя граница разумного chars-per-token (аномальные семплы отбрасываются).
 * CJK/эффективные BPE дают ~1–2 символа на токен, поэтому допускаем 1.5.
 */
export const MIN_CHARS_PER_TOKEN = 1.5;
/**
 * Верхняя граница разумного chars-per-token. Берётся с запасом: «эффективные»
 * токенизаторы (например, `omn.qwen3.8:27b`) дают ratio ≈ 11.7.
 */
export const MAX_CHARS_PER_TOKEN = 16;
/** Минимальный `usage.inputTokens` для калибровки — меньшие значения шумные. */
export const MIN_CALIBRATION_INPUT_TOKENS = 500;

/**
 * AD-071 §2.6: строка таблицы «Встроенные инструменты» в панели статистики.
 * Отдаётся `GET /sessions/:id/prompt` полем `toolsDetail` (аддитивно).
 */
export interface PromptToolDetail {
  name: string;
  capabilities: string[];
  /** Доступен ли тул текущему режиму/роли (`computeToolAvailability`). */
  available: boolean;
  /**
   * Причина недоступности: `mode` (переключить режим), `role` (делегировать),
   * `admin_disabled` (жёстко отключён администратором через `tools.disabled`),
   * `dependency` (в окружении нет нужной программы — git/rg/sh),
   * `workspace` (не задан рабочий каталог проекта).
   */
  reason?: 'mode' | 'role' | 'admin_disabled' | 'dependency' | 'workspace';
  /** AD-071 §2.1: источник инструмента (`built-in` — слой `tools`). */
  source: 'built-in';
  /** AD-071 §2.6: длина `JSON.stringify` LLM-определения тула (как слой `tools`). */
  chars?: number;
  /** AD-071 §2.6: оценка токенов (`ceil(chars / ratio)`) — значение оценочное. */
  estTokens?: number;
  /** AD-071 §2.6: chars-per-token, применённый к оценке (4 — без калибровки). */
  ratio?: number;
  /** AD-071 §2.6: тул жёстко отключён администратором (`tools.disabled`). */
  adminDisabled?: boolean;
}

/** AD-071 §2.6: строка тула MCP-сервера с оценкой токенов. */
export interface McpToolDetail {
  name: string;
  /** Длина `JSON.stringify` LLM-определения тула (имя с префиксом сервера). */
  chars: number;
  estTokens: number;
  ratio: number;
  /** AD-071 §2.6: тул отключён администратором (`tools.disabled`). */
  adminDisabled?: boolean;
}

// --- Prompt history (AD-070 §2.5, слой messages) ---
/** AD-070 §2.5: state-сообщения истории, сгруппированные по типу. */
export interface PromptHistoryStateMessage {
  type: string;
  count: number;
  chars: number;
  estTokens: number;
}

/** AD-070 §2.5: состав слоя истории (`messages`), зеркалит реальную отправку. */
export interface PromptHistoryInfo {
  /** Реально отправляемые сообщения (после фильтрации), суммарно. */
  messages: { count: number; chars: number; estTokens: number };
  /** Chronological state-сообщения (mode_change/agent_switch/plan_updated/todos_updated/…), сгруппированы по type. */
  stateMessages: PromptHistoryStateMessage[];
  /** Что НЕ уходит в LLM. */
  excluded: { disabled: number; hidden: number; info: number };
  /** Мультимодальные части (не text). */
  attachments: { count: number; chars: number };
  /** Число плейсхолдеров секретов ⟦SYNTH_SECRET_N⟧ в отправляемых сообщениях (AD-036). */
  secretPlaceholders: number;
}

// --- Session statistics (AD-070 §2.6) ---
/**
 * Статистика по агенту в рамках сессии (`GET /sessions/:id/stats`).
 * Итоги (`input_tokens`/`output_tokens`/`cache_*`/`reasoning_tokens`/`cost_usd`)
 * включают usage/cost сабагентов (own + все потомки); `subagent_*` — детализация
 * только по дочерним сессиям (tool `task`), инициированным агентом.
 */
export interface SessionAgentStats {
  agent_role: string;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  /**
   * Номинальная сумма всех валют (обратная совместимость). Мультивалютная
   * разбивка — в `cost_by_currency`; здесь значение равно её сумме.
   */
  cost_usd: number;
  /** Разбивка стоимости по валютам (код валюты → сумма, напр. `{ USD: 0.5, RUB: 42 }`). */
  cost_by_currency?: Record<string, number>;
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
  /** Display name профиля автора; при отсутствии профиля/имени — не задаётся. */
  display_name?: string;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  /** Разбивка стоимости по валютам (код валюты → сумма). */
  cost_by_currency?: Record<string, number>;
  cache_hit_rate: number;
}

/**
 * Сводка по сабагентам сессии (рекурсивно, tool `task`). Отдельный блок:
 * `SessionAgentStats` уже включает usage детей в свои итоги, а здесь — только
 * суммарная детализация по всем дочерним сессиям (в контекстное окно родителя
 * их usage не входит, AD-070 §2.6).
 */
export interface SessionSubagentStats {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  /** Разбивка стоимости по валютам (код валюты → сумма). */
  cost_by_currency?: Record<string, number>;
}

/** Ответ `GET /api/v2/sessions/:id/stats`. */
export interface SessionStats {
  session_id: string;
  agents: SessionAgentStats[];
  users: SessionUserStats[];
  /** Суммарная статистика дочерних сессий сабагентов (отдельно от ответа). */
  subagents: SessionSubagentStats;
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
  /**
   * AD-046 §7.1: сообщение локальной `/`-команды (builtin-ответ) — видно в
   * истории, но исключается из LLM-контекста.
   */
  ephemeral?: boolean;
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

/**
 * AD-071 §2.3: политика включения инструментов в запрос.
 * - `consistency` — в запрос идут все определения, недоступность кодируется
 *   permission-слоем (`unavailable(mode|role)`); приоритет — валидность кэша;
 * - `available` — в запрос идут только доступные агенту/режиму/роли тулы;
 *   приоритет — экономия контекстного окна;
 * - `auto` — выбор по провайдеру/модели: локальные → `available`, облачные → `consistency`.
 */
export const TOOLS_POLICIES = ['consistency', 'available', 'auto'] as const;
export type ToolsPolicy = (typeof TOOLS_POLICIES)[number];

// --- MCP: реестр серверов и сетевой доступ (AD-071 §2.3.1/§2.5) ---

/** Версия схемы записи реестра MCP — для будущей миграции (AD-032). */
export const MCP_REGISTRY_SCHEMA_VERSION = 1;

export const MCP_REGISTRY_ORIGINS = ['instance', 'user'] as const;
export type McpRegistryOrigin = (typeof MCP_REGISTRY_ORIGINS)[number];

export const MCP_REGISTRY_TRUST_LEVELS = ['builtin', 'community'] as const;
export type McpRegistryTrust = (typeof MCP_REGISTRY_TRUST_LEVELS)[number];

/** Автор записи реестра (кто добавил сервер). */
export interface McpRegistryAuthor {
  userId: string;
  username: string;
}

/**
 * AD-071 §2.5: плоская запись единого реестра MCP-серверов.
 *
 * Логическая модель сразу проектируется под PostgreSQL (AD-032): стабильный
 * `id`, `schemaVersion`, timestamps; вложенность ограничена `config`/`author`
 * (раскладываются в JSONB/отдельные колонки). Instance- и пользовательские
 * записи различаются полем `origin`, не отдельными реестрами.
 */
export interface McpRegistryEntry {
  schemaVersion: number;
  id: string;
  name: string;
  config: McpServerConfig;
  origin: McpRegistryOrigin;
  author: McpRegistryAuthor | null;
  trust: McpRegistryTrust;
  /**
   * Системный мастер-флаг (hard-gate): `false` — сервер недоступен НИГДЕ и НИКОГДА
   * (в т.ч. в старых сессиях). Дефолт `true`.
   */
  enabled: boolean;
  /**
   * Переосмыслено: «включён по умолчанию для НОВЫХ ПРОЕКТОВ» — сид
   * `project.mcp.enabled`/`project.mcp.defaultOn` при создании проекта. Снимок:
   * изменение не влияет на ранее созданные проекты/сессии.
   */
  enabledByDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export const MCP_NETWORK_POLICY_MODES = ['allow', 'deny'] as const;
export type McpNetworkPolicyMode = (typeof MCP_NETWORK_POLICY_MODES)[number];

/**
 * AD-071 §2.3.1: политика сетевого доступа пользовательских HTTP MCP-серверов.
 * - `deny` — перечисленные адреса/CIDR запрещены (дефолт: приватные диапазоны);
 * - `allow` — разрешены только перечисленные адреса/CIDR (всё прочее запрещено).
 */
export interface McpNetworkPolicy {
  mode: McpNetworkPolicyMode;
  list: string[];
}

/** Приватные/служебные диапазоны, запрещённые по умолчанию (SSRF/egress). */
export const DEFAULT_MCP_PRIVATE_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;

/** Дефолтная политика: deny приватных диапазонов (AD-071 §2.3.1). */
export const DEFAULT_MCP_NETWORK_POLICY: McpNetworkPolicy = {
  mode: 'deny',
  list: [...DEFAULT_MCP_PRIVATE_CIDRS],
};

// --- MCP: уровни/скоуп и эффективный набор (AD-071 §2.2/§2.4) ---

export const MCP_SERVER_LEVELS = ['system', 'project', 'session'] as const;
export type McpServerLevel = (typeof MCP_SERVER_LEVELS)[number];

/**
 * AD-071 §2.2: почему сервер отключён в эффективном наборе сессии:
 * - `system_disabled` — выключен системным мастер-флагом (`McpRegistryEntry.enabled === false`);
 * - `project_disabled` — не разрешён проектом (`project.enabled` — hard-gate);
 * - `session_optout` — явный opt-out в сессии (`mcpDisabledServers`);
 * - `not_default` — нет в снапшоте сессии (`mcpDefaultOn`) и не включён явно.
 *
 * Причина `config` отсутствует: `McpServerConfig.enabled` — только сид записи
 * реестра (`seedFromConfig`), в резолвинге/подключении не участвует.
 */
export const MCP_DISABLED_REASONS = [
  'system_disabled',
  'project_disabled',
  'session_optout',
  'not_default',
] as const;
export type McpDisabledReason = (typeof MCP_DISABLED_REASONS)[number];

/**
 * AD-071 §2.4: эффективное состояние MCP-сервера для сессии. Отдаётся API
 * `GET /api/v2/sessions/:id/mcp`; отключённые серверы не исчезают из выдачи.
 */
export interface McpServerEffective {
  name: string;
  level: McpServerLevel;
  enabled: boolean;
  /** Причина отключения (только при `enabled === false`). */
  reason?: McpDisabledReason;
  connected?: boolean;
  origin: McpRegistryOrigin;
  trust: McpRegistryTrust;
  /**
   * AD-071 §2.2/§2.6: транспортный статус для таблицы «MCP» в статистике:
   * `disabled` — выключен в эффективном наборе, `connected`/`error`/`circuit-open`
   * — состояние подключения активного сервера.
   */
  status?: 'connected' | 'error' | 'disabled' | 'circuit-open';
  /** AD-071 §2.5/§2.6: автор записи реестра (null для instance/config-серверов). */
  author?: McpRegistryAuthor | null;
  /** AD-071 §2.2/§2.6: имена инструментов сервера (пусто, если не подключён). */
  tools?: string[];
  /** AD-071 §2.6: суммарные символы JSON-определений тулов сервера. */
  chars?: number;
  /** AD-071 §2.6: оценка токенов сервера (`ceil(chars / ratio)`). */
  estTokens?: number;
  /** AD-071 §2.6: chars-per-token, применённый к оценке (4 — без калибровки). */
  ratio?: number;
  /** AD-071 §2.6: пер-тульные chars/estTokens/ratio + признак admin_disabled. */
  toolDetails?: McpToolDetail[];
}

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
  /** AD-071 §2.4: явно включённые в сессии серверы (session level). */
  mcpServers?: string[];
  /**
   * AD-071 §2.4: явные opt-out серверы сессии (включая системные). Вычитаются
   * из эффективного набора (`(seed ∪ enabled) − disabled`).
   */
  mcpDisabledServers?: string[];
  /**
   * AD-071 §2.4: СНАПШОТ MCP-серверов «по умолчанию» на момент создания сессии
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
  // === Инструменты (AD-071 §2.3) ===
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
  // === Plan/Act (AD-025, AD-028) ===
  /** Строгость цикла Plan→Build: auto — модель сама решает, strict — план обязателен, off — планирование отключено. */
  planMode?: PlanMode;
  // === Скиллы (AD-046 §4.5) ===
  /** AD-046: явно включённые в сессии имена скиллов (session level, volatile-каталог). */
  skills?: string[];
  /** AD-046: opt-out сессии — имена, категории или группы скиллов (volatile-каталог). */
  skillsDisabled?: string[];
  /**
   * AD-046: СНАПШОТ скиллов «по умолчанию» на момент создания сессии (снимок
   * `project.skills.defaultOn` либо системного дефолта). Изменение дефолта
   * проекта/системы не влияет на существующие сессии.
   */
  skillsDefaultOn?: string[];
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
  /** Канонический ключ иконки (PROJECT_ICON_KEYS); legacy-значения → undefined. */
  icon?: string;
  /** Канонический ключ цвета (PROJECT_COLOR_KEYS); невалидные значения сбрасываются. */
  color?: string;
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
  /**
   * AD-089: ISO-8601 — время авто-архивации ephemeral-сессии (server-managed,
   * клиент задать не может). Задан — сессия скрывается из списков по умолчанию.
   */
  expiresAt?: string;
  /** AD-089: ISO-8601 — время архивации сессии (server-managed). */
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
   * AD-070 §2.3: доля кэшированных входных токенов сессии —
   * `cacheReadTokens / inputTokens` (0 при `inputTokens === 0`).
   */
  cacheHitRate?: number;
}

// --- Git ---
/**
 * AD-076: запись реестра git-репозиториев проекта. Старые данные (`repos` как
 * `string[]` либо `{ path }`) нормализуются через `normalizeGitRepoConfig`.
 */
export interface GitRepoConfig {
  /** Стабильный id записи реестра (uuid); отсутствует у обнаруженных scan-ом. */
  id?: string;
  name?: string;
  url?: string;
  type?: 'https' | 'ssh';
  /** Относительный путь ВНУТРИ project.workspace (допускает вложенность). */
  path: string;
  defaultBranch?: string;
  sshKeyId?: string;
  lastFetch?: string;
}

/**
 * AD-076: SSH-ключ агента — отдельная сущность реестра (не в
 * `AgentDefinition`). Секреты `privateKey`/`passphrase` шифруются at-rest
 * (AES-256-GCM; реализация — в core) и НИКОГДА не отдаются через API.
 */
export interface SSHKey {
  id: string;
  name: string;
  /** Метка типа ключа, дефолт `'user'`. */
  type?: string;
  privateKey: string;
  passphrase?: string;
  /** Привязка к агентам: один ключ может обслуживать несколько агентов. */
  agentIds: string[];
  createdAt: string;
  updatedAt?: string;
}

/** Публичное представление ключа (без `privateKey`/`passphrase`). */
export type SSHKeyMeta = Omit<SSHKey, 'privateKey' | 'passphrase'>;

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

/**
 * AD-071 §2.4/§2.5: проектный скоуп MCP — ссылки на записи единого реестра по
 * имени.
 * - `enabled` — hard-gate: серверы, разрешённые проекту. Не разрешённый сервер
 *   недоступен ни в одной сессии проекта (в т.ч. старой). Пустой массив — «всё
 *   выключено» (opt-in); отсутствие `project.mcp` — гейт не задан (legacy).
 * - `defaultOn` — сид «по умолчанию для новых сессий»: снапшот `mcpDefaultOn`
 *   при создании сессии. Изменение не влияет на ранее созданные сессии.
 */
export interface ProjectMcpSettings {
  enabled: string[];
  defaultOn: string[];
}

/**
 * AD-046 §4.5: проектный скоуп скиллов (owner/lead) — аналог `ProjectMcpSettings`.
 * - `enabled` — hard-gate: доступные проекту скиллы. Пустой массив — «всё
 *   выключено» (opt-in); отсутствие `project.skills` — гейт не задан (legacy).
 * - `defaultOn` — сид «по умолчанию для новых сессий»: снапшот
 *   `skillsDefaultOn` при создании сессии.
 */
export interface ProjectSkillSettings {
  enabled: string[];
  defaultOn: string[];
}

/**
 * AD-075: политика для абсолютного `project.workspace` вне `workspacesRoot`.
 * - `confirm` — путь разрешён только с явным подтверждением (`confirmOutsideRoot`);
 * - `deny` — путь запрещён (managed-развёртывание: жёстко).
 *
 * Значение `''` (пустая строка) в конфиге означает «не задано» — эффективной
 * политикой тогда считается `confirm` (резолвер `resolveWorkspaceOutsideRootPolicy`).
 */
export type WorkspaceOutsideRootPolicy = 'confirm' | 'deny';

/**
 * AD-075: ответ `GET /api/v2/settings/workspace-policy`.
 * `readOnly` (additive) — managed-развёртывание: политика задаётся развёртыванием,
 * `PUT`/`DELETE` возвращают 403 `WORKSPACE_POLICY_READ_ONLY`.
 */
export interface WorkspacePolicyInfo {
  outsideRoot: WorkspaceOutsideRootPolicy;
  isOverridden: boolean;
  defaults: WorkspaceOutsideRootPolicy;
  readOnly?: boolean;
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
  /** AD-071 §2.4: проектный скоуп MCP (owner/lead). */
  mcp?: ProjectMcpSettings;
  /** AD-046 §4.5: проектный скоуп скиллов (owner/lead). */
  skills?: ProjectSkillSettings;
  statusMessages: StatusMessage[];
  /** Kanban-план проекта (AD-039). Владеет проектом, а не сессией. */
  plan?: ProjectPlan;
  /** Лог работ проекта (ведётся моделью через project_log_write). */
  log?: ProjectLogEntry[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Канонические ключи иконок проектов и сессий (единый список для server и UI).
 * Значения — только ключи реестра (загружаемые картинки не поддерживаются).
 */
export const PROJECT_ICON_KEYS = [
  'code',
  'terminal',
  'rocket',
  'flask',
  'gamepad',
  'briefcase',
  'home',
  'globe',
  'leaf',
  'shield',
  'palette',
  'server',
  'phone',
  'database',
  'lightbulb',
  'music',
  'camera',
  'book',
  'heart',
  'folder',
  'chat',
  'cpu',
  'file',
  'file-code',
  'docs',
  'task',
  'todo',
  'bug',
  'robot',
  'brain',
  'git',
  'repo',
  'test',
  'chart',
  'star',
  'image',
  'calendar',
] as const;

export type ProjectIconKey = (typeof PROJECT_ICON_KEYS)[number];

/**
 * Канонические ключи цветов проектов и сессий — 16 цветов палитры темы
 * (`palette.colors[].key` в `a1..a16`; единый список для server и UI).
 */
export const PROJECT_COLOR_KEYS = [
  'a1', 'a2', 'a3', 'a4',
  'a5', 'a6', 'a7', 'a8',
  'a9', 'a10', 'a11', 'a12',
  'a13', 'a14', 'a15', 'a16',
] as const;

export type ProjectColorKey = (typeof PROJECT_COLOR_KEYS)[number];

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
  isOverridden: boolean;
  icon?: string;
  color?: string;
  description?: string;
  /**
   * AD-046 §6.2: группы агентов для привязки скиллов
   * (`metadata.synth.groups`). Пусто/не задано — скилл с непустым `groups`
   * не привязан к агенту.
   */
  groups?: string[];
}

// --- Currency ---
/** Валюта цен моделей. Отсутствует у модели → валюта провайдера → USD. */
export const CURRENCIES = ['RUB', 'USD', 'CNY'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Проверка, что значение — допустимая валюта (RUB/USD/CNY). */
export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

/** Ленивый разбор валюты: неизвестное значение → undefined. */
export function parseCurrency(value: unknown): Currency | undefined {
  return isCurrency(value) ? value : undefined;
}

/** Результат строгого разбора поля `currency` из тела запроса. */
export type CurrencyInputResult =
  | { ok: true; currency: Currency | undefined }
  | { ok: false };

/**
 * Строгий разбор поля `currency`:
 * - `undefined` — поле не передано (сохранить existing);
 * - `null`/`''` — явно очистить (undefined);
 * - валидная валюта — принять;
 * - иная непустая строка — ошибка (`ok: false`), чтобы не терять значение молча.
 */
export function parseCurrencyInput(raw: unknown, existing?: Currency): CurrencyInputResult {
  if (raw === null || raw === '') return { ok: true, currency: undefined };
  if (raw === undefined) return { ok: true, currency: existing };
  return isCurrency(raw) ? { ok: true, currency: raw } : { ok: false };
}

/** Присутствуют ли в теле запроса ценовые поля (snake_case или camelCase). */
export function hasPriceInput(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return 'input_price' in b || 'inputPrice' in b
    || 'output_price' in b || 'outputPrice' in b
    || 'cache_read_price' in b || 'cacheReadPrice' in b
    || 'cache_write_price' in b || 'cacheWritePrice' in b;
}

/**
 * AD-036/AD-072: дефолт rate limit LLM Gateway. Единый источник для Zod-схемы
 * конфига и runtime-дефолтов (settings-роуты, fallback'и backend/core).
 */
export const DEFAULT_LLM_GATEWAY_RATE_LIMIT = {
  userPerMinute: 60,
  providerPerMinute: 120,
} as const;

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
  /** Валюта по умолчанию для моделей провайдера. Отсутствует → USD. */
  currency?: Currency;
}

export type ContextSource = 'api' | 'reference' | 'manual' | 'unknown';

/**
 * Источник цен модели: `api` — получены синхронизацией с провайдером,
 * `manual` — заданы пользователем вручную, `unknown` — не определены.
 */
export type PriceSource = 'api' | 'manual' | 'unknown';

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
  /** Откуда взяты цены: `api` — синхронизация, `manual` — ручной ввод. */
  priceSource?: PriceSource;
  /** Валюта цен модели; отсутствует → валюта провайдера → USD. */
  currency?: Currency;
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
  | 'project.updated'
  | 'fs.changed'
  | 'message.added'
  | 'message.updated'
  | 'child.message.added'
  | 'child.session.updated'
  | 'stream.start'
  | 'stream.chunk'
  | 'stream.usage'
  | 'stream.done'
  | 'stream.ended'
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
  | 'context.instructions_loaded'
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
  | 'skill.invoked'
  | 'command.invoked'
  | 'command.inline_shell'
  | 'event.received'
  | 'event.routed'
  | 'binding.changed'
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
  /** AD-075: путь вне `workspacesRoot` запрещён политикой (managed). */
  WORKSPACE_OUTSIDE_ROOT_DENIED = 'WORKSPACE_OUTSIDE_ROOT_DENIED',
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
// Skill types (AD-046) — re-exported from skills.ts
export * from './skills.js';
// Slash-команды и bundles (AD-046 §7) — re-exported from commands.ts
export * from './commands.js';
// Внешние события (AD-089) — re-exported from events.ts
export * from './events.js';
// Hooks агента и интеграций (AD-030) — re-exported from hooks.ts
export * from './hooks.js';
// Планировщик расписаний (AD-051 срез / AD-089) — re-exported from schedules.ts
export * from './schedules.js';
