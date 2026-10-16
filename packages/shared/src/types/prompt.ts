import type { ToolsPolicy } from './session.js';

// --- Prompt state (ADR-070 §2.4) ---
/** Состояние одного блока системного промпта (хэш/размер для диагностики). */
export interface PromptBlockState {
  key: string;
  hash: string;
  chars: number;
}

/**
 * ADR-070 §2.4: состояние системного промпта per-agent. Хранится в сессии
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

/** ADR-070 §2.4: компактная мета промпта, кладётся в assistant-сообщение. */
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

// --- Prompt manifest (ADR-070 §2.5) ---
/** Тир консистентности блока системного промпта (ADR-070 §2.1). */
export type PromptTier = 'stable' | 'context' | 'volatile';

/** Статус блока в манифесте промпта. */
export type PromptManifestStatus = 'loaded' | 'truncated' | 'empty' | 'blocked' | 'suppressed';

/** ADR-070 §2.5: запись манифеста — источник системного промпта. */
export interface PromptManifestEntry {
  key: string;
  label: string;
  tier: PromptTier;
  /** Порядок блока внутри тира (реальный порядок отправки, ADR-070 §2.5). */
  order?: number;
  chars: number;
  /** Эвристика: Math.ceil(chars / 4). */
  estTokens: number;
  status: PromptManifestStatus;
  provenance?: string;
  /**
   * Источник записи: `system` — блок системного промпта, `tools` — слой
   * встроенных инструментов (stable, ADR-070 §2.5), `mcp.tools` — слой
   * MCP-инструментов (volatile, ADR-071 §2.1). Слои инструментов не входят в
   * system-текст, но отражаются в манифесте и размерах.
   */
  source?: 'system' | 'tools' | 'mcp.tools';
}

/** ADR-070 §2.5: манифест состава системного промпта (для API/UI/тестов). */
export interface PromptManifest {
  generation?: number;
  totalChars: number;
  estTokens: number;
  staticPrefixChars: number;
  /**
   * ADR-071 §2.3: фактически применённая политика **встроенных** инструментов
   * (`auto` уже разрешён в `consistency`/`available`) — видно, какая политика
   * сработала.
   */
  toolsPolicy?: Exclude<ToolsPolicy, 'auto'>;
  /**
   * ADR-071 §2.3: фактически применённая политика **MCP**-инструментов
   * (`auto` уже разрешён в `consistency`/`available`). Независима от
   * `toolsPolicy`.
   */
  mcpPolicy?: Exclude<ToolsPolicy, 'auto'>;
  /**
   * ADR-071 §2.6: chars-per-token, применённый к `estTokens` (калибровка по
   * фактическому usage; 4 — без калибровки). `estTokens` — оценка, не факт.
   */
  ratio?: number;
  entries: PromptManifestEntry[];
}

// --- Оценка токенов по символам (ADR-071 §2.6) ---

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
 * ADR-071 §2.6: строка таблицы «Встроенные инструменты» в панели статистики.
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
   * `workspace` (не задан рабочий каталог проекта),
   * `storage` (хранилище недоступно — деградированный read-only режим, PROP-032).
   */
  reason?: 'mode' | 'role' | 'admin_disabled' | 'dependency' | 'workspace' | 'storage';
  /** ADR-071 §2.1: источник инструмента (`built-in` — слой `tools`). */
  source: 'built-in';
  /** ADR-071 §2.6: длина `JSON.stringify` LLM-определения тула (как слой `tools`). */
  chars?: number;
  /** ADR-071 §2.6: оценка токенов (`ceil(chars / ratio)`) — значение оценочное. */
  estTokens?: number;
  /** ADR-071 §2.6: chars-per-token, применённый к оценке (4 — без калибровки). */
  ratio?: number;
  /** ADR-071 §2.6: тул жёстко отключён администратором (`tools.disabled`). */
  adminDisabled?: boolean;
}

/** ADR-071 §2.6: строка тула MCP-сервера с оценкой токенов. */
export interface McpToolDetail {
  name: string;
  /** Длина `JSON.stringify` LLM-определения тула (имя с префиксом сервера). */
  chars: number;
  estTokens: number;
  ratio: number;
  /** ADR-071 §2.6: тул отключён администратором (`tools.disabled`). */
  adminDisabled?: boolean;
}

// --- Prompt history (ADR-070 §2.5, слой messages) ---
/** ADR-070 §2.5: state-сообщения истории, сгруппированные по типу. */
export interface PromptHistoryStateMessage {
  type: string;
  count: number;
  chars: number;
  estTokens: number;
}

/** ADR-070 §2.5: состав слоя истории (`messages`), зеркалит реальную отправку. */
export interface PromptHistoryInfo {
  /** Реально отправляемые сообщения (после фильтрации), суммарно. */
  messages: { count: number; chars: number; estTokens: number };
  /** Chronological state-сообщения (mode_change/agent_switch/plan_updated/todos_updated/…), сгруппированы по type. */
  stateMessages: PromptHistoryStateMessage[];
  /** Что НЕ уходит в LLM. */
  excluded: { disabled: number; hidden: number; info: number };
  /** Мультимодальные части (не text). */
  attachments: { count: number; chars: number };
  /** Число плейсхолдеров секретов ⟦SYNTH_SECRET_N⟧ в отправляемых сообщениях (ADR-036). */
  secretPlaceholders: number;
}

// --- Session statistics (ADR-070 §2.6) ---
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
 * их usage не входит, ADR-070 §2.6).
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
