import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import {
  generateId,
  nowISO,
  pipelineSpecSchema,
  pipelineRunStatusSchema,
  pipelineRunTriggerSchema,
  validatePipelineSpec,
} from '@itphx/synth-shared';
import type {
  PipelineNode,
  PipelineRunStatus,
  PipelineRunTrigger,
  PipelineSpec,
  Project,
} from '@itphx/synth-shared';
import type {
  PipelineRecord,
  PipelineRunRecord,
  PipelineRunRepository,
  PipelineVersionRecord,
  ProjectPipelineRepository,
} from '../../storage/ports/index.js';
import type {
  PipelineDefinitionRecord,
  PipelineRepository,
} from '../../storage/ports/pipeline-repository.js';
import type { ProjectRepository } from '../../storage/ports/project-repository.js';
import { PipelineEngineError } from '../../engine/pipelines/index.js';
import type { PipelineEngine } from '../../engine/pipelines/index.js';
import {
  checkServiceProjectProjection,
  requireScopeOrAdminRole,
} from '../service-scope.js';
import type { ScopeGuardFactory, ServiceProjectProjectionGuard } from '../service-scope.js';

/**
 * ADR-101 (Э6): HTTP-контур пайплайнов — проектные пайплайны, прогоны,
 * HITL-действия и шаблоны инстанса.
 *
 * Единая фабрика для core (standalone) и backend (managed): RBAC, scope-гейты
 * и локализация задаются через `opts` (как в `createSchedulerRoutes`).
 *
 * ## Модель
 *
 * - **пайплайн проекта** (`scope:'project'`) — спецификация с версиями:
 *   черновик (`draft`) + неизменяемые опубликованные версии (`publishedVersion`).
 *   Читается и меняется **по правилам проекта** (ADR-089 §5.5/§5.8): читать —
 *   владелец/участник/`LEAD`/`ADMIN`, изменять — `OWNER`/`EDITOR`/`LEAD`/`ADMIN`
 *   (инвариант 21: `VIEWER` читает, но не мутирует);
 * - **прогон** — самодостаточная запись (снимок спецификации) + журнал
 *   (append-only). Прогон переживает удаление пайплайна;
 * - **шаблон инстанса** (`scope:'instance'` или legacy-определение ADR-100) —
 *   источник для инстанцирования: копия спецификации в **черновик** пайплайна
 *   проекта с провенансом `installedBy`.
 *
 * ## Пути
 *
 * Пути новой модели **не пересекаются** с legacy-контуром ADR-100
 * (`/api/v2/pipelines*`, `createPipelinesRoutes`): здесь `/api/v2/projects/:id/pipelines*`,
 * `/api/v2/pipeline-runs*` и `/api/v2/pipeline-templates*`. Старые эндпоинты
 * продолжают работать (ADR-100, устаревают — см. `docs/API_V2.md` §5.34).
 *
 * ## Граница доступа (инвариант 16)
 *
 * Проверка доступа — **на границе** (guard), а не в обработчике: guard резолвит
 * проект/прогон ОДИН раз, кладёт разрезолвленную сущность в контекст, и
 * обработчик работает только с ней. Внутри обработчиков проверок доступа нет.
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface PipelineProjectRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт `t()`, core — русские литералы. */
export interface PipelineProjectRouteMessages {
  /** Пайплайн проекта не найден (404). */
  pipelineNotFound: (c: Context) => string;
  /** Прогон не найден (404). */
  runNotFound: (c: Context) => string;
  /** Проект не найден (404). */
  projectNotFound: (c: Context) => string;
  /** Шаблон инстанса не найден (404). */
  templateNotFound: (c: Context) => string;
  /** Нет доступа к проекту/прогону (403). */
  forbidden: (c: Context) => string;
  /** Некорректное тело запроса (400). */
  invalidBody: (c: Context) => string;
  /** Спецификация невалидна (400) — в ответе список проблем. */
  invalidSpec: (c: Context) => string;
  /** Нет опубликованной версии (409). */
  notPublished: (c: Context) => string;
  /** Прогон не в состоянии `awaiting_human` (409). */
  invalidState: (c: Context) => string;
  /** Публиковать нечего (409). */
  nothingToPublish: (c: Context) => string;
  /** Прогон уже завершён — отменять нечего (409). */
  runFinished: (c: Context) => string;
  /** Шаблон нельзя инстанцировать в пайплайн движка (409). */
  templateNotInstantiable: (c: Context) => string;
  /** Не указан проект (400). */
  projectIdRequired: (c: Context) => string;
}

const DEFAULT_MESSAGES: PipelineProjectRouteMessages = {
  pipelineNotFound: () => 'Пайплайн не найден',
  runNotFound: () => 'Прогон не найден',
  projectNotFound: () => 'Проект не найден',
  templateNotFound: () => 'Шаблон пайплайна не найден',
  forbidden: () => 'Доступ запрещён',
  invalidBody: () => 'Некорректное тело запроса',
  invalidSpec: () => 'Спецификация пайплайна некорректна',
  notPublished: () => 'У пайплайна нет опубликованной версии',
  invalidState: () => 'Прогон не ожидает решения человека',
  nothingToPublish: () => 'Нет черновика для публикации',
  runFinished: () => 'Прогон уже завершён',
  templateNotInstantiable: () => 'Шаблон нельзя инстанцировать в пайплайн',
  projectIdRequired: () => 'Не указан проект',
};

/** Зависимости фабрики: порты слоя хранения (ADR-096) и движок (ADR-101). */
export interface PipelineProjectRoutesDeps {
  /** Порт спецификаций пайплайнов (черновик + опубликованные версии). */
  pipelines: ProjectPipelineRepository;
  /** Порт прогонов и журнала выполнения. */
  runs: PipelineRunRepository;
  /** Движок пайплайнов (второй движок, ADR-101). */
  engine: PipelineEngine;
  /** Порт проектов — по нему резолвятся права на проект. */
  projects: ProjectRepository;
  /**
   * Legacy-реестр пайплайнов инстанса (ADR-100) — **источник шаблонов**:
   * его наполняет установщик пакета расширения (`provides.pipelines[]`).
   * Не задан — шаблонами считаются только записи `scope:'instance'`.
   */
  templates?: PipelineRepository;
}

export interface PipelineProjectRoutesOptions {
  /** Guard на мутации (core — `requireAuth`, managed — `requireAuth`). */
  writeGuard?: Middleware;
  /**
   * Guard на инстанс-уровень (шаблоны, инстанцирование): core — `requireAuth`,
   * managed — `requirePermission('ADMIN')`.
   */
  adminGuard?: Middleware;
  /**
   * ADR-089: право **чтения** проекта (owner/участник/`LEAD`/`ADMIN`).
   * Не задано — разрешено (standalone: один пользователь).
   */
  canReadProject?: (c: Context, project: Project, userId: string) => boolean | Promise<boolean>;
  /**
   * ADR-089/инвариант 21: право **изменения содержимого** проекта
   * (`OWNER`/`EDITOR`/`LEAD`/`ADMIN`). Не задано — разрешено.
   */
  canEditProject?: (c: Context, project: Project, userId: string) => boolean | Promise<boolean>;
  /** userId текущего запроса (core — `local`, backend — id из AuthKit). */
  getCurrentUserId?: (c: Context) => string | Promise<string>;
  /**
   * ADR-052: scope-гейт service-key. По умолчанию — `requireScopeOrAdminRole`:
   * установщик пакета (`automation:install`) или роль ADMIN ключа.
   */
  scopeGuard?: ScopeGuardFactory;
  /**
   * ADR-052: проектная проекция service-key (`allowedProjects`). По умолчанию —
   * `checkServiceProjectProjection`.
   */
  serviceProjectProjection?: ServiceProjectProjectionGuard;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<PipelineProjectRouteMessages>;
}

/** Ключ контекста: проект, разрезолвленный граничным guard'ом. */
const PIPELINE_PROJECT_KEY = 'pipelineProject';
/** Ключ контекста: прогон, разрезолвленный граничным guard'ом. */
const PIPELINE_RUN_KEY = 'pipelineRun';

/** Проект, разрезолвленный граничным guard'ом (ADR-089, инвариант 16). */
interface GuardedProject {
  projectId: string;
  project: Project;
}

/** Префикс id пайплайна проекта (`pl_<uuid>`). */
const PIPELINE_ID_PREFIX = 'pl_';
/** Потолок ожидания заголовка прогона в порту (мс). */
const RUN_RECORD_WAIT_MS = 5000;
/** Шаг опроса порта прогонов при поиске заголовка (мс). */
const RUN_RECORD_POLL_MS = 5;

// ────────────────────────────── Схемы тел ──────────────────────────────

/**
 * Тело создания/правки пайплайна: спецификация целиком.
 *
 * Сервер управляет полями `id`/`version`/`status`/`projectId` — они
 * необязательны в теле и перезаписываются на стороне сервера (иначе клиент
 * мог бы сослаться на чужой проект или выдать «свою» версию).
 */
const pipelineBodySchema = z.object({
  /** Имя пайплайна (по умолчанию — `spec.name`). */
  name: z.string().min(1).optional(),
  /** Описание пайплайна. */
  description: z.string().optional(),
  /** Спецификация пайплайна (ADR-101, `PipelineSpec`). */
  spec: pipelineSpecSchema.partial({ id: true, version: true, status: true, projectId: true }),
});

/** Тело запуска прогона. */
const runBodySchema = z.object({
  /** Триггер прогона (по умолчанию — `manual`). */
  trigger: pipelineRunTriggerSchema.optional(),
  /** Версия спецификации (по умолчанию — последняя опубликованная). */
  version: z.number().int().min(1).optional(),
});

/** Тело HITL-действия (возобновление прогона). */
const resumeBodySchema = z.object({
  /** Одобрение (`true`) или отклонение (`false`). */
  approved: z.boolean(),
  /** Данные, передаваемые шагу дальше. */
  output: z.record(z.string(), z.unknown()).optional(),
  /** Комментарий человека (пишется в журнал прогона). */
  comment: z.string().optional(),
});

/** Тело инстанцирования шаблона в проект. */
const instantiateBodySchema = z.object({
  /** Проект-владелец нового пайплайна. */
  projectId: z.string().min(1),
  /** Имя нового пайплайна (по умолчанию — имя шаблона). */
  name: z.string().min(1).optional(),
});

// ────────────────────────────── Утилиты ──────────────────────────────

/** Каноничный JSON (ключи отсортированы) — для сравнения спецификаций. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Сравнение спецификаций **по содержанию**: `version`/`status` игнорируются
 * (черновик и опубликованная версия отличаются ими по построению).
 */
function sameSpecContent(a: PipelineSpec, b: PipelineSpec): boolean {
  const strip = (spec: PipelineSpec): unknown => ({ ...spec, version: 0, status: 'draft' });
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

/**
 * Спецификация из тела запроса: серверные поля (`id`/`version`/`status`/
 * `projectId`) необязательны — их проставляет сервер.
 */
type PipelineSpecInput = Omit<PipelineSpec, 'id' | 'version' | 'status' | 'projectId'> &
  Partial<Pick<PipelineSpec, 'id' | 'version' | 'status' | 'projectId'>>;

/** Черновик с серверными полями (`id`/`version`/`status`/`projectId`). */
function toDraftSpec(
  spec: PipelineSpecInput,
  ctx: { pipelineId: string; projectId: string; version: number },
): PipelineSpec {
  return {
    ...spec,
    id: ctx.pipelineId,
    version: ctx.version,
    status: 'draft',
    projectId: ctx.projectId,
  };
}

/** Пауза (мс) — вспомогательная для опроса порта прогонов. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Конвертация legacy-определения ADR-100 (`PipelineDefinition`) в спецификацию
 * движка ADR-101 (`PipelineSpec`) — **best-effort**, без миграции данных.
 *
 * Правила (задокументированы в `docs/PIPELINES.md` §2.11):
 * - шаг вида `agent` → узел вида `agent` (`agent`/`skill`/`prompt`/`timeoutSec`
 *   переносятся как есть);
 * - шаг вида `loop` **не конвертируется** (Loop Engine вне объёма, PROP-057) —
 *   шаблон с такими шагами не инстанцируется (409 со списком проблем);
 * - шаг без `agent` — не конвертируется (узел движка вида `agent` требует агента);
 * - `waitsFor` (событие-триггер/гейт автомата ADR-100) **не переносится**: в
 *   ADR-101 триггер задаётся при запуске прогона, а HITL-гейт выражается узлом
 *   вида `human` — его добавляет владелец пайплайна в черновике;
 * - выход пайплайна — `none` (выход ADR-101 задаётся вручную).
 */
export function legacyDefinitionToPipelineSpec(
  definition: PipelineDefinitionRecord,
  ctx: { pipelineId: string; projectId: string },
): { ok: true; spec: PipelineSpec } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const nodes: PipelineNode[] = [];

  definition.steps.forEach((step, index) => {
    if (step.kind === 'loop') {
      problems.push(
        `steps[${index}] («${step.id}»): шаг вида «loop» не поддерживается движком (PROP-057)`,
      );
      return;
    }
    if (!step.agent?.trim()) {
      problems.push(
        `steps[${index}] («${step.id}»): шаг без поля «agent» — узел движка вида «agent» требует агента`,
      );
      return;
    }
    nodes.push({
      id: step.id,
      kind: 'agent',
      ...(step.title ? { title: step.title } : {}),
      agent: step.agent,
      ...(step.skill ? { skill: step.skill } : {}),
      ...(step.prompt ? { prompt: step.prompt } : {}),
      ...(step.timeoutSec !== undefined ? { timeoutSec: step.timeoutSec } : {}),
    });
  });

  if (problems.length > 0) return { ok: false, problems };
  if (nodes.length === 0) {
    return { ok: false, problems: ['steps: у шаблона нет шагов, конвертируемых в узлы движка'] };
  }

  const spec: PipelineSpec = {
    id: ctx.pipelineId,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    version: 1,
    status: 'draft',
    mode: 'act',
    projectId: ctx.projectId,
    nodes,
    exits: [{ kind: 'none' }],
  };

  const validation = validatePipelineSpec(spec);
  if (!validation.ok) return { ok: false, problems: validation.problems };
  return { ok: true, spec };
}

// ────────────────────────────── Фабрика ──────────────────────────────

export function createPipelineProjectRoutes(
  auth: PipelineProjectRoutesAuth,
  deps: PipelineProjectRoutesDeps,
  opts: PipelineProjectRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: PipelineProjectRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const adminGuard: Middleware = opts.adminGuard ?? auth.requireAuth;
  // ADR-052: зонтичный `automation:install` — установщик пакета расширений
  // (пайплайны — его зона); роль ADMIN ключа — тоже (паритет с legacy-роутом).
  const scoped = opts.scopeGuard ?? requireScopeOrAdminRole;
  const serviceProjectProjection =
    opts.serviceProjectProjection ?? checkServiceProjectProjection;

  /** userId запроса (core — `local`, backend — id пользователя). */
  const currentUserId = async (c: Context): Promise<string> =>
    opts.getCurrentUserId ? await opts.getCurrentUserId(c) : 'local';

  /**
   * Активные прогоны **этого процесса**: `runId` → контроллер отмены и промис
   * движка. Нужен для отмены идущего прогона (ADR-101 §2.9): отмена идёт
   * через `AbortController`, который передан движку.
   */
  const activeRuns = new Map<
    string,
    { controller: AbortController; promise: Promise<PipelineRunRecord> }
  >();

  /**
   * Дождаться заголовка прогона в порту: движок сохраняет его **до** первого
   * шага, поэтому заголовок появляется сразу, а сам прогон идёт в фоне.
   */
  const awaitRunRecord = async (
    before: Set<string>,
    pipelineId: string,
    promise: Promise<PipelineRunRecord>,
  ): Promise<PipelineRunRecord> => {
    let settled: PipelineRunRecord | undefined;
    let failure: unknown;
    promise.then(
      (record) => {
        settled = record;
      },
      (err) => {
        failure = err;
      },
    );

    const deadline = Date.now() + RUN_RECORD_WAIT_MS;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (settled) return settled;
      let runs: PipelineRunRecord[] = [];
      try {
        runs = await deps.runs.listRuns({ pipelineId, limit: 100 });
      } catch {
        runs = [];
      }
      const fresh = runs.find((run) => !before.has(run.id));
      if (fresh) return fresh;
      await delay(RUN_RECORD_POLL_MS);
    }
    if (failure) throw failure;
    if (settled) return settled;
    throw new Error('прогон пайплайна не стартовал');
  };

  const canRead = async (c: Context, project: Project, userId: string): Promise<boolean> =>
    opts.canReadProject ? await opts.canReadProject(c, project, userId) : true;

  const canEdit = async (c: Context, project: Project, userId: string): Promise<boolean> =>
    opts.canEditProject ? await opts.canEditProject(c, project, userId) : true;

  /** Единый ответ об отказе в доступе (fail-closed). */
  const forbidden = (c: Context) =>
    c.json({ error: { code: 'FORBIDDEN', message: messages.forbidden(c) } }, 403);

  /** 400 со списком проблем (структурная ошибка Zod или семантика графа). */
  const invalid = (c: Context, problems: string[], message?: string) =>
    c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: message ?? messages.invalidSpec(c),
          problems,
        },
      },
      400,
    );

  const notFoundPipeline = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.pipelineNotFound(c) } }, 404);

  const notFoundRun = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.runNotFound(c) } }, 404);

  /**
   * ГРАНИЧНАЯ проверка доступа к проекту (инвариант 16): guard резолвит проект
   * ОДИН раз и кладёт его в контекст; обработчики берут id ТОЛЬКО отсюда.
   *
   * `read` — чтение пайплайнов/прогонов (право чтения проекта);
   * `write` — создание/правка/публикация/удаление/запуск/HITL (право изменения
   * содержимого проекта, ADR-089 §5.8, инвариант 21: `VIEWER` не мутирует).
   */
  const projectGuard = (kind: 'read' | 'write'): Middleware =>
    createMiddleware(async (c, next) => {
      const projectId = c.req.param('id');
      const project = projectId ? await deps.projects.load(projectId) : null;
      if (!project) {
        return c.json({ error: { code: 'NOT_FOUND', message: messages.projectNotFound(c) } }, 404);
      }
      const userId = await currentUserId(c);
      const allowed =
        kind === 'read'
          ? await canRead(c, project, userId)
          : await canEdit(c, project, userId);
      if (!allowed) return forbidden(c);
      c.set(PIPELINE_PROJECT_KEY as never, { projectId: project.id, project } as never);
      await next();
    });

  /**
   * ГРАНИЧНАЯ проверка доступа к прогону: прогон принадлежит проекту, поэтому
   * права — по правилам проекта (ADR-089). Прогон без проекта — инстансный
   * ресурс: доступ закрыт (fail-closed).
   */
  const runGuard = (kind: 'read' | 'write'): Middleware =>
    createMiddleware(async (c, next) => {
      const runId = c.req.param('runId');
      const run = runId ? await deps.runs.getRun(runId) : null;
      if (!run) return notFoundRun(c);
      if (!run.projectId) return forbidden(c);
      const project = await deps.projects.load(run.projectId);
      if (!project) {
        return c.json({ error: { code: 'NOT_FOUND', message: messages.projectNotFound(c) } }, 404);
      }
      const userId = await currentUserId(c);
      const allowed =
        kind === 'read'
          ? await canRead(c, project, userId)
          : await canEdit(c, project, userId);
      if (!allowed) return forbidden(c);
      c.set(PIPELINE_RUN_KEY as never, run as never);
      await next();
    });

  /** Проект из контекста guard'а (единственный источник id — инвариант 16). */
  const guardedProject = (c: Context): GuardedProject =>
    c.get(PIPELINE_PROJECT_KEY as never) as GuardedProject;

  /** Прогон из контекста guard'а. */
  const guardedRun = (c: Context): PipelineRunRecord =>
    c.get(PIPELINE_RUN_KEY as never) as PipelineRunRecord;

  /** Ответ движка → HTTP (коды ошибок ADR-101, `PIPELINE_ERROR_CODES`). */
  const engineError = (c: Context, err: unknown): Response | undefined => {
    if (!(err instanceof PipelineEngineError)) return undefined;
    switch (err.code) {
      case 'pipeline.not_found':
        return notFoundPipeline(c);
      case 'pipeline.run_not_found':
        return notFoundRun(c);
      case 'pipeline.not_published':
        return c.json({ error: { code: err.code, message: messages.notPublished(c) } }, 409);
      case 'pipeline.invalid_state':
        return c.json({ error: { code: err.code, message: messages.invalidState(c) } }, 409);
      case 'pipeline.invalid_spec':
        return invalid(c, [err.message], messages.invalidSpec(c));
      default:
        return undefined;
    }
  };

  /** Пайплайн проекта по id (404, если чужой или удалён). */
  const loadProjectPipeline = async (
    c: Context,
    projectId: string,
    pipelineId: string,
  ): Promise<PipelineRecord | null> => {
    const record = await deps.pipelines.getPipeline(pipelineId);
    if (!record || record.scope !== 'project' || record.projectId !== projectId) return null;
    return record;
  };

  /** Краткое представление пайплайна (список). */
  const pipelineSummary = (record: PipelineRecord) => ({
    id: record.id,
    name: record.name,
    description: record.description,
    icon: record.icon,
    scope: record.scope,
    projectId: record.projectId,
    draftVersion: record.draftVersion,
    publishedVersion: record.publishedVersion,
    hasDraft: record.draft !== undefined,
    installedBy: record.installedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

  // ─────────────── Шаблоны инстанса (ADR-100 → шаблоны ADR-101) ───────────────

  /**
   * Шаблон инстанса: запись `scope:'instance'` (новый формат) либо legacy-определение
   * ADR-100 (его наполняет установщик пакета расширения).
   */
  type Template =
    | { format: 'adr-101'; record: PipelineRecord }
    | { format: 'adr-100'; definition: PipelineDefinitionRecord };

  /** Найти шаблон по id (сначала новый формат, затем legacy-реестр). */
  const resolveTemplate = async (id: string): Promise<Template | null> => {
    const instance = await deps.pipelines.getPipeline(id);
    if (instance && instance.scope === 'instance') return { format: 'adr-101', record: instance };
    const legacy = await deps.templates?.getDefinition(id);
    if (legacy) return { format: 'adr-100', definition: legacy };
    return null;
  };

  /** Публичное представление шаблона. */
  const templateView = (template: Template) => {
    if (template.format === 'adr-101') {
      return {
        id: template.record.id,
        name: template.record.name,
        description: template.record.description,
        format: 'adr-101' as const,
        version: template.record.draft?.version,
        installedBy: template.record.installedBy,
        spec: template.record.draft,
      };
    }
    return {
      id: template.definition.id,
      name: template.definition.name,
      description: template.definition.description,
      format: 'adr-100' as const,
      version: template.definition.version,
      installedBy: template.definition.installedBy,
      steps: template.definition.steps,
    };
  };

  // ─────────────── Пайплайны проекта ───────────────

  // GET /api/v2/projects/:id/pipelines — пайплайны проекта.
  app.get(
    '/projects/:id/pipelines',
    auth.requireAuth,
    projectGuard('read'),
    async (c) => {
      const { projectId } = guardedProject(c);
      const records = await deps.pipelines.listPipelines({ scope: 'project', projectId });
      return c.json({
        pipelines: records.map((record) => ({
          ...pipelineSummary(record),
          draft: record.draft,
        })),
      });
    },
  );

  // POST /api/v2/projects/:id/pipelines — создать пайплайн проекта (черновик).
  app.post(
    '/projects/:id/pipelines',
    auth.requireAuth,
    writeGuard,
    scoped('automation:install'),
    projectGuard('write'),
    async (c) => {
      const { projectId } = guardedProject(c);
      const denied = serviceProjectProjection(c, projectId);
      if (denied) return denied;

      const body = await c.req.json().catch(() => ({}));
      const parsed = pipelineBodySchema.safeParse(body);
      if (!parsed.success) {
        return invalid(
          c,
          parsed.error.issues.map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`),
          messages.invalidBody(c),
        );
      }

      const pipelineId = `${PIPELINE_ID_PREFIX}${generateId()}`;
      const spec = toDraftSpec(parsed.data.spec, { pipelineId, projectId, version: 1 });
      const validation = validatePipelineSpec(spec);
      if (!validation.ok) return invalid(c, validation.problems);

      const now = nowISO();
      const record: PipelineRecord = {
        id: pipelineId,
        scope: 'project',
        projectId,
        name: parsed.data.name ?? spec.name,
        ...(parsed.data.description ?? spec.description
          ? { description: parsed.data.description ?? spec.description }
          : {}),
        draft: spec,
        draftVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      await deps.pipelines.savePipeline(record);
      return c.json({ pipeline: record }, 201);
    },
  );

  // GET /api/v2/projects/:id/pipelines/:pid — деталь пайплайна.
  app.get(
    '/projects/:id/pipelines/:pid',
    auth.requireAuth,
    projectGuard('read'),
    async (c) => {
      const { projectId } = guardedProject(c);
      const record = await loadProjectPipeline(c, projectId, c.req.param('pid'));
      if (!record) return notFoundPipeline(c);
      const published = record.publishedVersion
        ? await deps.pipelines.getVersion(record.id, record.publishedVersion)
        : null;
      const versions = await deps.pipelines.listVersions(record.id);
      return c.json({
        pipeline: { ...pipelineSummary(record), draft: record.draft },
        published,
        versions,
      });
    },
  );

  // PUT /api/v2/projects/:id/pipelines/:pid — сохранить черновик (версия не bump'ается).
  app.put(
    '/projects/:id/pipelines/:pid',
    auth.requireAuth,
    writeGuard,
    scoped('automation:install'),
    projectGuard('write'),
    async (c) => {
      const { projectId } = guardedProject(c);
      const denied = serviceProjectProjection(c, projectId);
      if (denied) return denied;

      const record = await loadProjectPipeline(c, projectId, c.req.param('pid'));
      if (!record) return notFoundPipeline(c);

      const body = await c.req.json().catch(() => ({}));
      const parsed = pipelineBodySchema.safeParse(body);
      if (!parsed.success) {
        return invalid(
          c,
          parsed.error.issues.map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`),
          messages.invalidBody(c),
        );
      }

      const spec = toDraftSpec(parsed.data.spec, {
        pipelineId: record.id,
        projectId,
        version: record.draftVersion,
      });
      const validation = validatePipelineSpec(spec);
      if (!validation.ok) return invalid(c, validation.problems);

      const updated: PipelineRecord = {
        ...record,
        name: parsed.data.name ?? spec.name,
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description }
          : {}),
        draft: spec,
        updatedAt: nowISO(),
      };
      await deps.pipelines.savePipeline(updated);
      return c.json({ pipeline: updated });
    },
  );

  // DELETE /api/v2/projects/:id/pipelines/:pid — удалить пайплайн (прогоны остаются).
  app.delete(
    '/projects/:id/pipelines/:pid',
    auth.requireAuth,
    writeGuard,
    scoped('automation:install'),
    projectGuard('write'),
    async (c) => {
      const { projectId } = guardedProject(c);
      const denied = serviceProjectProjection(c, projectId);
      if (denied) return denied;

      const record = await loadProjectPipeline(c, projectId, c.req.param('pid'));
      if (!record) return notFoundPipeline(c);
      await deps.pipelines.deletePipeline(record.id);
      return c.body(null, 204);
    },
  );

  // POST /api/v2/projects/:id/pipelines/:pid/publish — опубликовать версию.
  app.post(
    '/projects/:id/pipelines/:pid/publish',
    auth.requireAuth,
    writeGuard,
    scoped('automation:install'),
    projectGuard('write'),
    async (c) => {
      const { projectId } = guardedProject(c);
      const denied = serviceProjectProjection(c, projectId);
      if (denied) return denied;

      const record = await loadProjectPipeline(c, projectId, c.req.param('pid'));
      if (!record) return notFoundPipeline(c);
      if (!record.draft) {
        return c.json(
          { error: { code: 'CONFLICT', message: messages.nothingToPublish(c) } },
          409,
        );
      }

      // Повторная публикация без изменений — идемпотентный ответ: версии не плодим.
      const lastPublished = record.publishedVersion
        ? await deps.pipelines.getVersion(record.id, record.publishedVersion)
        : null;
      if (lastPublished && sameSpecContent(lastPublished.spec, record.draft)) {
        return c.json({
          pipeline: { ...pipelineSummary(record), draft: record.draft },
          published: lastPublished,
        });
      }

      const version = record.draftVersion;
      const publishedBy = await currentUserId(c);
      const publishedSpec: PipelineSpec = {
        ...record.draft,
        version,
        status: 'published',
      };
      const versionRecord: PipelineVersionRecord = {
        pipelineId: record.id,
        version,
        spec: publishedSpec,
        publishedAt: nowISO(),
        publishedBy,
      };
      await deps.pipelines.saveVersion(versionRecord);

      const nextVersion = version + 1;
      const updated: PipelineRecord = {
        ...record,
        draftVersion: nextVersion,
        publishedVersion: version,
        draft: { ...record.draft, version: nextVersion, status: 'draft' },
        updatedAt: nowISO(),
      };
      await deps.pipelines.savePipeline(updated);
      return c.json({
        pipeline: { ...pipelineSummary(updated), draft: updated.draft },
        published: versionRecord,
      });
    },
  );

  // ─────────────── Прогоны ───────────────

  // GET /api/v2/projects/:id/pipelines/:pid/runs — прогоны пайплайна.
  app.get(
    '/projects/:id/pipelines/:pid/runs',
    auth.requireAuth,
    projectGuard('read'),
    async (c) => {
      const { projectId } = guardedProject(c);
      const record = await loadProjectPipeline(c, projectId, c.req.param('pid'));
      if (!record) return notFoundPipeline(c);

      const rawStatus = c.req.query('status');
      let status: PipelineRunStatus | undefined;
      if (rawStatus !== undefined && rawStatus.trim() !== '') {
        const parsed = pipelineRunStatusSchema.safeParse(rawStatus.trim());
        if (!parsed.success) {
          return invalid(c, [`status: неизвестный статус прогона «${rawStatus}»`], messages.invalidBody(c));
        }
        status = parsed.data;
      }
      const rawLimit = c.req.query('limit');
      const parsedLimit = rawLimit === undefined ? Number.NaN : Number.parseInt(rawLimit, 10);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 100;

      const runs = await deps.runs.listRuns({
        pipelineId: record.id,
        ...(status ? { status } : {}),
        limit,
      });
      return c.json({ runs });
    },
  );

  /**
   * POST /api/v2/projects/:id/pipelines/:pid/runs — запуск прогона.
   *
   * Прогон идёт **в фоне**: ответ — заголовок прогона (201). Клиент следит за
   * прогрессом по событиям `pipeline.run.*` (ADR-101 §2.12) и может отменить
   * прогон через `POST /api/v2/pipeline-runs/:runId/cancel`.
   */
  app.post(
    '/projects/:id/pipelines/:pid/runs',
    auth.requireAuth,
    writeGuard,
    scoped('automation:install'),
    projectGuard('write'),
    async (c) => {
      const { projectId } = guardedProject(c);
      const denied = serviceProjectProjection(c, projectId);
      if (denied) return denied;

      const record = await loadProjectPipeline(c, projectId, c.req.param('pid'));
      if (!record) return notFoundPipeline(c);

      const body = await c.req.json().catch(() => ({}));
      const parsed = runBodySchema.safeParse(body);
      if (!parsed.success) {
        return invalid(
          c,
          parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
          messages.invalidBody(c),
        );
      }

      // Опубликованной версии нет — запускать нечего (409).
      const version = parsed.data.version ?? record.publishedVersion;
      if (version === undefined) {
        return c.json(
          { error: { code: 'pipeline.not_published', message: messages.notPublished(c) } },
          409,
        );
      }
      if (!(await deps.pipelines.getVersion(record.id, version))) {
        return c.json(
          { error: { code: 'pipeline.not_published', message: messages.notPublished(c) } },
          409,
        );
      }

      const trigger: PipelineRunTrigger = parsed.data.trigger ?? { kind: 'manual' };
      const before = new Set(
        (await deps.runs.listRuns({ pipelineId: record.id, limit: 1000 })).map((run) => run.id),
      );

      const controller = new AbortController();
      const promise = deps.engine.run({
        pipelineId: record.id,
        version,
        trigger,
        projectId,
        signal: controller.signal,
      });
      // Ошибка прогона не должна вешать процесс: она попадёт в ответ/журнал.
      promise.catch(() => undefined);

      try {
        const run = await awaitRunRecord(before, record.id, promise);
        activeRuns.set(run.id, { controller, promise });
        promise.then(
          () => activeRuns.delete(run.id),
          () => activeRuns.delete(run.id),
        );
        return c.json({ run }, 201);
      } catch (err) {
        const mapped = engineError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  // GET /api/v2/pipeline-runs/:runId — прогон + журнал.
  app.get('/pipeline-runs/:runId', auth.requireAuth, runGuard('read'), async (c) => {
    const run = guardedRun(c);
    const rawLimit = c.req.query('limit');
    const parsedLimit = rawLimit === undefined ? Number.NaN : Number.parseInt(rawLimit, 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    const events = await deps.runs.listEvents(run.id, { limit });
    return c.json({ run, events });
  });

  // POST /api/v2/pipeline-runs/:runId/resume — HITL-действие человека.
  app.post(
    '/pipeline-runs/:runId/resume',
    auth.requireAuth,
    writeGuard,
    scoped('automation:install'),
    runGuard('write'),
    async (c) => {
      const run = guardedRun(c);
      const body = await c.req.json().catch(() => ({}));
      const parsed = resumeBodySchema.safeParse(body);
      if (!parsed.success) {
        return invalid(
          c,
          parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
          messages.invalidBody(c),
        );
      }
      try {
        const updated = await deps.engine.resume(run.id, {
          approved: parsed.data.approved,
          ...(parsed.data.output ? { output: parsed.data.output } : {}),
          ...(parsed.data.comment ? { comment: parsed.data.comment } : {}),
        });
        return c.json({ run: updated });
      } catch (err) {
        const mapped = engineError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  // POST /api/v2/pipeline-runs/:runId/cancel — отмена прогона.
  app.post(
    '/pipeline-runs/:runId/cancel',
    auth.requireAuth,
    writeGuard,
    scoped('automation:install'),
    runGuard('write'),
    async (c) => {
      const run = guardedRun(c);
      const active = activeRuns.get(run.id);
      if (active) {
        // Идущий в этом процессе прогон — отменяем через AbortController.
        active.controller.abort();
        const final = await active.promise.catch(() => run);
        return c.json({ run: final });
      }
      if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
        return c.json(
          { error: { code: 'CONFLICT', message: messages.runFinished(c) } },
          409,
        );
      }
      // Прогон на паузе (HITL) или запущенный в другом процессе — помечаем
      // отменённым в порту и фиксируем событие в журнале прогона.
      const now = nowISO();
      const cancelled: PipelineRunRecord = {
        ...run,
        status: 'cancelled',
        finishedAt: now,
        updatedAt: now,
        error: 'pipeline.cancelled',
      };
      await deps.runs.saveRun(cancelled);
      await deps.runs.appendEvent({
        runId: run.id,
        ts: now,
        type: 'run.failed',
        payload: { code: 'pipeline.cancelled' },
      });
      return c.json({ run: cancelled });
    },
  );

  // ─────────────── Шаблоны инстанса ───────────────

  // GET /api/v2/pipeline-templates — шаблоны инстанса.
  app.get('/pipeline-templates', auth.requireAuth, adminGuard, async (c) => {
    const instanceTemplates = await deps.pipelines.listPipelines({ scope: 'instance' });
    const legacyDefinitions = (await deps.templates?.listDefinitions()) ?? [];
    const templates = [
      ...instanceTemplates.map((record) =>
        templateView({ format: 'adr-101', record }),
      ),
      ...legacyDefinitions.map((definition) => templateView({ format: 'adr-100', definition })),
    ];
    return c.json({ templates });
  });

  // POST /api/v2/pipeline-templates/:tid/instantiate — создать пайплайн проекта.
  app.post('/pipeline-templates/:tid/instantiate', auth.requireAuth, adminGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = instantiateBodySchema.safeParse(body);
    if (!parsed.success) {
      return invalid(
        c,
        parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
        messages.invalidBody(c),
      );
    }
    const projectId = parsed.data.projectId;

    // Право на изменение содержимого проекта (инвариант 21): инстанцирование
    // создаёт пайплайн проекта — это мутация содержимого.
    const project = await deps.projects.load(projectId);
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.projectNotFound(c) } }, 404);
    }
    const denied = serviceProjectProjection(c, projectId);
    if (denied) return denied;
    const userId = await currentUserId(c);
    if (!(await canEdit(c, project, userId))) return forbidden(c);

    const template = await resolveTemplate(c.req.param('tid'));
    if (!template) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: messages.templateNotFound(c) } },
        404,
      );
    }

    const pipelineId = `${PIPELINE_ID_PREFIX}${generateId()}`;
    const built =
      template.format === 'adr-101'
        ? buildFromInstanceTemplate(template.record, { pipelineId, projectId })
        : legacyDefinitionToPipelineSpec(template.definition, { pipelineId, projectId });
    if (!built.ok) {
      return c.json(
        {
          error: {
            code: 'PIPELINE_TEMPLATE_UNSUPPORTED',
            message: messages.templateNotInstantiable(c),
            problems: built.problems,
          },
        },
        409,
      );
    }

    const now = nowISO();
    const record: PipelineRecord = {
      id: pipelineId,
      scope: 'project',
      projectId,
      name: parsed.data.name ?? built.spec.name,
      ...(built.spec.description ? { description: built.spec.description } : {}),
      draft: built.spec,
      draftVersion: 1,
      ...(installedByOf(template) ? { installedBy: installedByOf(template)! } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await deps.pipelines.savePipeline(record);
    return c.json({ pipeline: record }, 201);
  });

  return app;
}

/**
 * Провенанс шаблона (пакет/версия) — если известен.
 */
function installedByOf(template: {
  format: 'adr-101' | 'adr-100';
  record?: PipelineRecord;
  definition?: PipelineDefinitionRecord;
}): { pack: string; version: string } | undefined {
  return template.format === 'adr-101' ? template.record?.installedBy : template.definition?.installedBy;
}

/**
 * Черновик из шаблона инстанса нового формата (`scope:'instance'`): копия
 * спецификации с серверными полями (id/версия/проект).
 */
function buildFromInstanceTemplate(
  record: PipelineRecord,
  ctx: { pipelineId: string; projectId: string },
): { ok: true; spec: PipelineSpec } | { ok: false; problems: string[] } {
  if (!record.draft) {
    return { ok: false, problems: ['template: у шаблона нет спецификации'] };
  }
  const spec = toDraftSpec(record.draft, { pipelineId: ctx.pipelineId, projectId: ctx.projectId, version: 1 });
  const validation = validatePipelineSpec(spec);
  if (!validation.ok) return { ok: false, problems: validation.problems };
  return { ok: true, spec };
}
