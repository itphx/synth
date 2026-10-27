import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import {
  nowISO,
  pipelineSpecSchema,
  pipelineRunStatusSchema,
  pipelineRunTriggerSchema,
  eventAttachmentRefSchema,
} from '@itphx/synth-shared';
import type {
  EventAttachmentRef,
  PipelineArtifact,
  PipelineRunStatus,
  PipelineRunTrigger,
  Project,
} from '@itphx/synth-shared';
import type {
  PipelineRecord,
  PipelineRunEventRecord,
  PipelineRunRecord,
  PipelineRunRepository,
  ProjectPipelineRepository,
} from '../../storage/ports/index.js';
import type { PipelineRepository } from '../../storage/ports/pipeline-repository.js';
import type { PipelineArtifactStore } from '../../engine/pipelines/artifacts.js';
import type { AttachmentService } from '../../engine/attachments/service.js';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import {
  PipelineAttachmentError,
  validatePipelineAttachments,
} from '../../engine/pipelines/attachments.js';
import type { ProjectRepository } from '../../storage/ports/project-repository.js';
import { PipelineEngineError } from '../../engine/pipelines/index.js';
import type { PipelineEngine } from '../../engine/pipelines/index.js';
import {
  PipelineAuthoringError,
  createPipelineDraft,
  deletePipeline as deletePipelineRecord,
  instantiatePipelineFromTemplate,
  listPipelineTemplates,
  publishPipeline,
  updatePipelineDraft,
} from '../../engine/pipelines/authoring.js';
import { PipelineRunControl } from '../../engine/pipelines/run-control.js';
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
  /** Артефакт прогона не найден (404). */
  artifactNotFound: (c: Context) => string;
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
  /** По пайплайну уже идёт прогон — второй не запускается (409). */
  alreadyRunning: (c: Context) => string;
  /** Шаблон нельзя инстанцировать в пайплайн движка (409). */
  templateNotInstantiable: (c: Context) => string;
  /** Не указан проект (400). */
  projectIdRequired: (c: Context) => string;
}

const DEFAULT_MESSAGES: PipelineProjectRouteMessages = {
  pipelineNotFound: () => 'Пайплайн не найден',
  runNotFound: () => 'Прогон не найден',
  artifactNotFound: () => 'Артефакт прогона не найден',
  projectNotFound: () => 'Проект не найден',
  templateNotFound: () => 'Шаблон пайплайна не найден',
  forbidden: () => 'Доступ запрещён',
  invalidBody: () => 'Некорректное тело запроса',
  invalidSpec: () => 'Спецификация пайплайна некорректна',
  notPublished: () => 'У пайплайна нет опубликованной версии',
  invalidState: () => 'Прогон не ожидает решения человека',
  nothingToPublish: () => 'Нет черновика для публикации',
  runFinished: () => 'Прогон уже завершён',
  alreadyRunning: () => 'По этому пайплайну уже идёт прогон',
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
  /**
   * Реестр активных прогонов (ADR-101, `run-control.ts`).
   *
   * Не задан — создаётся локальный экземпляр (тогда soft-lock не делится с
   * встроенными тулами агента; в инстансе всегда передаётся общий).
   */
  runControl?: PipelineRunControl;
  /**
   * Хранилище артефактов прогонов (ADR-101 §9, ADR-116) — раздача байтов
   * (`GET /pipeline-runs/:runId/artifacts/:name`). Не задано — артефактов нет
   * (404), остальной контур пайплайнов работает как прежде.
   */
  artifacts?: PipelineArtifactStore;
  /**
   * ADR-115 × ADR-101: сервис вложений — проверка ссылок `attachments[]` в
   * теле запуска прогона (объект существует, метаданные совпадают со sidecar)
   * и источник лимитов (`attachments.maxFilesPerMessage`/`maxBytesPerFile`/
   * `maxBytesPerSession`).
   *
   * Не задан — прогоны с вложениями отклоняются (400 `VALIDATION_ERROR`):
   * без сверки со sidecar в прогон можно подставить чужой/изменённый объект.
   */
  attachments?: AttachmentService;
  /**
   * ADR-115 × ADR-116: порт учёта blob-ссылок — вложения прогона
   * регистрируются владельцем `pipeline-run` (иначе GC удалил бы объект,
   * хотя прогон на него ссылается). Не задан — прогоны с вложениями
   * отклоняются (fail-closed).
   */
  blobRefs?: BlobRefRepository;
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

/**
 * Конвертация legacy-определения ADR-100 в спецификацию движка ADR-101.
 *
 * Реализация живёт в движке (`engine/pipelines/authoring.ts`) — её
 * используют и HTTP-роут, и встроенные тулы агента; здесь оставлен
 * ре-экспорт ради публичного API пакета (`@itphx/synth-core`).
 */
export { legacyDefinitionToPipelineSpec } from '../../engine/pipelines/authoring.js';

// ────────────────────────────── Схемы тел ──────────────────────────────
/**
 * Серверные поля спецификации: их проставляет сервер (ADR-101, Э6).
 *
 * Пустая строка в них означает «не задано»: клиент (например, диалог
 * создания) может прислать `id: ''` — сервер всё равно подставит своё
 * значение, поэтому такое тело не должно падать в 400.
 */
const SERVER_MANAGED_SPEC_FIELDS = ['id', 'projectId'] as const;

/**
 * Спецификация тела без пустых серверных полей: `id`/`projectId` с пустой
 * строкой — «не задано» (остальные поля валидируются строго).
 */
function withoutEmptyServerFields(spec: unknown): unknown {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const source = spec as Record<string, unknown>;
  const cleaned: Record<string, unknown> = { ...source };
  for (const field of SERVER_MANAGED_SPEC_FIELDS) {
    if (cleaned[field] === '') delete cleaned[field];
  }
  return cleaned;
}

/**
 * Схема спецификации в теле: серверные поля (`id`/`version`/`status`/
 * `projectId`) необязательны — их проставляет сервер.
 */
const pipelineSpecBodySchema = pipelineSpecSchema.partial({
  id: true,
  version: true,
  status: true,
  projectId: true,
});

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
  spec: z.preprocess(withoutEmptyServerFields, pipelineSpecBodySchema),
});

/** Тело запуска прогона. */
const runBodySchema = z.object({
  /** Триггер прогона (по умолчанию — `manual`). */
  trigger: pipelineRunTriggerSchema.optional(),
  /** Версия спецификации (по умолчанию — последняя опубликованная). */
  version: z.number().int().min(1).optional(),
  /**
   * ADR-115 × ADR-101: вложения прогона — ссылки на объекты staging-загрузки
   * (`POST /api/v2/attachments`, форма — как у вложения события, ADR-089).
   *
   * Проверяются **до** старта прогона: контур `attachments/`, наличие объекта,
   * совпадение `sha256`/`mime`/`size` со sidecar, лимиты прогона. Жёсткий
   * потолок схемы (50) — только структурный; фактический предел —
   * `attachments.maxFilesPerMessage` (проверяет сервис вложений).
   */
  attachments: z.array(eventAttachmentRefSchema).max(50).optional(),
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
  /**
   * Идемпотентное инстанцирование: если в проекте уже есть пайплайн,
   * инстанцированный из этого шаблона (`installedBy.templateId`), новый не
   * создаётся — возвращается существующий (`200`, `created: false`).
   * Без флага поведение прежнее — всегда создаётся новый пайплайн.
   */
  ensure: z.boolean().optional(),
});

// ────────────────────────────── Утилиты ──────────────────────────────

/**
 * Метаданные артефакта из журнала прогона: `run.finished` → `artifacts[]`
 * (ADR-116). `null` — записи нет (MIME неизвестен).
 */
async function findArtifactMeta(
  runs: PipelineRunRepository,
  runId: string,
  path: string,
): Promise<PipelineArtifact | null> {
  let events: PipelineRunEventRecord[] = [];
  try {
    events = await runs.listEvents(runId, { limit: 1000 });
  } catch {
    return null;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'run.finished') continue;
    const artifacts = event.payload?.artifacts;
    if (!Array.isArray(artifacts)) continue;
    const hit = artifacts.find(
      (item): item is PipelineArtifact =>
        !!item && typeof item === 'object' && (item as PipelineArtifact).path === path,
    );
    if (hit) return hit;
  }
  return null;
}

/** ETag артефакта — хеш пути: путь уникален в пределах прогона и неизменяем. */
function artifactEtag(path: string): string {
  return `"${createHash('sha256').update(path).digest('hex')}"`;
}

/** Совпадает ли `If-None-Match` с ETag (в т.ч. `*` и список через запятую). */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag);
}

/** `Content-Disposition: attachment` с UTF-8-именем (RFC 6266/5987). */
function artifactDisposition(name: string): string {
  const safe = (name || 'artifact').replace(/["\\\r\n]/g, '_');
  const encoded = encodeURIComponent(name || 'artifact');
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

/**
 * ADR-115 × ADR-101: учесть ссылки на вложения прогона (`blob_refs`).
 *
 * Без ссылки GC (`attachments.gcDays`) удалил бы объект, хотя прогон на него
 * ссылается. Best-effort: ошибка учёта не отменяет старт (ссылка —
 * производная), пишется в лог. Возвращает число учтённых ссылок.
 */
async function addRunAttachmentRefs(
  blobRefs: BlobRefRepository | undefined,
  runId: string,
  attachments: readonly EventAttachmentRef[],
  log: (message: string) => void,
): Promise<number> {
  if (!blobRefs || attachments.length === 0 || !runId) return 0;
  let added = 0;
  for (const attachment of attachments) {
    try {
      await blobRefs.add({
        blobPath: attachment.blobPath,
        ownerKind: 'pipeline-run',
        ownerId: runId,
      });
      added += 1;
    } catch (err) {
      log(
        `[pipelines] не удалось учесть ссылку на вложение ${attachment.blobPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return added;
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
   * Реестр активных прогонов **этого процесса** (ADR-101, `run-control.ts`).
   *
   * Общий экземпляр на процесс: его же получают встроенные тулы агента
   * (`engine/tools/pipeline-run.ts`) — поэтому soft-lock «не запустить второй
   * прогон того же пайплайна» работает одинаково для HTTP и для агента.
   * Не передан — создаётся локальный (поведение прежнее).
   */
  const runControl = deps.runControl ?? new PipelineRunControl();

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
      case 'pipeline.already_running':
        return c.json(
          { error: { code: err.code, message: messages.alreadyRunning(c) } },
          409,
        );
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

  // Шаблоны инстанца (ADR-100 → шаблоны ADR-101): логика живёт в движке
  // (`engine/pipelines/authoring.ts`: `listPipelineTemplates`/
  // `instantiatePipelineFromTemplate`) — оттуда же её берут встроенные тулы
  // агента. Здесь — только HTTP-обвязка: права, коды ответов, локализация.

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

      // Создание черновика — общими авторскими операциями движка
      // (`engine/pipelines/authoring.ts`): серверные поля спецификации
      // проставляются там, валидация графа — тоже.
      try {
        const record = await createPipelineDraft({
          pipelines: deps.pipelines,
          projectId,
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
          spec: parsed.data.spec,
        });
        return c.json({ pipeline: record }, 201);
      } catch (err) {
        if (err instanceof PipelineAuthoringError) return invalid(c, err.problems);
        throw err;
      }
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

      // Правка черновика — версия **не** bump'ается (ADR-101 §2.8).
      try {
        const updated = await updatePipelineDraft({
          pipelines: deps.pipelines,
          record,
          spec: parsed.data.spec,
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
        });
        return c.json({ pipeline: updated });
      } catch (err) {
        if (err instanceof PipelineAuthoringError) return invalid(c, err.problems);
        throw err;
      }
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
      await deletePipelineRecord({ pipelines: deps.pipelines, pipelineId: record.id });
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

      // Публикация — общими авторскими операциями движка: идемпотентность
      // (повторная публикация без изменений версии не плодит) и bump черновика
      // живут в одном месте с тулами агента.
      const publishedBy = await currentUserId(c);
      try {
        const result = await publishPipeline({
          pipelines: deps.pipelines,
          record,
          publishedBy,
        });
        return c.json({
          pipeline: { ...pipelineSummary(result.pipeline), draft: result.pipeline.draft },
          published: result.published,
        });
      } catch (err) {
        if (err instanceof PipelineAuthoringError) {
          if (err.code === 'nothing_to_publish') {
            return c.json(
              { error: { code: 'CONFLICT', message: messages.nothingToPublish(c) } },
              409,
            );
          }
          return invalid(c, err.problems);
        }
        throw err;
      }
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

      // ADR-115 × ADR-101: вложения прогона проверяются **до** старта прогона
      // (та же политика, что у приёма события): неверная ссылка не должна
      // дойти ни до движка, ни до журнала.
      let attachments: EventAttachmentRef[] = [];
      try {
        attachments = await validatePipelineAttachments(
          deps.attachments,
          deps.blobRefs,
          parsed.data.attachments,
        );
      } catch (err) {
        if (err instanceof PipelineAttachmentError) {
          return invalid(c, [err.message], messages.invalidBody(c));
        }
        throw err;
      }

      // Запуск — через общий реестр активных прогонов (`run-control.ts`):
      // soft-lock «не запустить второй прогон того же пайплайна» и отмена
      // идущего прогона работают одинаково для HTTP и для встроенных тулов.
      // Вложения — вход прогона (`input`), он ложится **под** `trigger.payload`:
      // путь маппинга `trigger.payload.attachments`, а значения явного payload
      // триггера имеют приоритет.
      try {
        const started = await runControl.startRun({
          engine: deps.engine,
          runs: deps.runs,
          pipelineId: record.id,
          version,
          projectId,
          trigger,
          ...(attachments.length > 0 ? { input: { attachments } } : {}),
        });
        if (attachments.length > 0) {
          // Учёт ссылок владельцем `pipeline-run`: без него GC счёл бы объекты
          // осиротевшими, хотя прогон на них ссылается. Best-effort: прогон уже
          // идёт, ошибка учёта не отменяет его (ссылка — производная).
          await addRunAttachmentRefs(
            deps.blobRefs,
            started.run.id,
            attachments,
            (message) => console.warn(message),
          );
        }
        return c.json({ run: started.run }, 201);
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

  // GET /api/v2/pipeline-runs/:runId/artifacts/:name — байты артефакта прогона.
  //
  // ADR-101 §9 + ADR-116: байты лежат в blob-порте (`artifacts/<runId>/<name>`),
  // отдельного хранилища артефактов нет. Доступ — те же права, что у чтения
  // прогона (`runGuard('read')`: право чтения проекта, ADR-089 §5.5/§5.8);
  // проверок в обработчике нет (инвариант 16).
  app.get('/pipeline-runs/:runId/artifacts/:name', auth.requireAuth, runGuard('read'), async (c) => {
    const run = guardedRun(c);
    const store = deps.artifacts;
    const notFound = () =>
      c.json({ error: { code: 'NOT_FOUND', message: messages.artifactNotFound(c) } }, 404);
    if (!store) return notFound();

    const entry = await store.find(run.id, c.req.param('name'));
    if (!entry) return notFound();

    // MIME и исходное имя — из журнала прогона (`run.finished` → `artifacts[]`):
    // отдельного индекса метаданных артефактов нет — журнал и есть источник.
    const meta = await findArtifactMeta(deps.runs, run.id, entry.path);
    const etag = artifactEtag(entry.path);
    const headers: Record<string, string> = {
      'Content-Type': meta?.mime ?? 'application/octet-stream',
      'Content-Disposition': artifactDisposition(meta?.name ?? entry.name),
      'Content-Length': String(entry.size),
      ETag: etag,
      // Объект неизменяем (уникальный путь прогона), как у вложений (ADR-115).
      'Cache-Control': 'private, max-age=86400',
    };

    if (matchesEtag(c.req.header('if-none-match'), etag)) {
      return c.body(null, 304, headers);
    }

    const stream = await store.readStream({ path: entry.path });
    if (!stream) return notFound();
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers,
    });
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
      // Идущий в этом процессе прогон — отменяем через AbortController
      // (общий реестр активных прогонов, ADR-101 `run-control.ts`).
      const final = await runControl.cancelAndWait(run.id);
      if (final) {
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
    const templates = await listPipelineTemplates({
      pipelines: deps.pipelines,
      ...(deps.templates ? { templates: deps.templates } : {}),
    });
    return c.json({ templates });
  });

  // POST /api/v2/pipeline-templates/:tid/instantiate — создать пайплайн проекта.
  //
  // Провенанс записи несёт `installedBy.templateId` (id шаблона-источника),
  // поэтому повторный вызов с `ensure: true` находит уже созданный пайплайн и
  // возвращает его (`200 {pipeline, created:false}`) вместо копии. Без `ensure`
  // поведение прежнее: каждый вызов создаёт новый пайплайн (`201`).
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

    // Инстанцирование — общими операциями движка
    // (`instantiatePipelineFromTemplate`): поиск шаблона в двух источниках,
    // идемпотентность (`ensure`), конвертация legacy-определения и провенанс
    // `installedBy.templateId` — те же правила, что у встроенных тулов агента.
    const result = await instantiatePipelineFromTemplate({
      pipelines: deps.pipelines,
      ...(deps.templates ? { templates: deps.templates } : {}),
      templateId: c.req.param('tid'),
      projectId,
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.ensure !== undefined ? { ensure: parsed.data.ensure } : {}),
    });
    if (!result.ok) {
      if (result.reason === 'template_not_found') {
        return c.json(
          { error: { code: 'NOT_FOUND', message: messages.templateNotFound(c) } },
          404,
        );
      }
      return c.json(
        {
          error: {
            code: 'PIPELINE_TEMPLATE_UNSUPPORTED',
            message: messages.templateNotInstantiable(c),
            problems: result.problems ?? [],
          },
        },
        409,
      );
    }
    return c.json({ pipeline: result.pipeline, created: result.created }, result.created ? 201 : 200);
  });

  return app;
}
