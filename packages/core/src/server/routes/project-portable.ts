// ADR-091 (этап 2) / ADR-096: HTTP-перенос проекта между инстансами —
// скачать портативный экспорт (`GET /:id/export`) и импортировать архив из UI/API
// (`POST /import`). Тонкая фабрика над `projects/portable.ts` (ADR-091 §6): сама
// работа (упаковка/распаковка + materialization) живёт в ядре, роуты лишь решают
// доступ, принимают/отдают поток и мапят ошибки в HTTP-коды.
//
// Единая фабрика для core (standalone) и backend (managed): RBAC задаётся
// `opts.readGuard`/`opts.writeGuard` (core-дефолт — `requireAuth`) и хуками
// `deps.canRead`/`deps.canEdit`; локализация — `deps.messages`. Секретов в архиве
// нет (см. `portable.ts`); содержимое и пути архивов не логируются.
//
// Импорт — **materialization** (ADR-089, инвариант 15): создаются новый `projectId`
// и новые сессии через `SessionManager.createSession`, не через funnel
// `session.requested` (перенос проекта между инстансами — не снятие снимка данных,
// ADR-091). Для уведомления хаба (ADR-089, инвариант 18) `importProject` вызывает
// `deps.onSessionCreated` после материализации каждой сессии — роуты прокидывают
// сюда идемпотентный ускоритель подписки владельца.
//
// Загрузка архива защищена тройной проверкой лимита (паритет с `routes/fs.ts`):
// заявленный `content-length` → размер `File` → фактический размер прочитанных
// байт (chunked/лживый заголовок). Превышение → `413 PAYLOAD_TOO_LARGE`.
import { randomUUID } from 'node:crypto';
import { open, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { DEFAULT_MAX_UPLOAD_BYTES, slugifyWorkspaceName } from '@itphx/synth-shared';
import type { Project } from '@itphx/synth-shared';
import type { MaintenanceAuditRepository } from '../../storage/ports/index.js';
import { LOCAL_USER_ID } from '../local-owner.js';
import { exportProject, importProject, ProjectPortableError } from '../../projects/portable.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики (структурно совместим с core/backend AuthKit). */
export interface ProjectPortableRoutesAuth {
  requireAuth: Middleware;
}

/** Префикс staging-файла экспорта в `{dataDir}/tmp`. */
const PORTABLE_TMP_PREFIX = 'project-portable-';

/**
 * ADR-091 (этап 2): зависимости HTTP-переноса проекта. Резолв проекта — через
 * доменный порт (`ProjectRepository`, ADR-096); `dataDir` нужен ядру
 * `exportProject`/`importProject` (они собирают файловое хранилище сами).
 */
export interface ProjectPortableRoutesDeps {
  /** Каталог данных инстанса (`$SYNTH_DATA_DIR`). */
  dataDir: string;
  /** Резолв проекта по id (null → 404). */
  getProject: (projectId: string) => Promise<Project | null>;
  /**
   * Для `GET /:id/export`: право чтения проекта (managed — owner/участник/LEAD/ADMIN).
   * Не задан — доступ уже обеспечен guard'ом (standalone, один пользователь).
   */
  canRead?: (c: Context, projectId: string) => Promise<boolean> | boolean;
  /** Для `POST /import` с `mergeInto`: право редактирования целевого проекта. */
  canEdit?: (c: Context, projectId: string) => Promise<boolean> | boolean;
  /** ADR-092: аудит-журнал обслуживания (`export.created`/`import.applied`, best-effort). */
  audit?: MaintenanceAuditRepository;
  /** Лимит загрузки архива (байты). Дефолт — `DEFAULT_MAX_UPLOAD_BYTES`. */
  maxUploadBytes?: number;
  /**
   * Владелец нового проекта/сессий. Не задан — `LOCAL_USER_ID` (standalone).
   * Managed — id текущего пользователя, иначе импорт «выпал» бы из его списков.
   */
  resolveOwnerId?: (c: Context) => string | undefined;
  /**
   * ADR-089 (инвариант 18): ускоритель подписки хаба на каждую импортированную
   * сессию. Прокидывается в `importProject.onSessionCreated` (managed —
   * `EventHub.subscribeToSession`, standalone — `subscribeWsSession`).
   */
  onSessionCreated?: (sessionId: string, ownerId: string) => void | Promise<void>;
  /** Локализуемые сообщения (backend — `t()`, core — русские литералы по умолчанию). */
  messages?: Partial<ProjectPortableRouteMessages>;
}

/** Локализуемые сообщения фабрики. */
export interface ProjectPortableRouteMessages {
  forbidden: (c: Context) => string;
  notFound: (c: Context) => string;
  invalidBody: (c: Context) => string;
  invalidArchive: (c: Context) => string;
  checksumMismatch: (c: Context) => string;
  nameConflict: (c: Context) => string;
  confirmRequired: (c: Context) => string;
  workspaceError: (c: Context) => string;
  payloadTooLarge: (c: Context) => string;
}

export interface ProjectPortableRoutesOptions {
  /** Guard на чтение (`GET /:id/export`); по умолчанию — `requireAuth` (core). */
  readGuard?: Middleware;
  /** Guard на импорт (`POST /import`); по умолчанию — `requireAuth` (core). */
  writeGuard?: Middleware;
}

const DEFAULT_MESSAGES: ProjectPortableRouteMessages = {
  forbidden: () => 'Доступ к проекту запрещён',
  notFound: () => 'Проект не найден',
  invalidBody: () => 'Некорректный запрос (ожидается multipart-файл архива проекта)',
  invalidArchive: () => 'Архив проекта недействителен или повреждён',
  checksumMismatch: () => 'Контрольная сумма архива проекта не совпадает',
  nameConflict: () => 'Проект с таким именем уже существует',
  confirmRequired: () => 'Требуется подтверждение (confirm: true)',
  workspaceError: () => 'Не удалось восстановить рабочий каталог проекта',
  payloadTooLarge: () => 'Архив превышает допустимый размер',
};

/** Безопасный слаг проекта для имени файла в `Content-Disposition`. */
function _safeSlug(name: string): string {
  const slug = slugifyWorkspaceName(name).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'project';
}

/** Строковое поле multipart (trim; пустое → undefined). */
function _stringField(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

/** Булево поле multipart (`'true'`/`'1'`). */
function _boolField(formData: FormData, key: string): boolean {
  const value = formData.get(key);
  return value === 'true' || value === '1';
}

/**
 * HTTP-перенос проекта между инстансами (ADR-091 §6).
 *
 * | Метод/путь | Назначение | Guard |
 * |---|---|---|
 * | `GET /:id/export` | скачать портативный архив проекта (`?withWorkspace=true`) | read + `canRead` |
 * | `POST /import` | импортировать архив (multipart `file`) | write |
 *
 * `POST /import` принимает поля multipart: `file` (обязательно), `name`,
 * `mergeInto`, `withWorkspace` (`'true'`), `confirm` (`'true'`). **`confirm` не
 * обязателен** (решение зафиксировано здесь): импорт в новый/существующий проект —
 * не деструктивная операция, подтверждение не запрашивается, `importProject`
 * вызывается с `yes: true`; поле принимается для совместимости с UI. Импорт в
 * существующий проект (`mergeInto`) дополнительно проверяется `canEdit` (403).
 *
 * Ошибки `ProjectPortableError` → `404 NOT_FOUND` (нет проекта),
 * `409 CONFLICT` (занятое имя), `400 VALIDATION_ERROR` (битый архив/чек-суммы/
 * workspace). Прочая ошибка пробрасывается (500).
 */
export function createProjectPortableRoutes(
  auth: ProjectPortableRoutesAuth,
  deps: ProjectPortableRoutesDeps,
  opts: ProjectPortableRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: ProjectPortableRouteMessages = { ...DEFAULT_MESSAGES, ...deps.messages };
  const readGuard: Middleware = opts.readGuard ?? auth.requireAuth;
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const maxUploadBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const dataDir = resolve(deps.dataDir);

  const forbidden = (c: Context) =>
    c.json({ error: { code: 'FORBIDDEN', message: messages.forbidden(c) } }, 403);
  const notFound = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.notFound(c) } }, 404);
  const invalidBody = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidBody(c) } }, 400);
  const payloadTooLarge = (c: Context) =>
    c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: messages.payloadTooLarge(c) } }, 413);

  /** Маппинг `ProjectPortableError` в HTTP-ответ; прочие ошибки — пробрасываются. */
  const portableError = (c: Context, err: unknown): Response => {
    if (!(err instanceof ProjectPortableError)) throw err;
    switch (err.code) {
      case 'project-not-found':
        return notFound(c);
      case 'project-name-conflict':
        return c.json({ error: { code: 'CONFLICT', message: messages.nameConflict(c) } }, 409);
      case 'checksum-mismatch':
        return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.checksumMismatch(c) } }, 400);
      case 'workspace-error':
        return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.workspaceError(c) } }, 400);
      case 'confirmation-required':
        return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.confirmRequired(c) } }, 400);
      case 'invalid-archive':
      default:
        return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidArchive(c) } }, 400);
    }
  };

  /** Инициатор операции (аудит, ADR-092). */
  const actor = (c: Context): string | undefined => {
    const user = c.get('user' as never) as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : undefined;
  };

  // GET /api/v2/projects/:id/export — скачать портативный архив проекта.
  // Экспорт во временный файл, стриминг и удаление файла в `finally`; дескриптор
  // открыт заранее (`open(...).createReadStream()`), поэтому `rm` не гонится со
  // стримом — на POSIX данные живут, пока открыт fd.
  app.get('/:id/export', readGuard, async (c) => {
    const id = c.req.param('id');
    const project = await deps.getProject(id);
    if (!project) return notFound(c);
    if (deps.canRead && !(await deps.canRead(c, id))) return forbidden(c);

    const outPath = join(dataDir, 'tmp', `${PORTABLE_TMP_PREFIX}${randomUUID()}.synth-project.tar.gz`);
    try {
      const result = await exportProject({
        dataDir,
        projectId: id,
        out: outPath,
        withWorkspace: _boolQuery(c, 'withWorkspace') || _boolQuery(c, 'with_workspace'),
        audit: deps.audit,
        actor: actor(c),
      });
      const handle = await open(result.path, 'r');
      const size = (await handle.stat()).size;
      const body = Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream;
      const fileName = `${_safeSlug(project.name)}.synth-project.tar.gz`;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Content-Length': String(size),
        },
      });
    } catch (err) {
      return portableError(c, err);
    } finally {
      await rm(outPath, { force: true }).catch(() => {});
    }
  });

  // POST /api/v2/projects/import — импортировать архив проекта (multipart).
  app.post('/import', writeGuard, async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) return invalidBody(c);

    // DoS-защита (паритет с `routes/fs.ts`): `content-length` → размер `File` →
    // фактический размер прочитанных байт (chunked/лживый заголовок).
    const declaredLength = Number.parseInt(c.req.header('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      return payloadTooLarge(c);
    }

    const formData = await c.req.formData().catch(() => null);
    if (!formData) return invalidBody(c);

    const rawField = formData.get('file');
    const uploadField = Array.isArray(rawField) ? rawField[0] : rawField;
    if (!uploadField || typeof uploadField === 'string') return invalidBody(c);

    const declaredFileSize = (uploadField as { size?: unknown }).size;
    if (typeof declaredFileSize === 'number' && declaredFileSize > maxUploadBytes) {
      return payloadTooLarge(c);
    }

    let data: ArrayBuffer;
    if (typeof (uploadField as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
      data = await (uploadField as File).arrayBuffer();
    } else {
      return invalidBody(c);
    }
    if (data.byteLength > maxUploadBytes) return payloadTooLarge(c);

    const mergeInto = _stringField(formData, 'mergeInto') ?? _stringField(formData, 'merge_into');
    if (mergeInto && deps.canEdit) {
      const target = await deps.getProject(mergeInto);
      if (!target) return notFound(c);
      if (!(await deps.canEdit(c, mergeInto))) return forbidden(c);
    }

    // `confirm` принимается для совместимости с UI, но не обязателен (см. JSDoc):
    // импорт не деструктивен, `importProject` вызывается с `yes: true`.
    const archivePath = join(dataDir, 'tmp', `${PORTABLE_TMP_PREFIX}${randomUUID()}.upload.tar.gz`);
    try {
      await mkdir(join(dataDir, 'tmp'), { recursive: true });
      await writeFile(archivePath, Buffer.from(data));

      const ownerId = deps.resolveOwnerId?.(c) ?? LOCAL_USER_ID;
      const result = await importProject({
        dataDir,
        archive: archivePath,
        name: _stringField(formData, 'name'),
        mergeInto,
        withWorkspace: _boolField(formData, 'withWorkspace'),
        yes: true,
        ownerId,
        audit: deps.audit,
        actor: actor(c),
        onSessionCreated: deps.onSessionCreated
          ? (sessionId) => deps.onSessionCreated?.(sessionId, ownerId)
          : undefined,
      });
      return c.json(result, 201);
    } catch (err) {
      return portableError(c, err);
    } finally {
      await rm(archivePath, { force: true }).catch(() => {});
    }
  });

  return app;
}

/** Булев query-параметр (`'true'`/`'1'`). */
function _boolQuery(c: Context, key: string): boolean {
  const value = c.req.query(key);
  return value === 'true' || value === '1';
}
