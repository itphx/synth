import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { generateId, nowISO, pipelineInstanceStatusSchema } from '@itphx/synth-shared';
import type { PipelineInstanceStatus } from '@itphx/synth-shared';
import type {
  PipelineDefinitionRecord,
  PipelineInstanceRecord,
  PipelineRepository,
} from '../../storage/ports/pipeline-repository.js';
import { resolvePipelineInstanceLimit } from '../../storage/ports/pipeline-repository.js';
import { requireScopeOrAdminRole } from '../service-scope.js';
import type { ScopeGuardFactory } from '../service-scope.js';

/**
 * ADR-051/ADR-100: HTTP-контур пайплайнов инстанса.
 *
 * Фабрика общая для core (standalone) и backend (managed): RBAC и scope-гейты
 * задаются через `opts`.
 *
 * **Определения** пайплайнов этим роутом не создаются и не меняются — их
 * ставит установщик пакета расширения (`POST /api/v2/packs`, ADR-086 §5):
 * обойти проверку целостности манифеста `synth.pack` нельзя. Роут даёт
 * чтение реестра и **ручной** запуск экземпляра (проверка/отладка); основной
 * запуск — по событию (ADR-089, правило с `pipeline` в цели).
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface PipelinesRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы. */
export interface PipelinesRouteMessages {
  pipelineNotFound: (c: Context) => string;
  instanceNotFound: (c: Context) => string;
  invalidBody: (c: Context) => string;
  invalidStatus: (c: Context) => string;
}

export interface PipelinesRoutesDeps {
  /** Порт реестра пайплайнов (определения + экземпляры). */
  pipelines: PipelineRepository;
}

export interface PipelinesRoutesOptions {
  /** Guard на чтение (core — `requireAuth`, backend — RBAC). */
  readGuard?: Middleware;
  /** Guard на ручной запуск экземпляра (core — `requireAuth`, backend — RBAC). */
  writeGuard?: Middleware;
  /**
   * ADR-052: scope-гейт service-key для ручного запуска экземпляра —
   * зонтичный `automation:install` (установщик пакета) или роль ADMIN.
   * Дефолт — `requireScopeOrAdminRole`: для интерактивных кред — no-op.
   */
  scopeGuard?: ScopeGuardFactory;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<PipelinesRouteMessages>;
}

const DEFAULT_MESSAGES: PipelinesRouteMessages = {
  pipelineNotFound: () => 'Пайплайн не найден',
  instanceNotFound: () => 'Экземпляр пайплайна не найден',
  invalidBody: () => 'Некорректное тело запроса',
  invalidStatus: () => 'Некорректный статус экземпляра',
};

/** Статусы экземпляра (ADR-051) — допустимые значения фильтра. */
const INSTANCE_STATUSES: readonly PipelineInstanceStatus[] =
  pipelineInstanceStatusSchema.options;

/**
 * Разбор фильтра `status` из query: пусто — без фильтра; нераспознанное
 * значение — ошибка (fail-closed, молчаливый «без фильтра» скрыл бы опечатку).
 */
function parseStatus(raw: string | undefined): { ok: true; value?: PipelineInstanceStatus } | { ok: false } {
  if (raw === undefined || raw.trim() === '') return { ok: true };
  const value = raw.trim() as PipelineInstanceStatus;
  if (!INSTANCE_STATUSES.includes(value)) return { ok: false };
  return { ok: true, value };
}

export function createPipelinesRoutes(
  auth: PipelinesRoutesAuth,
  deps: PipelinesRoutesDeps,
  opts: PipelinesRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: PipelinesRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const readGuard: Middleware = opts.readGuard ?? auth.requireAuth;
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  // ADR-052: scope-гейт service-key (ручной запуск экземпляра).
  const scoped = opts.scopeGuard ?? requireScopeOrAdminRole;

  // GET /api/v2/pipelines — определения пайплайнов инстанса.
  app.get('/', readGuard, async (c) => {
    const definitions = await deps.pipelines.listDefinitions();
    return c.json({ pipelines: definitions });
  });

  // GET /api/v2/pipelines/instances — экземпляры (фильтры `pipelineId`/`status`/`limit`).
  // Регистрируется **до** `/:id` — статический сегмент важнее параметрического.
  app.get('/instances', readGuard, async (c) => {
    const status = parseStatus(c.req.query('status'));
    if (!status.ok) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidStatus(c) } }, 400);
    }
    const limitRaw = c.req.query('limit');
    const parsedLimit = limitRaw === undefined ? Number.NaN : Number.parseInt(limitRaw, 10);
    const instances = await deps.pipelines.listInstances({
      ...(c.req.query('pipelineId') ? { pipelineId: c.req.query('pipelineId')! } : {}),
      ...(status.value ? { status: status.value } : {}),
      limit: resolvePipelineInstanceLimit(Number.isFinite(parsedLimit) ? parsedLimit : undefined),
    });
    return c.json({ instances });
  });

  // GET /api/v2/pipelines/instances/:instanceId — конкретный экземпляр.
  app.get('/instances/:instanceId', readGuard, async (c) => {
    const instance = await deps.pipelines.getInstance(c.req.param('instanceId'));
    if (!instance) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.instanceNotFound(c) } }, 404);
    }
    return c.json(instance);
  });

  // GET /api/v2/pipelines/:id — определение пайплайна.
  app.get('/:id', readGuard, async (c) => {
    const definition = await deps.pipelines.getDefinition(c.req.param('id'));
    if (!definition) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.pipelineNotFound(c) } }, 404);
    }
    return c.json(definition);
  });

  // POST /api/v2/pipelines/:id/instances — **ручной** запуск экземпляра
  // (проверка/отладка; основной запуск — по событию, ADR-089).
  app.post('/:id/instances', writeGuard, scoped('automation:install'), async (c) => {
    const id = c.req.param('id');
    const definition = await deps.pipelines.getDefinition(id);
    if (!definition) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.pipelineNotFound(c) } }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidBody(c) } }, 400);
    }
    const raw = body as Record<string, unknown>;
    const rawTrigger = raw.trigger;
    const trigger =
      typeof rawTrigger === 'object' && rawTrigger !== null && !Array.isArray(rawTrigger)
        ? (rawTrigger as Record<string, unknown>)
        : undefined;
    const payload =
      typeof raw.payload === 'object' && raw.payload !== null && !Array.isArray(raw.payload)
        ? (raw.payload as Record<string, unknown>)
        : undefined;

    const now = nowISO();
    const instance: PipelineInstanceRecord = {
      id: `plrun_${generateId()}`,
      pipelineId: definition.id,
      ...(definition.version ? { pipelineVersion: definition.version } : {}),
      // Экземпляр стартует «в работе»: первый шаг — текущий, остальные — в очереди.
      status: 'running',
      ...(trigger
        ? {
            trigger: {
              ...(typeof trigger.source === 'string' ? { source: trigger.source } : {}),
              ...(typeof trigger.type === 'string' ? { type: trigger.type } : {}),
              ...(typeof trigger.dedupKey === 'string' ? { dedupKey: trigger.dedupKey } : {}),
            },
          }
        : {}),
      steps: definition.steps.map((step) => ({ id: step.id, status: 'pending' as const })),
      ...(definition.steps[0] ? { currentStep: definition.steps[0].id } : {}),
      attempts: 0,
      ...(payload ? { payload } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await deps.pipelines.saveInstance(instance);
    return c.json(instance, 201);
  });

  return app;
}

/** Определение пайплайна в ответе API (реэкспорт типа порта). */
export type { PipelineDefinitionRecord };
