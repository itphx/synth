/**
 * AD-052 (этап I, spike): публичный OpenAPI-контракт интеграционного ядра.
 *
 * Здесь фиксируется **единый формат ошибок** публичных роутов и описывается
 * спецификация по боевым Zod-схемам из `@itphx/synth-shared`. Реальные хендлеры
 * живут в `server/routes/events.ts` — это spike-описание контракта, а не замена
 * боевых роутов (массовая обёртка ~42 хендлеров — этап III).
 *
 * Сгенерированный документ отдаётся ручкой `GET /api/v2/openapi.json`.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
  SYNTH_VERSION,
  eventBindingInputSchema,
  eventBindingSchema,
  eventIngestSchema,
  synthEventSchema,
} from '@itphx/synth-shared';

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

/** Хелпер: описание ответа-ошибки для `createRoute` (единый формат). */
function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: publicErrorSchema } },
  } as const;
}

/** Общий набор ошибочных ответов публичных роутов. */
const publicErrorResponses = {
  400: errorResponse('Некорректный запрос (ошибка валидации)'),
  401: errorResponse('Не аутентифицирован'),
  403: errorResponse('Недостаточно прав'),
  404: errorResponse('Ресурс не найден'),
  409: errorResponse('Конфликт (например, занятая метка ключа)'),
  500: errorResponse('Внутренняя ошибка'),
} as const;

// --- Схемы ответов публичного контракта (если в shared их нет) ---

/** Решение Router (AD-089): `kind` + метаданные; внутренняя форма богаче. */
const routeDecisionSchema = z
  .object({ kind: z.string().min(1).openapi({ example: 'ephemeral' }) })
  .passthrough()
  .openapi('RouteDecision');

/** Ответ `POST /events` (AD-089): событие, решение, id сессии, claim-код. */
const eventIngestResponseSchema = z
  .object({
    event: synthEventSchema,
    decision: routeDecisionSchema,
    sessionId: z.string().nullable().openapi({ example: 'ses_...' }),
    identityHint: z
      .object({ code: z.string(), expiresAt: z.string() })
      .optional()
      .openapi({ description: 'Одноразовый код подтверждения идентичности (claim-flow)' }),
  })
  .openapi('EventIngestResponse');

/** Ответ `GET /events/bindings`. */
const eventBindingListResponseSchema = z
  .object({ bindings: z.array(eventBindingSchema) })
  .openapi('EventBindingListResponse');

// --- Описание операций ---

const ingestEventRoute = createRoute({
  method: 'post',
  path: '/events',
  tags: ['events'],
  summary: 'Приём внешнего события (ingest)',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: eventIngestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Событие принято',
      content: { 'application/json': { schema: eventIngestResponseSchema } },
    },
    503: errorResponse('Приём внешних событий отключён (мастер-выключатель)'),
    ...publicErrorResponses,
  },
});

const listBindingsRoute = createRoute({
  method: 'get',
  path: '/events/bindings',
  tags: ['events'],
  summary: 'Список привязок источник→сессия',
  responses: {
    200: {
      description: 'Список привязок',
      content: { 'application/json': { schema: eventBindingListResponseSchema } },
    },
    ...publicErrorResponses,
  },
});

const upsertBindingRoute = createRoute({
  method: 'post',
  path: '/events/bindings',
  tags: ['events'],
  summary: 'Upsert привязки источник→сессия',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: eventBindingInputSchema } },
    },
  },
  responses: {
    200: {
      description: 'Привязка обновлена',
      content: { 'application/json': { schema: eventBindingSchema } },
    },
    201: {
      description: 'Привязка создана',
      content: { 'application/json': { schema: eventBindingSchema } },
    },
    ...publicErrorResponses,
  },
});

/**
 * OpenAPIHono-приложение публичного контракта.
 *
 * Хендлеры здесь — заглушки, возвращающие валидные по схеме примеры: цель —
 * вывести спецификацию и проверить совместимость типов `createRoute` с нашими
 * Zod-схемами. Живые эндпоинты уже реализованы в `server/routes/events.ts`.
 */
export function createPublicOpenApiApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(ingestEventRoute, (c) =>
    c.json(
      {
        event: {
          id: 'evt_00000000-0000-0000-0000-000000000000',
          source: 'spike',
          type: 'message',
          payload: {},
          identity: {},
          dedupKey: 'spike',
          ts: '1970-01-01T00:00:00.000Z',
        },
        decision: { kind: 'drop' },
        sessionId: null,
      },
      201,
    ),
  );

  app.openapi(listBindingsRoute, (c) => c.json({ bindings: [] }, 200));

  app.openapi(upsertBindingRoute, (c) =>
    c.json({ id: 'evt_bnd_0000', source: 'spike', mode: 'ephemeral' }, 200),
  );

  return app;
}

/**
 * Сгенерировать OpenAPI 3.1-документ публичного контракта.
 *
 * @returns OpenAPI 3.1 JSON с `info`, `servers` (база `/api/v2`) и
 * `components.schemas` (наши shared-схемы + `PublicError`).
 */
export function getPublicOpenApiDocument(): ReturnType<OpenAPIHono['getOpenAPI31Document']> {
  return createPublicOpenApiApp().getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Synth Public API',
      version: SYNTH_VERSION,
      description:
        'Публичный интеграционный контракт Synth (AD-052). Единый формат ошибок: { error: { code, message } }.',
    },
    servers: [{ url: '/api/v2' }],
  });
}
