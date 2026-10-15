/**
 * ADR-052 (этап III, часть 1): публичный OpenAPI-контракт интеграционного ядра.
 *
 * **Решение (зафиксировано).** Спецификация — **декларативная**: боевые роуты
 * (`server/routes/*`) не переписываем. `OpenAPIHono` + `createRoute` описывают
 * **публичный контракт** по Zod-схемам `@itphx/synth-shared`, а хендлеры здесь —
 * заглушки, возвращающие валидные примеры. Заглушки нужны только для генерации
 * документа и проверки, что `createRoute` типизируется нашими shared-схемами;
 * живая логика остаётся в единых core-фабриках (`createEventRoutes`,
 * `createSessionRoutes`, `createSchedulerRoutes`, LLM-прокси). Так сохраняется
 * паритет core↔backend (одна фабрика на оба) и не дублируется логика; спека
 * описывает контракт, а не подменяет боевые обработчики.
 *
 * Публикуется только **интеграционное ядро** (`events`/`sessions`/`schedules`/`llm`)
 * — см. ADR-052 (OpenAPI — только public, детали — `docs/API_V2.md` §5.30): fs/audit/admin/секреты
 * наружу не выводим.
 * Единый формат ошибок — `publicErrorSchema` (`{error:{code,message}}`).
 *
 * **Именование схем.** Модели `components.schemas` получают имена через
 * `.openapi('Name')`. По данным `@asteasolutions/zod-to-openapi@7` (используется
 * `@hono/zod-openapi@0.19.x`) вызов `.openapi()` возвращает **новую** инстанцию
 * схемы и не мутирует исходную, поэтому обернуть shared-схему в именованную модель
 * безопасно: экспортируемый из `@itphx/synth-shared` объект остаётся неизменным,
 * а именованный алиас локально переиспользуется в `createRoute`.
 *
 * Сгенерированный документ отдаётся ручкой `GET /api/v2/openapi.json` (за `requireAuth`).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
  SYNTH_VERSION,
  eventBindingApiKeyCreateSchema,
  eventBindingApiKeyCreatedSchema,
  eventBindingApiKeySchema,
  eventBindingApiKeyUpdateSchema,
  eventBindingInputSchema,
  eventBindingSchema,
  eventIngestSchema,
  eventRouteRuleSchema,
  eventRouteRuleUpsertSchema,
  promptRequestSchema,
  scheduleInputSchema,
  scheduleJobSchema,
  scheduleSchema,
  sessionCreateSchema,
  sessionUpdateSchema,
  synthEventSchema,
} from '@itphx/synth-shared';

// --- Единый формат ошибок публичных роутов ---

/**
 * Единый формат ошибок публичных роутов API v2.
 *
 * Совпадает со сложившимся форматом core-роутов (см. `server/routes/*`):
 * `{ error: { code, message } }`, где `code` — машиночитаемый код
 * (`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
 * `RATE_LIMITED`, `UNAVAILABLE`, `INTERNAL_ERROR`), `message` — человекочитаемый.
 */
export const publicErrorSchema = z
  .object({
    error: z.object({
      code: z.string().min(1).openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string().min(1).openapi({ example: 'Некорректное тело события' }),
    }),
  })
  .openapi('publicErrorSchema');

export type PublicError = z.infer<typeof publicErrorSchema>;

/** Успешный JSON-ответ: описание + схема (generic сохраняет точный тип схемы). */
function jsonResponse<S extends z.ZodTypeAny>(description: string, schema: S) {
  return { description, content: { 'application/json': { schema } } };
}

/** Хелпер: описание ответа-ошибки для `createRoute` (единый формат). */
function errorResponse(description: string) {
  return jsonResponse(description, publicErrorSchema);
}

/** Полный набор ошибочных ответов публичных роутов (400/401/403/404/409/429/500/503). */
const publicErrorResponses = {
  400: errorResponse('Некорректный запрос (ошибка валидации)'),
  401: errorResponse('Не аутентифицирован'),
  403: errorResponse('Недостаточно прав / scope service-key'),
  404: errorResponse('Ресурс не найден'),
  409: errorResponse('Конфликт (например, занятая метка ключа)'),
  429: errorResponse('Превышен лимит запросов'),
  500: errorResponse('Внутренняя ошибка'),
  503: errorResponse('Функция отключена (мастер-выключатель)'),
} as const;

/** Security-требование: bearer (service-key, ADR-052). */
const BEARER_SECURITY: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

// --- Именованные модели на базе shared-схем ---

const SynthEvent = synthEventSchema.openapi('SynthEvent', {
  description: 'Нормализованное внешнее событие (ADR-089).',
});
const EventBinding = eventBindingSchema.openapi('EventBinding', {
  description: 'Устойчивая привязка внешнего адреса (source/chat/thread) к сессии или шаблону.',
});
const EventBindingInput = eventBindingInputSchema.openapi('EventBindingInput', {
  description: 'Вход upsert-привязки (без `id`).',
});
const EventBindingApiKey = eventBindingApiKeySchema.openapi('EventBindingApiKey', {
  description: 'Метаданные API-ключа привязки (без секрета и хеша).',
});
const EventBindingApiKeyCreate = eventBindingApiKeyCreateSchema.openapi('EventBindingApiKeyCreate', {
  description: 'Тело создания API-ключа привязки.',
});
const EventBindingApiKeyUpdate = eventBindingApiKeyUpdateSchema.openapi('EventBindingApiKeyUpdate', {
  description: 'Тело обновления API-ключа привязки (`null` — сброс поля).',
});
const EventBindingApiKeyCreated = eventBindingApiKeyCreatedSchema.openapi('EventBindingApiKeyCreated', {
  description: 'Созданный API-ключ: метаданные + plaintext-секрет (показывается один раз).',
});
const EventIngest = eventIngestSchema.openapi('EventIngest', {
  description:
    'Тело приёма внешнего события. Для пути по API-ключу привязки `source` опционален и берётся из привязки.',
});
const EventRouteRule = eventRouteRuleSchema.openapi('EventRouteRule', {
  description: 'Правило маршрутизации событий «событие → сессия» (ADR-089).',
});
const EventRouteRuleUpsert = eventRouteRuleUpsertSchema.openapi('EventRouteRuleUpsert', {
  description: 'Вход upsert-правила маршрутизации (необязательный `id` — обновление).',
});
const SessionCreate = sessionCreateSchema.openapi('SessionCreate', {
  description: 'Тело создания сессии.',
});
const SessionPatch = sessionUpdateSchema
  .extend({
    title: z.string().min(1).max(200).optional(),
    mode: z.enum(['plan', 'act', 'yolo']).optional(),
    project_id: z.string().nullable().optional(),
  })
  .openapi('SessionPatch', {
    description: 'Тело обновления сессии (частичное).',
  });
const ScheduleInput = scheduleInputSchema.openapi('ScheduleInput', {
  description: 'Тело создания/обновления расписания (ровно одно из `cron`/`every`).',
});
const Schedule = scheduleSchema.openapi('Schedule', {
  description: 'Сущность расписания планировщика (ADR-051).',
});
const ScheduleJob = scheduleJobSchema.openapi('ScheduleJob', {
  description: 'Запись Job-истории срабатывания расписания (ADR-051).',
});
const SessionPrompt = promptRequestSchema.openapi('SessionPrompt', {
  description: 'Тело отправки сообщения в сессию (очередь + SSE-поток хода).',
});

// --- Локальные схемы ответов публичного контракта ---

/** Решение Router (ADR-089): `kind` + диагностические метаданные. */
const RouteDecision = z
  .object({
    kind: z.string().min(1).openapi({ example: 'ephemeral' }),
    reason: z.string().optional(),
    sessionId: z.string().optional(),
    confidence: z.number().optional(),
    signals: z.array(z.string()).optional(),
  })
  .passthrough()
  .openapi('RouteDecision');

/** Ответ `POST /events` (ADR-089): событие, решение, id сессии, claim-код. */
const EventIngestResponse = z
  .object({
    event: SynthEvent,
    decision: RouteDecision,
    sessionId: z.string().nullable().openapi({ example: 'ses_...' }),
    identityHint: z
      .object({ code: z.string(), expiresAt: z.string() })
      .optional()
      .openapi({ description: 'Одноразовый код подтверждения идентичности (claim-flow)' }),
  })
  .openapi('EventIngestResponse');

/** Запись журнала решений Router (`GET /events/journal`). */
const EventJournalEntry = z
  .object({
    ts: z.string().min(1),
    event: SynthEvent,
    decision: RouteDecision.optional(),
    error: z.string().optional(),
    keyId: z.string().optional(),
    principalId: z.string().optional(),
  })
  .openapi('EventJournalEntry');

const EventJournalResponse = z
  .object({ entries: z.array(EventJournalEntry) })
  .openapi('EventJournalResponse');

const EventBindingListResponse = z
  .object({ bindings: z.array(EventBinding) })
  .openapi('EventBindingListResponse');

const EventBindingApiKeyListResponse = z
  .object({ keys: z.array(EventBindingApiKey) })
  .openapi('EventBindingApiKeyListResponse');

const EventRouteRuleListResponse = z
  .object({ rules: z.array(EventRouteRule) })
  .openapi('EventRouteRuleListResponse');

/** Публичный срез сериализованной сессии (`serializeSession`). */
const Session = z
  .object({
    id: z.string().min(1).openapi({ example: 'ses_00000000-0000-0000-0000-000000000000' }),
    name: z.string().nullable(),
    icon: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    parent_id: z.string().nullable().optional(),
    mode: z.enum(['plan', 'act', 'yolo']),
    project_id: z.string().nullable().optional(),
    owner_id: z.string().nullable().optional(),
    messages: z.array(z.unknown()),
    pending_count: z.number().int().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .openapi('Session', { description: 'Сериализованная сессия (публичное подмножество).' });

const SessionMessagesResponse = z
  .object({
    messages: z.array(z.unknown()),
    session_id: z.string(),
  })
  .openapi('SessionMessagesResponse');

const SessionStatusResponse = z
  .object({
    blocked: z.boolean(),
    pending_count: z.number().int(),
    processor_running: z.boolean(),
  })
  .openapi('SessionStatusResponse');

const ScheduleResponse = z
  .object({ schedule: Schedule })
  .openapi('ScheduleResponse');

const ScheduleJobListResponse = z
  .object({ jobs: z.array(ScheduleJob) })
  .openapi('ScheduleJobListResponse');

// --- LLM Proxy (OpenAI-совместимый), по факту `packages/backend/src/routes/llm.ts` ---

const ChatMessage = z.object({
  role: z.string().min(1),
  content: z.string().nullable(),
  tool_calls: z.array(z.record(z.unknown())).optional(),
  tool_call_id: z.string().optional(),
  reasoning_content: z.string().optional(),
  name: z.string().optional(),
});

const ChatCompletionsRequest = z
  .object({
    model: z.string().min(1),
    messages: z.array(ChatMessage).min(1),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    tools: z.array(z.record(z.unknown())).optional(),
    session_id: z.string().optional(),
    provider: z.string().optional(),
  })
  .openapi('ChatCompletionsRequest', { description: 'OpenAI-совместимое тело chat/completions.' });

const ChatCompletionsResponse = z
  .object({
    id: z.string().min(1),
    object: z.literal('chat.completion'),
    created: z.number().int(),
    model: z.string(),
    choices: z.array(
      z.object({
        index: z.number().int(),
        message: z.object({
          role: z.string(),
          content: z.string().nullable(),
          tool_calls: z.array(z.record(z.unknown())).optional(),
          reasoning_content: z.string().optional(),
        }),
        finish_reason: z.string().nullable(),
      }),
    ),
    usage: z.object({
      prompt_tokens: z.number().int(),
      completion_tokens: z.number().int(),
      total_tokens: z.number().int(),
    }),
  })
  .openapi('ChatCompletionsResponse', {
    description: 'OpenAI-совместимый нестриминговый ответ chat/completions.',
  });

// --- Параметры и query ---

const SessionParams = z.object({ id: z.string().min(1) });
const ScheduleParams = z.object({ id: z.string().min(1) });
const BindingParams = z.object({ id: z.string().min(1) });
const BindingKeyParams = z.object({ id: z.string().min(1), keyId: z.string().min(1) });

const SessionsListQuery = z.object({
  project_id: z.string().optional().openapi({ description: 'Фильтр по проекту' }),
});
const JournalQuery = z.object({
  limit: z.coerce.number().int().positive().optional().openapi({ description: 'Лимит: default 50, max 500' }),
});
const JobsQuery = z.object({
  limit: z.coerce.number().int().positive().optional().openapi({ description: 'default 20, max 200' }),
});

// --- Операции: events (ADR-089) ---

const ingestEventRoute = createRoute({
  method: 'post',
  path: '/events',
  tags: ['events'],
  summary: 'Приём внешнего события (ingest)',
  description:
    'Принимает нормализованное событие. Аутентификация: пользовательский ключ/service-key (`events:ingest`) либо API-ключ привязки `Authorization: Bearer synth_evt_…` (source/чат из привязки).',
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: EventIngest } } },
  },
  responses: {
    201: jsonResponse('Событие принято', EventIngestResponse),
    ...publicErrorResponses,
  },
});

const listEventJournalRoute = createRoute({
  method: 'get',
  path: '/events/journal',
  tags: ['events'],
  summary: 'Журнал решений Router',
  security: BEARER_SECURITY,
  request: { query: JournalQuery },
  responses: {
    200: jsonResponse('Последние записи журнала', EventJournalResponse),
    ...publicErrorResponses,
  },
});

const listEventBindingsRoute = createRoute({
  method: 'get',
  path: '/events/bindings',
  tags: ['events'],
  summary: 'Список привязок источник→сессия',
  security: BEARER_SECURITY,
  responses: {
    200: jsonResponse('Список привязок', EventBindingListResponse),
    ...publicErrorResponses,
  },
});

const upsertEventBindingRoute = createRoute({
  method: 'post',
  path: '/events/bindings',
  tags: ['events'],
  summary: 'Upsert привязки источник→сессия',
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: EventBindingInput } } },
  },
  responses: {
    200: jsonResponse('Привязка обновлена', EventBinding),
    201: jsonResponse('Привязка создана', EventBinding),
    ...publicErrorResponses,
  },
});

const deleteEventBindingRoute = createRoute({
  method: 'delete',
  path: '/events/bindings/{id}',
  tags: ['events'],
  summary: 'Удалить привязку',
  description: 'Удаляет привязку и каскадно её API-ключи.',
  security: BEARER_SECURITY,
  request: { params: BindingParams },
  responses: {
    204: { description: 'Привязка удалена' },
    ...publicErrorResponses,
  },
});

const listEventBindingKeysRoute = createRoute({
  method: 'get',
  path: '/events/bindings/{id}/keys',
  tags: ['events'],
  summary: 'API-ключи привязки',
  security: BEARER_SECURITY,
  request: { params: BindingParams },
  responses: {
    200: jsonResponse('Список ключей привязки (без секретов)', EventBindingApiKeyListResponse),
    ...publicErrorResponses,
  },
});

const createEventBindingKeyRoute = createRoute({
  method: 'post',
  path: '/events/bindings/{id}/keys',
  tags: ['events'],
  summary: 'Создать API-ключ привязки',
  description: 'Секрет `synth_evt_<base64url>` возвращается единственный раз при создании.',
  security: BEARER_SECURITY,
  request: {
    params: BindingParams,
    body: { required: true, content: { 'application/json': { schema: EventBindingApiKeyCreate } } },
  },
  responses: {
    201: jsonResponse('Ключ создан (секрет — единожды)', EventBindingApiKeyCreated),
    ...publicErrorResponses,
  },
});

const updateEventBindingKeyRoute = createRoute({
  method: 'patch',
  path: '/events/bindings/{id}/keys/{keyId}',
  tags: ['events'],
  summary: 'Обновить метаданные API-ключа привязки',
  security: BEARER_SECURITY,
  request: {
    params: BindingKeyParams,
    body: { required: true, content: { 'application/json': { schema: EventBindingApiKeyUpdate } } },
  },
  responses: {
    200: jsonResponse('Ключ обновлён', EventBindingApiKey),
    ...publicErrorResponses,
  },
});

const revokeEventBindingKeyRoute = createRoute({
  method: 'post',
  path: '/events/bindings/{id}/keys/{keyId}/revoke',
  tags: ['events'],
  summary: 'Мягкий отзыв API-ключа привязки',
  security: BEARER_SECURITY,
  request: { params: BindingKeyParams },
  responses: {
    200: jsonResponse('Ключ отозван', EventBindingApiKey),
    ...publicErrorResponses,
  },
});

const deleteEventBindingKeyRoute = createRoute({
  method: 'delete',
  path: '/events/bindings/{id}/keys/{keyId}',
  tags: ['events'],
  summary: 'Удалить API-ключ привязки',
  security: BEARER_SECURITY,
  request: { params: BindingKeyParams },
  responses: {
    204: { description: 'Ключ удалён' },
    ...publicErrorResponses,
  },
});

const listEventRoutesRoute = createRoute({
  method: 'get',
  path: '/events/routes',
  tags: ['events'],
  summary: 'Список правил маршрутизации',
  security: BEARER_SECURITY,
  responses: {
    200: jsonResponse('Список правил', EventRouteRuleListResponse),
    ...publicErrorResponses,
  },
});

const upsertEventRouteRoute = createRoute({
  method: 'post',
  path: '/events/routes',
  tags: ['events'],
  summary: 'Upsert правила маршрутизации',
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: EventRouteRuleUpsert } } },
  },
  responses: {
    200: jsonResponse('Правило обновлено', EventRouteRule),
    201: jsonResponse('Правило создано', EventRouteRule),
    ...publicErrorResponses,
  },
});

const deleteEventRouteRoute = createRoute({
  method: 'delete',
  path: '/events/routes/{id}',
  tags: ['events'],
  summary: 'Удалить правило маршрутизации',
  security: BEARER_SECURITY,
  request: { params: BindingParams },
  responses: {
    204: { description: 'Правило удалено' },
    ...publicErrorResponses,
  },
});

// --- Операции: sessions (публичное подмножество) ---

const listSessionsRoute = createRoute({
  method: 'get',
  path: '/sessions',
  tags: ['sessions'],
  summary: 'Список сессий',
  description: 'Свои личные + сессии проектов-участий; ADMIN/LEAD — все.',
  security: BEARER_SECURITY,
  request: { query: SessionsListQuery },
  responses: {
    200: jsonResponse('Список сессий', z.array(Session)),
    ...publicErrorResponses,
  },
});

const createSessionRoute = createRoute({
  method: 'post',
  path: '/sessions',
  tags: ['sessions'],
  summary: 'Создать сессию',
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: SessionCreate } } },
  },
  responses: {
    201: jsonResponse('Сессия создана', Session),
    ...publicErrorResponses,
  },
});

const getSessionRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}',
  tags: ['sessions'],
  summary: 'Сессия по id',
  security: BEARER_SECURITY,
  request: { params: SessionParams },
  responses: {
    200: jsonResponse('Сессия', Session),
    ...publicErrorResponses,
  },
});

const patchSessionRoute = createRoute({
  method: 'patch',
  path: '/sessions/{id}',
  tags: ['sessions'],
  summary: 'Обновить сессию',
  description: 'Частичное обновление: `name`/`title`/`mode`/`settings`/`project_id`.',
  security: BEARER_SECURITY,
  request: {
    params: SessionParams,
    body: { required: true, content: { 'application/json': { schema: SessionPatch } } },
  },
  responses: {
    200: jsonResponse('Сессия обновлена', Session),
    ...publicErrorResponses,
  },
});

const deleteSessionRoute = createRoute({
  method: 'delete',
  path: '/sessions/{id}',
  tags: ['sessions'],
  summary: 'Удалить сессию',
  security: BEARER_SECURITY,
  request: { params: SessionParams },
  responses: {
    204: { description: 'Сессия удалена' },
    ...publicErrorResponses,
  },
});

const getSessionStatusRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}/status',
  tags: ['sessions'],
  summary: 'Статус сессии',
  security: BEARER_SECURITY,
  request: { params: SessionParams },
  responses: {
    200: jsonResponse('Статус сессии', SessionStatusResponse),
    ...publicErrorResponses,
  },
});

const promptSessionRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/prompt',
  tags: ['sessions'],
  summary: 'Отправить сообщение в сессию (SSE)',
  description: 'Ставит сообщение в очередь и возвращает SSE-поток событий хода.',
  security: BEARER_SECURITY,
  request: {
    params: SessionParams,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: SessionPrompt,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'SSE-поток событий хода',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    ...publicErrorResponses,
  },
});

const getSessionMessagesRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}/messages',
  tags: ['sessions'],
  summary: 'Сообщения сессии',
  security: BEARER_SECURITY,
  request: { params: SessionParams },
  responses: {
    200: jsonResponse('Сообщения сессии', SessionMessagesResponse),
    ...publicErrorResponses,
  },
});

// --- Операции: schedules (ADR-051) ---

const listSchedulesRoute = createRoute({
  method: 'get',
  path: '/schedules',
  tags: ['schedules'],
  summary: 'Список расписаний',
  security: BEARER_SECURITY,
  responses: {
    200: jsonResponse('Список расписаний', z.object({ schedules: z.array(Schedule) })),
    ...publicErrorResponses,
  },
});

const createScheduleRoute = createRoute({
  method: 'post',
  path: '/schedules',
  tags: ['schedules'],
  summary: 'Создать расписание',
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: ScheduleInput } } },
  },
  responses: {
    201: jsonResponse('Расписание создано', ScheduleResponse),
    ...publicErrorResponses,
  },
});

const updateScheduleRoute = createRoute({
  method: 'put',
  path: '/schedules/{id}',
  tags: ['schedules'],
  summary: 'Обновить расписание',
  security: BEARER_SECURITY,
  request: {
    params: ScheduleParams,
    body: { required: true, content: { 'application/json': { schema: ScheduleInput } } },
  },
  responses: {
    200: jsonResponse('Расписание обновлено', ScheduleResponse),
    ...publicErrorResponses,
  },
});

const deleteScheduleRoute = createRoute({
  method: 'delete',
  path: '/schedules/{id}',
  tags: ['schedules'],
  summary: 'Удалить расписание',
  security: BEARER_SECURITY,
  request: { params: ScheduleParams },
  responses: {
    204: { description: 'Расписание удалено' },
    ...publicErrorResponses,
  },
});

const runScheduleRoute = createRoute({
  method: 'post',
  path: '/schedules/{id}/run',
  tags: ['schedules'],
  summary: 'Принудительный запуск расписания',
  description: 'Force-запуск (в т.ч. выключенного расписания); под rate limit в managed.',
  security: BEARER_SECURITY,
  request: { params: ScheduleParams },
  responses: {
    200: jsonResponse('Расписание запущено', ScheduleResponse),
    ...publicErrorResponses,
  },
});

const listScheduleJobsRoute = createRoute({
  method: 'get',
  path: '/schedules/{id}/jobs',
  tags: ['schedules'],
  summary: 'История срабатываний расписания',
  security: BEARER_SECURITY,
  request: { params: ScheduleParams, query: JobsQuery },
  responses: {
    200: jsonResponse('Job-история', ScheduleJobListResponse),
    ...publicErrorResponses,
  },
});

// --- Операции: llm (OpenAI-совместимый прокси) ---

const chatCompletionsRoute = createRoute({
  method: 'post',
  path: '/llm/chat/completions',
  tags: ['llm'],
  summary: 'OpenAI-совместимый LLM-прокси',
  description: 'Требует scope `llm:chat` (service-key). Стриминг — при `stream: true` (SSE).',
  security: BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: ChatCompletionsRequest } } },
  },
  responses: {
    200: {
      description: 'Ответ модели (JSON либо SSE при `stream: true`)',
      content: {
        'application/json': { schema: ChatCompletionsResponse },
        'text/event-stream': { schema: z.string() },
      },
    },
    ...publicErrorResponses,
  },
});

// --- Примеры для заглушек ---

const SAMPLE_EVENT = {
  id: 'evt_00000000-0000-0000-0000-000000000000',
  source: 'spike',
  type: 'message',
  payload: {},
  identity: {},
  dedupKey: 'spike',
  ts: '1970-01-01T00:00:00.000Z',
};

const SAMPLE_BINDING = { id: 'evt_bnd_0000', source: 'spike', mode: 'ephemeral' as const };

const SAMPLE_KEY = {
  id: 'eak_0000',
  bindingId: 'evt_bnd_0000',
  label: 'spike',
  createdBy: 'local',
  createdAt: '1970-01-01T00:00:00.000Z',
  prefix: 'synth_evt_',
};

const SAMPLE_RULE = {
  id: 'rule_0000',
  priority: 0,
  enabled: true,
  match: {},
  target: { mode: 'ephemeral' as const },
};

const SAMPLE_SESSION = {
  id: 'ses_00000000-0000-0000-0000-000000000000',
  name: null,
  mode: 'act' as const,
  messages: [],
  created_at: '1970-01-01T00:00:00.000Z',
  updated_at: '1970-01-01T00:00:00.000Z',
};

const SAMPLE_SCHEDULE = {
  id: 'sch_0000',
  name: 'spike',
  enabled: true,
  cron: '0 * * * *',
  target: { mode: 'ephemeral' as const },
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/**
 * OpenAPIHono-приложение публичного контракта.
 *
 * Хендлеры здесь — заглушки, возвращающие валидные по схеме примеры: цель —
 * вывести спецификацию и проверить совместимость типов `createRoute` с нашими
 * Zod-схемами. Живые эндпоинты уже реализованы в `server/routes/*`.
 */
export function createPublicOpenApiApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  // Security-схема (components.securitySchemes) — регистрируется как raw-компонент,
  // т.к. конфиг `getOpenAPI31Document` не принимает `components` (перезаписывается
  // сгенерированными схемами).
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Service-key (ADR-052): `Authorization: Bearer synth_svc_…`',
  });

  // --- events ---
  app.openapi(ingestEventRoute, (c) =>
    c.json({ event: SAMPLE_EVENT, decision: { kind: 'drop' }, sessionId: null }, 201),
  );
  app.openapi(listEventJournalRoute, (c) => c.json({ entries: [] }, 200));
  app.openapi(listEventBindingsRoute, (c) => c.json({ bindings: [] }, 200));
  app.openapi(upsertEventBindingRoute, (c) => c.json(SAMPLE_BINDING, 201));
  app.openapi(deleteEventBindingRoute, (c) => c.body(null, 204));
  app.openapi(listEventBindingKeysRoute, (c) => c.json({ keys: [] }, 200));
  app.openapi(createEventBindingKeyRoute, (c) =>
    c.json({ ...SAMPLE_KEY, key: 'synth_evt_spike' }, 201),
  );
  app.openapi(updateEventBindingKeyRoute, (c) => c.json(SAMPLE_KEY, 200));
  app.openapi(revokeEventBindingKeyRoute, (c) => c.json(SAMPLE_KEY, 200));
  app.openapi(deleteEventBindingKeyRoute, (c) => c.body(null, 204));
  app.openapi(listEventRoutesRoute, (c) => c.json({ rules: [] }, 200));
  app.openapi(upsertEventRouteRoute, (c) => c.json(SAMPLE_RULE, 201));
  app.openapi(deleteEventRouteRoute, (c) => c.body(null, 204));

  // --- sessions ---
  app.openapi(listSessionsRoute, (c) => c.json([], 200));
  app.openapi(createSessionRoute, (c) => c.json(SAMPLE_SESSION, 201));
  app.openapi(getSessionRoute, (c) => c.json(SAMPLE_SESSION, 200));
  app.openapi(patchSessionRoute, (c) => c.json(SAMPLE_SESSION, 200));
  app.openapi(deleteSessionRoute, (c) => c.body(null, 204));
  app.openapi(getSessionStatusRoute, (c) =>
    c.json({ blocked: false, pending_count: 0, processor_running: false }, 200),
  );
  app.openapi(promptSessionRoute, () =>
    new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  );
  app.openapi(getSessionMessagesRoute, (c) =>
    c.json({ messages: [], session_id: SAMPLE_SESSION.id }, 200),
  );

  // --- schedules ---
  app.openapi(listSchedulesRoute, (c) => c.json({ schedules: [] }, 200));
  app.openapi(createScheduleRoute, (c) => c.json({ schedule: SAMPLE_SCHEDULE }, 201));
  app.openapi(updateScheduleRoute, (c) => c.json({ schedule: SAMPLE_SCHEDULE }, 200));
  app.openapi(deleteScheduleRoute, (c) => c.body(null, 204));
  app.openapi(runScheduleRoute, (c) => c.json({ schedule: SAMPLE_SCHEDULE }, 200));
  app.openapi(listScheduleJobsRoute, (c) => c.json({ jobs: [] }, 200));

  // --- llm ---
  app.openapi(chatCompletionsRoute, (c) =>
    c.json(
      {
        id: 'chatcmpl-spike',
        object: 'chat.completion' as const,
        created: 0,
        model: 'spike',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      200,
    ),
  );

  return app;
}

/** Теги публичного контракта. */
const PUBLIC_TAGS = [
  { name: 'events', description: 'Внешние события, привязки, правила маршрутизации (ADR-089).' },
  { name: 'sessions', description: 'Сессии: создание, чтение, подсказки (ADR-017/ADR-040).' },
  { name: 'schedules', description: 'Расписания планировщика (ADR-051).' },
  { name: 'llm', description: 'OpenAI-совместимый LLM-прокси (ADR-036/ADR-052).' },
];

/**
 * Сгенерировать OpenAPI 3.1-документ публичного контракта.
 *
 * @returns OpenAPI 3.1 JSON с `info`, `servers` (база `/api/v2`), `tags`,
 * top-level `security` (bearer service-key) и `components.schemas` (именованные
 * модели + `publicErrorSchema`).
 */
export function getPublicOpenApiDocument(): ReturnType<OpenAPIHono['getOpenAPI31Document']> {
  return createPublicOpenApiApp().getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Synth Public API',
      version: SYNTH_VERSION,
      description:
        'Публичный интеграционный контракт Synth (ADR-052): events/sessions/schedules/llm. Единый формат ошибок: { error: { code, message } }. Аутентификация — service-key (`Authorization: Bearer synth_svc_…`).',
    },
    servers: [{ url: '/api/v2' }],
    tags: PUBLIC_TAGS,
    security: BEARER_SECURITY,
  });
}
