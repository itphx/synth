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
  CommitDetail,
  EventBinding,
  EventBindingApiKey,
  EventBindingApiKeyCreated,
  EventRouteRule,
  FileEntry,
  InstanceCapabilities,
  ProjectPlan,
  PromptAcceptedResponse,
  RouteDecision,
  Schedule,
  ScheduleJob,
  SynthEvent,
  TodoItem,
} from '@itphx/synth-shared/types';
import type {
  EventBindingApiKeyCreateRequest,
  EventBindingApiKeyUpdateRequest,
  EventBindingInputRequest,
  EventIngestRequest,
  EventRouteRuleUpsertRequest,
  PlanColumnCreateRequest,
  PlanColumnDeleteRequest,
  PlanColumnsOrderRequest,
  PlanColumnUpdateRequest,
  PlanItemCreateRequest,
  PlanItemMoveRequest,
  PlanItemUpdateRequest,
  ProjectInvariantsUpdateRequest,
  ProjectLogCreateRequest,
  ProjectLogUpdateRequest,
  PromptRequest,
  PromptRequestInput,
  ScheduleInputRequest,
  SessionCreateRequest,
  SessionUpdateRequest,
  TodoClearRequest,
  TodoCreateRequest,
  TodoOrderRequest,
  TodoUpdateRequest,
} from '@itphx/synth-shared/schemas';

// --- Доменные типы и входные DTO (shared) ---
export type {
  CommitDetail,
  EventBinding,
  EventBindingApiKey,
  EventBindingApiKeyCreateRequest,
  EventBindingApiKeyCreated,
  EventBindingApiKeyUpdateRequest,
  EventBindingInputRequest,
  EventIngestRequest,
  EventRouteRule,
  EventRouteRuleUpsertRequest,
  FileEntry,
  InstanceCapabilities,
  PlanColumnCreateRequest,
  PlanColumnDeleteRequest,
  PlanColumnsOrderRequest,
  PlanColumnUpdateRequest,
  PlanItemCreateRequest,
  PlanItemMoveRequest,
  PlanItemUpdateRequest,
  ProjectInvariantsUpdateRequest,
  ProjectLogCreateRequest,
  ProjectLogUpdateRequest,
  ProjectPlan,
  PromptAcceptedResponse,
  PromptRequest,
  PromptRequestInput,
  RouteDecision,
  Schedule,
  ScheduleInputRequest,
  ScheduleJob,
  SessionCreateRequest,
  SessionUpdateRequest,
  SynthEvent,
  TodoClearRequest,
  TodoCreateRequest,
  TodoItem,
  TodoOrderRequest,
  TodoUpdateRequest,
};

// --- Входные типы запросов (обёртки над shared) ---
//
// Shared экспортирует `z.infer`-типы (форма ВЫХОДА схемы), где поля с серверным
// `default` помечены обязательными. Для тела запроса SDK принимает форму ВХОДА:
// такие поля необязательны (сервер подставит default).

/** Тело `POST /sessions` — публичный контракт `SessionCreateRequest` из shared. */
export type SessionCreateInput = SessionCreateRequest;

/**
 * Тело `PATCH /sessions/:id` — публичный контракт `SessionPatch` из
 * `public-openapi.ts`: shared-`SessionUpdateRequest` + `title`/`mode`/`project_id`.
 */
export type SessionPatch = SessionUpdateRequest & {
  title?: string;
  mode?: 'plan' | 'act' | 'yolo';
  project_id?: string | null;
};

/**
 * Тело `POST /sessions/:id/prompt` — `stream` и `mode` имеют серверные
 * default'ы (`true` и `queue` соответственно, ADR-104).
 */
export type SessionPromptInput = Omit<PromptRequestInput, 'stream'> & { stream?: boolean };

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

/**
 * Публичный срез сериализованного сообщения (`serializeMessage` в core).
 *
 * Транспортный DTO в snake_case; это подмножество ответа сервера, неизвестные
 * поля допускаются. Поля `ord`/`turn_id`/`step_index`/`status` — модель хода
 * ADR-118 (`ord` — монотонный порядок записи, `null` у сообщений до ADR-118).
 */
export interface SerializedMessage {
  id?: string;
  /** Позиция в отфильтрованном списке истории (перенумеровывается). */
  index?: number;
  /** Порядковый номер в сессии (перенумеровывается). */
  seq?: number;
  /** ADR-118 §2: монотонный порядок записи в историю (`null` — до ADR-118). */
  ord?: number | null;
  /** ADR-118 §1: идентификатор хода, которому принадлежит сообщение. */
  turn_id?: string | null;
  /** ADR-118 §1: индекс шага внутри хода (0-based). */
  step_index?: number | null;
  /** ADR-118 §5: статус сообщения-хода («финал» — смена статуса). */
  status?: 'streaming' | 'completed' | 'cancelled' | 'error' | null;
  role?: string;
  content?: string;
  author?: string | null;
  agent_role?: string | null;
  model?: string | null;
  provider?: string | null;
  ephemeral?: boolean;
  timestamp?: string;
  metadata?: Record<string, unknown> | null;
  tool_calls?: Record<string, unknown>[] | null;
  tool_call_id?: string | null;
  [key: string]: unknown;
}

/** Ответ `GET /sessions/:id/messages` — страница истории. */
export interface SessionMessagesResponse {
  messages: SerializedMessage[];
  session_id: string;
  /**
   * Есть ли более старые сообщения за пределами страницы.
   * Старый сервер (без пагинации) поле не отдаёт → `false`.
   */
  has_more?: boolean;
  /**
   * Курсор следующей (более старой) страницы: минимальный `seq` текущей
   * страницы; `null`, если более старых сообщений нет. Старый сервер — `null`.
   */
  next_before?: number | null;
}

/**
 * Ответ `GET /sessions` — **страница** списка сессий (пагинация обязательна).
 *
 * Список никогда не содержит полной истории: `messages` в DTO отсутствует.
 * Полная история — `GET /sessions/:id/messages`.
 */
export interface SessionListResponse {
  /** Сессии текущей страницы. */
  sessions: SerializedSession[];
  /** Всего видимых сессий (после фильтра видимости и `project_id`). */
  total: number;
  /** Смещение текущей страницы. */
  offset: number;
  /** Размер страницы (по умолчанию 100, максимум 500). */
  limit: number;
  /** Курсор следующей страницы; `null` — страница последняя. */
  next_offset: number | null;
}

/** Ответ `GET /sessions/:id/status`. */
export interface SessionStatusResponse {
  blocked: boolean;
  pending_count: number;
  processor_running: boolean;
}

// --- projects: страница списка и сводка-DTO ---

/**
 * Публичный срез сериализованного проекта (`serializeProject` в core) —
 * транспортный DTO в snake_case.
 *
 * Сводка списка (`serializeProjectSummary`): тяжёлые поля `log` (журнал
 * проекта) и `plan` (ADR-039) **не отдаются**; полный DTO — в
 * `GET /projects/:id`.
 *
 * PROP-054: в детали проекта поля `log` **больше нет** — журнал вынесен в
 * постраничную страницу `GET /projects/:id/log` (см. `ProjectLogPage`).
 * Поле `plan` в детали остаётся (`plan: null` — плана нет).
 *
 * ⚠️ У типа есть индекс-сигнатура `[key: string]: unknown` — «удаление» поля
 * `log` из ответа сервера **не ломает компиляцию** (значение просто попадёт в
 * индекс). Поэтому отсутствие `log` в детали закреплено явным тестом
 * (`client.test.ts`), а не типом.
 */
export interface SerializedProject {
  id: string;
  origin?: string;
  name: string;
  owner_id: string;
  members: Record<string, string>;
  description: string;
  current_task: string;
  invariants: string;
  icon?: string | null;
  color?: string | null;
  workspace?: string | null;
  repos?: unknown[] | null;
  mcp?: unknown | null;
  memory?: unknown | null;
  /** План проекта (ADR-039); `null` — плана нет. В списке проектов не отдаётся. */
  plan?: ProjectPlan | null;
  status_messages: Array<{ id: string; text: string; type: string; timestamp: string }>;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * Ответ `GET /projects` — **страница** списка проектов (массив больше не
 * возвращается; обратная совместимость не поддерживается).
 */
export interface ProjectListResponse {
  /** Проекты текущей страницы. */
  projects: SerializedProject[];
  /** Всего видимых проектов. */
  total: number;
  /** Смещение текущей страницы. */
  offset: number;
  /** Размер страницы (по умолчанию 100, максимум 500). */
  limit: number;
  /** Курсор следующей страницы; `null` — страница последняя. */
  next_offset: number | null;
}

// --- projects: план, журнал, инварианты (PROP-054) ---

/**
 * DTO записи журнала проекта (`serializeLogEntry` в core) — транспортный
 * DTO в snake_case. Текст — Markdown (лимит `MARKDOWN_LIMITS.journalEntry`,
 * 16 КиБ).
 */
export interface ProjectLogEntryDto {
  id: string;
  text: string;
  created_at: string;
  /** Сессия-автор записи; `null` — запись без сессии. */
  session_id: string | null;
  /** Автор записи; `null` — автор не задан. */
  author: string | null;
  /** Когда текст правили; `null` — запись не правилась. */
  updated_at: string | null;
  /** Кто правил текст; `null` — не правили. */
  updated_by: string | null;
  [key: string]: unknown;
}

/**
 * Ответ `POST`/`PATCH` `/projects/:id/log*` — созданная или обновлённая запись
 * журнала.
 */
export interface ProjectLogEntryResponse {
  entry: ProjectLogEntryDto;
}

/**
 * Ответ `GET /projects/:id/log` — **страница** журнала проекта.
 *
 * Новые записи сверху; пагинация — общий формат API v2
 * (`{items, total, offset, limit, next_offset}`).
 */
export interface ProjectLogPage {
  /** Записи текущей страницы (новые сверху). */
  entries: ProjectLogEntryDto[];
  /** Всего записей журнала. */
  total: number;
  /** Смещение текущей страницы. */
  offset: number;
  /** Размер страницы (по умолчанию 50, максимум 200). */
  limit: number;
  /** Курсор следующей страницы; `null` — страница последняя. */
  next_offset: number | null;
}

/**
 * Ответ `GET /projects/:id/plan` — план проекта целиком.
 *
 * `plan: null` — плана ещё нет. ⚠️ План приходит **доменной формой**
 * (camelCase: `updatedAt`/`columnId`/`createdAt`) — в отличие от журнала и
 * инвариантов, которые сериализуются в snake_case.
 */
export interface ProjectPlanResponse {
  plan: ProjectPlan | null;
}

/**
 * Ответ мутации плана — **актуальный** план после операции.
 *
 * При конфликте версии сервер отвечает `409 PLAN_VERSION_CONFLICT` и кладёт
 * актуальный план в тело ошибки (`plan`) — клиент читает его из
 * `SynthApiError.body`.
 */
export interface ProjectPlanMutationResponse {
  plan: ProjectPlan;
}

/**
 * Ответ `GET`/`PUT /projects/:id/invariants` — текст инвариантов проекта и
 * время его записи.
 *
 * Текст — Markdown (лимит `MARKDOWN_LIMITS.invariants`, 64 КиБ).
 */
export interface ProjectInvariantsResponse {
  invariants: string;
  updated_at: string;
}

/**
 * Ответ ToDo-эндпоинтов сессии (`GET`/`POST`/`PATCH`/`DELETE`
 * `/sessions/:id/todos*`) — текущий список задач сессии.
 *
 * Порядок пунктов — порядок массива; текст — Markdown (лимит
 * `MARKDOWN_LIMITS.todoContent`, 4 КиБ).
 */
export interface SessionTodosResponse {
  todos: TodoItem[];
}

// --- pipelines: пайплайны проекта и прогон ---

/**
 * Сводка пайплайна проекта (`pipelineSummary` в core). Поля — как у порта
 * (camelCase); черновик (`draft`) в сводку **не входит** — он в детали
 * `GET /projects/:id/pipelines/:pid`.
 */
export interface PipelineSummary {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  scope: 'instance' | 'project';
  projectId?: string;
  draftVersion: number;
  publishedVersion?: number;
  hasDraft: boolean;
  installedBy?: { pack: string; version: string; templateId?: string };
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** Ответ `GET /projects/:id/pipelines` — страница пайплайнов проекта. */
export interface ProjectPipelinesResponse {
  pipelines: PipelineSummary[];
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
}

/** Заголовок прогона пайплайна (`PipelineRunRecord` порта). */
export interface PipelineRunRecord {
  id: string;
  pipelineId: string;
  version: number;
  spec: unknown;
  projectId?: string;
  status: string;
  currentNode?: string;
  trigger?: unknown;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** Событие журнала прогона (`PipelineRunEventRecord` порта). */
export interface PipelineRunEvent {
  runId: string;
  ts: string;
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Ответ `GET /pipeline-runs/:runId` — прогон + страница журнала.
 *
 * Курсор журнала — **порядковый номер события** в журнале прогона
 * (исключающий): `events_before` — вернутся события строго с меньшим номером.
 * Сервер принимает и метку времени (`ts`) — тогда курсор по времени.
 */
export interface PipelineRunResponse {
  run: PipelineRunRecord;
  events: PipelineRunEvent[];
  /** Есть ли более старые события за пределами страницы. */
  events_has_more: boolean;
  /** Курсор следующей (более старой) страницы журнала; `null` — её нет. */
  events_next_before: number | null;
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

// --- models: каталог моделей (страница) ---

/**
 * Модель каталога (`GET /api/v2/models`) — плоская запись страницы.
 *
 * Транспортный DTO: часть полей опциональна (модальности/цены заданы не у
 * всех моделей), неизвестные поля допускаются.
 */
export interface ModelSummary {
  id: string;
  name: string;
  provider: string;
  description?: string;
  enabled: boolean;
  isDefault: boolean;
  contextWindow?: number;
  contextSource?: string;
  maxOutputTokens?: number;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  priceSource?: string;
  currency?: string;
  /** ADR-115: модальности входа модели; поле отсутствует — «неизвестны». */
  modalities?: string[];
  /** ADR-117: shorthand `compatibility.requireReasoning`. */
  requiresReasoning?: boolean;
  /** ADR-117: перекрытия протокола модели. */
  compatibility?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Query-параметры страницы каталога моделей.
 *
 * Поиск — подстрока по id/имени/провайдеру (без учёта регистра); пагинация —
 * `limit` (по умолчанию 100, максимум 500) и `offset`.
 *
 * Тип-алиас (не interface): набор query-параметров — объектный литерал, у
 * которого TypeScript выводит неявный индекс-сигнатур (нужно для приведения
 * к `SynthQuery` в клиенте).
 */
export type ModelsListParams = {
  /** Подстрока по id/имени/провайдеру (без учёта регистра). */
  search?: string;
  /** Точное имя провайдера. */
  provider?: string;
  /** Модальность входа модели (`text`/`image`/`pdf`/`audio`/`video`). */
  modality?: string;
  /** `true` — только включённые, `false` — только выключенные. */
  enabled?: boolean;
  /** Размер страницы (1..500; по умолчанию 100). */
  limit?: number;
  /** Смещение страницы (с 0). */
  offset?: number;
};

/**
 * Ответ `GET /api/v2/models` — **страница** каталога.
 *
 * Массив моделей больше не возвращается (обратная совместимость не
 * поддерживается); полный каталог — постранично.
 */
export interface ModelListResponse {
  /** Модели текущей страницы. */
  models: ModelSummary[];
  /** Всего моделей после фильтров. */
  total: number;
  /** Смещение текущей страницы. */
  offset: number;
  /** Размер страницы. */
  limit: number;
  /** Курсор следующей страницы; `null` — страница последняя. */
  next_offset: number | null;
}

// --- fs: файлы и каталоги ---

/**
 * Query-параметры чтения файла (`GET /api/v2/fs/read`).
 *
 * Тип-алиас (не interface) — см. `ModelsListParams`.
 */
export type FsReadParams = {
  /** Проект (managed); без него — рабочий каталог по умолчанию (standalone). */
  project_id?: string;
  /** Путь файла относительно workspace. */
  path: string;
};

/**
 * Ответ `GET /api/v2/fs/read`.
 *
 * Файл больше лимита чтения (или бинарный) → `413` с машинным кодом
 * `FILE_TOO_LARGE` и `error.details.maxReadBytes`.
 */
export interface FsReadResult {
  path: string;
  content: string;
  size: number;
  encoding: 'utf-8' | 'binary';
}

/** Query-параметры листинга каталога (`GET /api/v2/fs`). Тип-алиас — см. `ModelsListParams`. */
export type FsListParams = {
  project_id?: string;
  /** Путь каталога относительно workspace. */
  path?: string;
  /** Глубина рекурсии (сервер ограничивает жёстко: `MAX_FS_LIST_DEPTH` = 3). */
  maxDepth?: number;
  /** Показывать скрытые элементы. */
  includeHidden?: boolean;
};

/**
 * Ответ `GET /api/v2/fs`.
 *
 * `truncated: true` — обход прерван по лимиту записей (рекурсивный листинг,
 * `maxDepth > 0`); ответ неполон.
 */
export interface FsListResult {
  path: string;
  entries: FileEntry[];
  truncated?: boolean;
}

// --- git: коммиты ---

/**
 * Query-параметры детали коммита (`GET /api/v2/git/commit`).
 *
 * Тип-алиас (не interface) — см. `ModelsListParams`.
 */
export type GitCommitParams = {
  /** Проект (обязателен: доступ к git-данным — право чтения проекта). */
  project_id: string;
  /** Относительный путь репозитория внутри workspace. */
  repo_path?: string;
  /** Хеш коммита (полный или короткий). */
  hash: string;
};

/**
 * Ответ `GET /api/v2/git/commit`.
 *
 * `commit.diff_truncated: true` — diff обрезан по лимиту размера.
 */
export interface GitCommitResult {
  commit: CommitDetail;
}
