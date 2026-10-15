/**
 * Публичные типы @itphx/synth-sdk.
 *
 * Доменные типы и входные DTO берутся из `@itphx/synth-shared` (browser-safe
 * subpath'ы `./types` и `./schemas`; `./config` не тянется — Node-only).
 * Локально описаны только транспортные DTO, которых нет в shared: публичный
 * срез сериализованной сессии (`serializeSession`) и OpenAI-совместимый
 * контракт LLM-прокси (источник — `public-openapi.ts`).
 */
import type {
  EventBinding,
  EventBindingApiKey,
  EventBindingApiKeyCreated,
  EventRouteRule,
  RouteDecision,
  Schedule,
  ScheduleJob,
  SynthEvent,
} from '@itphx/synth-shared/types';
import type {
  EventBindingApiKeyCreateRequest,
  EventBindingApiKeyUpdateRequest,
  EventBindingInputRequest,
  EventIngestRequest,
  EventRouteRuleUpsertRequest,
  PromptRequest,
  ScheduleInputRequest,
  SessionCreateRequest,
  SessionUpdateRequest,
} from '@itphx/synth-shared/schemas';

// --- Доменные типы и входные DTO (shared) ---
export type {
  EventBinding,
  EventBindingApiKey,
  EventBindingApiKeyCreateRequest,
  EventBindingApiKeyCreated,
  EventBindingApiKeyUpdateRequest,
  EventBindingInputRequest,
  EventIngestRequest,
  EventRouteRule,
  EventRouteRuleUpsertRequest,
  PromptRequest,
  RouteDecision,
  Schedule,
  ScheduleInputRequest,
  ScheduleJob,
  SessionCreateRequest,
  SessionUpdateRequest,
  SynthEvent,
};

// --- Входные типы запросов (обёртки над shared) ---
//
// Shared экспортирует `z.infer`-типы (форма ВЫХОДА схемы), где поля с серверным
// `default` помечены обязательными. Для тела запроса SDK принимает форму ВХОДА:
// такие поля необязательны (сервер подставит default).

/** Тело `POST /sessions` — `engine` имеет серверный default, необязателен. */
export type SessionCreateInput = Omit<SessionCreateRequest, 'engine'> & {
  engine?: SessionCreateRequest['engine'];
};

/**
 * Тело `PATCH /sessions/:id` — публичный контракт `SessionPatch` из
 * `public-openapi.ts`: shared-`SessionUpdateRequest` + `title`/`mode`/`project_id`.
 */
export type SessionPatch = SessionUpdateRequest & {
  title?: string;
  mode?: 'plan' | 'act' | 'yolo';
  project_id?: string | null;
};

/** Тело `POST /sessions/:id/prompt` — `stream` имеет серверный default `true`. */
export type SessionPromptInput = Omit<PromptRequest, 'stream'> & { stream?: boolean };

/** Тело `POST/PUT /schedules` — `enabled` имеет серверный default `true`. */
export type ScheduleInput = Omit<ScheduleInputRequest, 'enabled'> & { enabled?: boolean };

// --- events: ответы ---

/** Одноразовый claim-код неизвестного отправителя (ADR-089 claim-flow). */
export interface EventIdentityHint {
  code: string;
  expiresAt: string;
}

/** Ответ `POST /events` (ingest): событие, решение Router, id сессии, claim-код. */
export interface EventIngestResponse {
  event: SynthEvent;
  decision: RouteDecision;
  sessionId: string | null;
  identityHint?: EventIdentityHint;
}

/** Запись журнала решений Router (`GET /events/journal`). */
export interface EventJournalEntry {
  ts: string;
  event: SynthEvent;
  decision?: RouteDecision;
  error?: string;
  keyId?: string;
  principalId?: string;
}

// --- sessions: публичный срез сериализованной сессии ---

/**
 * Публичный срез сериализованной сессии (`serializeSession` в core). Транспортный
 * DTO в snake_case; это подмножество ответа сервера, неизвестные поля допускаются.
 */
export interface SerializedSession {
  id: string;
  origin?: string;
  name: string | null;
  icon?: string | null;
  color?: string | null;
  parent_id?: string | null;
  branch_point?: string | null;
  plan_approved?: boolean;
  mode: 'plan' | 'act' | 'yolo';
  mode_applicable?: boolean;
  session_origin?: string;
  user_id?: string | null;
  owner_id?: string | null;
  project_id?: string | null;
  engine: 'synth' | 'opencode' | 'cline' | string;
  messages?: unknown[];
  pending_messages?: unknown[];
  pending_count?: number;
  settings?: Record<string, unknown>;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  cache_hit_rate?: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/** Ответ `GET /sessions/:id/messages`. */
export interface SessionMessagesResponse {
  messages: unknown[];
  session_id: string;
  engine: string;
}

/** Ответ `GET /sessions/:id/status`. */
export interface SessionStatusResponse {
  blocked: boolean;
  pending_count: number;
  processor_running: boolean;
}

// --- llm: OpenAI-совместимый контракт (источник — public-openapi.ts) ---

/** Сообщение chat/completions (подмножество OpenAI API). */
export interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Record<string, unknown>[];
  tool_call_id?: string;
  reasoning_content?: string;
  name?: string;
}

/** Тело `POST /llm/chat/completions`. */
export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: Record<string, unknown>[];
  session_id?: string;
  provider?: string;
}

/** OpenAI-совместимый usage в ответе. */
export interface ChatCompletionsUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Нестриминговый ответ `POST /llm/chat/completions`. */
export interface ChatCompletionsResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Record<string, unknown>[];
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
  usage: ChatCompletionsUsage;
}
