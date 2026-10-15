import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { skillCreateSchema, skillFileWriteSchema, skillUpdateSchema, SKILL_NAME_MAX, SKILL_NAME_REGEX } from '@itphx/synth-shared';
import type { SkillDetail } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import type { SkillService } from '../../engine/skills/service.js';

export interface SkillRoutesDeps {
  skillService: SkillService;
  /**
   * ADR-046 §4.3: резолв абсолютного рабочего каталога проекта по id — для
   * project-скиллов в listing/detail. Не задан — project-скоуп не участвует.
   */
  resolveProjectWorkspace?: (projectId: string) => Promise<string | undefined>;
}

export interface SkillRoutesMessages {
  notFound: string;
  validation: string;
  conflict: string;
  notInstance: string;
}

const DEFAULT_MESSAGES: SkillRoutesMessages = {
  notFound: 'Скилл не найден',
  validation: 'Некорректные данные скилла',
  conflict: 'Скилл уже существует',
  notInstance: 'Скилл не является instance-скиллом и не может быть изменён через API',
};

export interface SkillRoutesOptions {
  /** Guard мутаций (backend — `requireAdmin`); не задан — только requireAuth. */
  writeGuard?: MiddlewareHandler;
  /** Локализованные сообщения (backend — `t()`). */
  messages?: (c: Context) => SkillRoutesMessages;
}

/**
 * ADR-046 §9.1: core API скиллов.
 *
 * `GET /` — реестр (с опциональной диагностикой), `POST /` — создание
 * instance-скилла, `GET/PATCH/DELETE /:name`, `GET/PUT/DELETE /:name/files/*`,
 * `POST /reload` — принудительный ре-скан.
 */
export function createSkillRoutes(
  auth: AuthKit,
  deps: SkillRoutesDeps,
  opts?: SkillRoutesOptions,
): Hono {
  const app = new Hono();
  const writeGuard: MiddlewareHandler = opts?.writeGuard ?? (async (_c, next) => { await next(); });
  const messages = (c: Context): SkillRoutesMessages => opts?.messages?.(c) ?? DEFAULT_MESSAGES;

  const resolveWorkspace = async (c: Context): Promise<string | undefined> => {
    const projectId = c.req.query('project_id');
    if (!projectId || !deps.resolveProjectWorkspace) return undefined;
    try {
      return await deps.resolveProjectWorkspace(projectId);
    } catch {
      return undefined;
    }
  };

  const notFound = (c: Context) => c.json(
    { error: { code: 'NOT_FOUND', message: messages(c).notFound } },
    404,
  );

  /** Относительный путь supporting-файла из URL (Hono wildcard `*`). */
  const readFileRelPath = (c: Context, name: string): string => {
    const marker = `/${name}/files/`;
    const idx = c.req.path.indexOf(marker);
    if (idx < 0) return '';
    return decodeURIComponent(c.req.path.slice(idx + marker.length));
  };

  /**
   * ADR-046 §3.2: невалидное имя скилла (не проходит `SKILL_NAME_REGEX`) не
   * является ресурсом → 404 (как у PATCH), без обращения к store и без 500.
   * Единая проверка на уровне роута; `assertSkillName` в store остаётся
   * внутренней защитой от небезопасных имён (`..`/`/`).
   */
  const isValidSkillName = (name: string): boolean =>
    name.length > 0 && name.length <= SKILL_NAME_MAX && SKILL_NAME_REGEX.test(name);

  // Force reload (до параметрических маршрутов).
  app.post('/reload', auth.requireAuth, writeGuard, async (c) => {
    deps.skillService.reload();
    return c.json({ status: 'reloaded' });
  });

  // Реестр скиллов. `?diagnostics=1` — диагностика discovery/валидации.
  app.get('/', auth.requireAuth, async (c) => {
    const projectWorkspace = await resolveWorkspace(c);
    const withDiagnostics = c.req.query('diagnostics') === '1';
    const { skills, diagnostics } = await deps.skillService.listSummaries({ projectWorkspace });
    return c.json({
      skills,
      ...(projectWorkspace ? { workspace: projectWorkspace } : {}),
      ...(withDiagnostics ? { diagnostics } : {}),
    });
  });

  // Создание instance-скилла.
  app.post('/', auth.requireAuth, writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = skillCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `${messages(c).validation}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`,
        },
      }, 400);
    }
    if (await deps.skillService.instanceExists(parsed.data.name)) {
      return c.json({ error: { code: 'CONFLICT', message: messages(c).conflict } }, 409);
    }
    const detail = await deps.skillService.createInstance({
      name: parsed.data.name,
      description: parsed.data.description,
      body: parsed.data.body,
      files: parsed.data.files,
    });
    return c.json(detail, 201);
  });

  // Supporting-файлы: список + чтение/запись/удаление.
  app.get('/:name/files', auth.requireAuth, async (c) => {
    const name = c.req.param('name');
    if (!isValidSkillName(name)) return notFound(c);
    const detail = await deps.skillService.detail(name, { projectWorkspace: await resolveWorkspace(c) });
    if (!detail) return notFound(c);
    return c.json({ name, files: detail.files });
  });

  app.get('/:name/files/*', auth.requireAuth, async (c) => {
    const name = c.req.param('name');
    if (!isValidSkillName(name)) return notFound(c);
    const relPath = readFileRelPath(c, name);
    const content = await deps.skillService.readSupportingFile(name, relPath, {
      projectWorkspace: await resolveWorkspace(c),
    });
    if (content === undefined) return notFound(c);
    return c.json({ name, path: relPath, content });
  });

  app.put('/:name/files/*', auth.requireAuth, writeGuard, async (c) => {
    const name = c.req.param('name');
    if (!isValidSkillName(name)) return notFound(c);
    const relPath = readFileRelPath(c, name);
    if (!(await deps.skillService.isInstanceSkill(name))) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages(c).notInstance } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = skillFileWriteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages(c).validation } }, 400);
    }
    await deps.skillService.writeInstanceFile(name, relPath, parsed.data.content);
    return c.json({ name, path: relPath });
  });

  app.delete('/:name/files/*', auth.requireAuth, writeGuard, async (c) => {
    const name = c.req.param('name');
    if (!isValidSkillName(name)) return notFound(c);
    const relPath = readFileRelPath(c, name);
    if (!(await deps.skillService.isInstanceSkill(name))) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages(c).notInstance } }, 404);
    }
    const deleted = await deps.skillService.deleteInstanceFile(name, relPath);
    if (!deleted) return notFound(c);
    return c.json({ status: 'deleted', name, path: relPath });
  });

  // Деталь скилла (тело + supporting-файлы).
  app.get('/:name', auth.requireAuth, async (c) => {
    const name = c.req.param('name');
    if (!isValidSkillName(name)) return notFound(c);
    const detail: SkillDetail | undefined = await deps.skillService.detail(name, {
      projectWorkspace: await resolveWorkspace(c),
    });
    if (!detail) return notFound(c);
    return c.json(detail);
  });

  // Обновление instance-скилла (description/body/metadata).
  app.patch('/:name', auth.requireAuth, writeGuard, async (c) => {
    const name = c.req.param('name');
    if (!isValidSkillName(name)) return notFound(c);
    if (!(await deps.skillService.isInstanceSkill(name))) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages(c).notInstance } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = skillUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `${messages(c).validation}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        },
      }, 400);
    }
    const detail = await deps.skillService.updateInstance(name, parsed.data);
    if (!detail) return notFound(c);
    return c.json(detail);
  });

  // Удаление instance-скилла.
  app.delete('/:name', auth.requireAuth, writeGuard, async (c) => {
    const name = c.req.param('name');
    if (!isValidSkillName(name)) return notFound(c);
    const removed = await deps.skillService.removeInstance(name);
    if (!removed) return notFound(c);
    return c.json({ status: 'deleted' });
  });

  return app;
}
