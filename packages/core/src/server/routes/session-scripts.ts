/**
 * HTTP-контур реестра скриптов проекта (`!`-запуск) — ADR-126 §5.
 *
 * Единая core-фабрика: её зовут HTTP-роуты (`/api/v2/sessions/:id/scripts*`).
 * Доступ — **существующий prefix-guard** сессий
 * (`server/session-access-guard.ts`): чтение — read-доступ к сессии, запуск —
 * write-доступ. Проверок доступа внутри обработчиков нет (инвариант 16) —
 * фабрика **монтируется внутрь** приложения сессий, поэтому guard её покрывает.
 *
 * Эндпоинты:
 * - `GET  /:id/scripts`          → `{ scripts }` (+ `diagnostics` при `?diagnostics=1`);
 * - `GET  /:id/scripts/:name`    → `ScriptDetail`;
 * - `POST /:id/scripts/:name/run` → `202 ScriptRunResponse`.
 *
 * ## Права (ADR-126 §5)
 *
 * `permission.rules.script` (allow/deny/ask + glob по имени, как `skill`):
 * - `deny` **скрывает** скрипт из реестра и блокирует запуск;
 * - `ask` **не** спрашивает человека: человек сам инициировал действие,
 *   `ask` — механизм защиты **агентских** вызовов (как ввод в терминале).
 *   Только `deny` блокирует.
 *
 * ## Гибрид (ADR-042)
 *
 * Для `remote:`-сессии запрос **форвардится** на удалённый backend: реестр
 * скриптов и права живут в его мире. Prefix-guard сессий `remote:`-id
 * пропускает, поэтому доступ проверяет удалённая сторона.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { scriptRunRequestSchema } from '@itphx/synth-shared';
import type { PermissionConfig, ScriptDetail, ScriptSummary, Session } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { isRemoteRef, toLocalId } from '../../remote/aggregate.js';
import type { ScriptService } from '../../engine/scripts/service.js';
import { splitScriptArguments } from '../../engine/scripts/args.js';
import { ScriptError, type ScriptErrorCode } from '../../engine/scripts/types.js';
import { resolveScriptRule } from '../../engine/permission/evaluator.js';
import { sha256Hex, type CommandAuditLog } from '../../engine/security/command-audit.js';
import { forwardRemoteRequest, type RemoteForwardMethod } from './remote-forward.js';
import type { ProjectWorkRoutesAuth } from './project-work.js';

/** Зависимости фабрики скриптов. */
export interface SessionScriptRoutesDeps extends ProjectWorkRoutesAuth {
  sessionManager: SessionManager;
  /**
   * Сервис реестра скриптов. Не задан — контура нет (деградированное
   * хранилище: `processService` не создан — писать фоновые прогоны некуда).
   */
  scriptService?: ScriptService;
  /**
   * Рабочий каталог сессии (worktree или workspace проекта) — корень
   * деклараций `.synth/scripts` и база для `cwd` скрипта.
   *
   * Не задан — скрипты проекта не видны (видны только инстансные и из
   * `config.scripts.paths`).
   */
  resolveWorkingDir?: (session: Session) => Promise<string | undefined>;
  /**
   * Правила прав инстанса — fallback, если у сессии нет своих
   * (`session.settings.permission`). Правило `script` (`deny`) скрывает
   * скрипт и блокирует запуск.
   */
  permissionConfig?: PermissionConfig;
  /**
   * Журнал исполнений команд (ADR-136) — запись `script.run` (только
   * метаданные: имя скрипта, cwd, число аргументов, origin).
   */
  commandAudit?: CommandAuditLog;
  /**
   * Гибрид (ADR-042): клиент удалённого backend — для форварда запросов к
   * удалённой сессии (`remote:<uuid>`). Не задан (managed backend) — форварда
   * нет.
   */
  getRemoteClient?: () => RemoteBackendClient | null;
}

/** Локализуемые сообщения (backend — i18n, core — русские литералы). */
export interface SessionScriptRouteMessages {
  /** Скрипт не объявлен (404 `SCRIPT_NOT_FOUND`). */
  scriptNotFound: (c: Context) => string;
  /** Каталог источника недоверенный (403 `SCRIPT_UNTRUSTED`). */
  scriptUntrusted: (c: Context) => string;
  /** Скрипт запрещён правилом прав (403 `SCRIPT_DENIED`). */
  scriptDenied: (c: Context) => string;
  /** Скрипт не принимает аргументов (409 `SCRIPT_ARGS_NOT_ALLOWED`). */
  scriptArgsNotAllowed: (c: Context) => string;
  /** Аргументы не разобрались (400 `SCRIPT_ARGS_INVALID`). */
  scriptArgsInvalid: (c: Context) => string;
  /** `cwd` скрипта вне периметра сессии (400 `SCRIPT_CWD_OUTSIDE`). */
  scriptCwdOutside: (c: Context) => string;
  /** Фоновое исполнение недоступно в текущем режиме (503). */
  scriptBackgroundDisabled: (c: Context) => string;
  /** Контур скриптов недоступен в этой сборке (404 `SCRIPTS_UNAVAILABLE`). */
  scriptsUnavailable: (c: Context) => string;
  /** Некорректное тело запроса (400 `VALIDATION_ERROR`). */
  invalidBody: (c: Context) => string;
}

export const DEFAULT_SESSION_SCRIPT_MESSAGES: SessionScriptRouteMessages = {
  scriptNotFound: () => 'Скрипт не объявлен',
  scriptUntrusted: () => 'Каталог источника скрипта недоверенный',
  scriptDenied: () => 'Скрипт запрещён правилами прав',
  scriptArgsNotAllowed: () => 'Скрипт не принимает аргументов',
  scriptArgsInvalid: () => 'Аргументы скрипта не разобрались',
  scriptCwdOutside: () => 'Рабочий каталог скрипта вне периметра сессии',
  scriptBackgroundDisabled: () => 'Фоновое исполнение недоступно в текущем режиме',
  scriptsUnavailable: () => 'Контур скриптов недоступен',
  invalidBody: () => 'Некорректное тело запроса',
};

/**
 * Единая таблица маппинга `ScriptError.code` → HTTP (ADR-126 §5).
 *
 * Единственное место: и HTTP-роут, и тесты смотрят в одну таблицу.
 */
const SCRIPT_ERROR_HTTP: Record<
  ScriptErrorCode,
  { status: 404 | 400 | 403 | 409 | 503; code: string; message: keyof SessionScriptRouteMessages }
> = {
  script_not_found: { status: 404, code: 'SCRIPT_NOT_FOUND', message: 'scriptNotFound' },
  script_untrusted: { status: 403, code: 'SCRIPT_UNTRUSTED', message: 'scriptUntrusted' },
  script_args_not_allowed: {
    status: 409,
    code: 'SCRIPT_ARGS_NOT_ALLOWED',
    message: 'scriptArgsNotAllowed',
  },
  script_args_invalid: { status: 400, code: 'SCRIPT_ARGS_INVALID', message: 'scriptArgsInvalid' },
  script_cwd_outside: { status: 400, code: 'SCRIPT_CWD_OUTSIDE', message: 'scriptCwdOutside' },
  script_background_disabled: {
    status: 503,
    code: 'SCRIPT_BACKGROUND_DISABLED',
    message: 'scriptBackgroundDisabled',
  },
};

/**
 * API реестра скриптов сессии (ADR-126 §5). Монтируется **внутрь** приложения
 * сессий (`app.route('/', …)`), чтобы доступ решал единый prefix-guard.
 */
export function createSessionScriptRoutes(
  deps: SessionScriptRoutesDeps,
  opts?: { messages?: Partial<SessionScriptRouteMessages> },
): Hono {
  const app = new Hono();
  const messages: SessionScriptRouteMessages = {
    ...DEFAULT_SESSION_SCRIPT_MESSAGES,
    ...opts?.messages,
  };

  const jsonError = (c: Context, status: number, code: string, message: string) =>
    c.json({ error: { code, message } }, status as 400);

  /**
   * Форвард запроса к удалённой сессии (ADR-042/ADR-126 §5).
   *
   * `null` — запрос локальный. Иначе — готовый HTTP-ответ. Форвард — **до**
   * локальной обработки: и права, и валидация решает удалённая сторона.
   */
  const forwardRemote = async (
    c: Context,
    sessionId: string,
    method: RemoteForwardMethod,
    path: string,
    body?: unknown,
  ): Promise<Response | null> => {
    if (!isRemoteRef(sessionId)) return null;
    const client = deps.getRemoteClient?.() ?? null;
    if (!client) {
      return c.json(
        { error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } },
        502,
      );
    }
    const fullPath = `/api/v2/sessions/${encodeURIComponent(toLocalId(sessionId))}${path}`;
    return forwardRemoteRequest(c, client, method, fullPath, body);
  };

  /**
   * Эффективные правила прав сессии: собственные правила сессии важнее
   * инстансных (ADR-029).
   */
  const effectivePermission = (session: Session | null): PermissionConfig | undefined =>
    session?.settings.permission ?? deps.permissionConfig;

  /** Скрипт запрещён правилом прав? (`deny` — и только `deny`). */
  const isDenied = (session: Session | null, name: string): boolean =>
    resolveScriptRule(effectivePermission(session), name)?.action === 'deny';

  /** Сессия + её рабочий каталог (worktree или workspace проекта). */
  const resolveSessionContext = async (
    sessionId: string,
  ): Promise<{ session: Session | null; workingDir?: string }> => {
    const session = await deps.sessionManager.getSession(sessionId);
    if (!session) return { session: null };
    const workingDir = deps.resolveWorkingDir
      ? await deps.resolveWorkingDir(session).catch(() => undefined)
      : undefined;
    return { session, ...(workingDir ? { workingDir } : {}) };
  };

  /** Ответ «контур скриптов недоступен» (сервиса нет — degraded storage). */
  const scriptsUnavailable = (c: Context): Response =>
    jsonError(c, 404, 'SCRIPTS_UNAVAILABLE', messages.scriptsUnavailable(c));

  // GET /api/v2/sessions/:id/scripts — реестр скриптов.
  app.get('/:id/scripts', deps.requireAuth, async (c) => {
    const sessionId = c.req.param('id');
    const forwarded = await forwardRemote(c, sessionId, 'GET', '/scripts');
    if (forwarded) return forwarded;

    const service = deps.scriptService;
    if (!service) return scriptsUnavailable(c);

    const { session, workingDir } = await resolveSessionContext(sessionId);
    const { scripts, diagnostics } = await service.list(
      workingDir ? { projectWorkspace: workingDir } : {},
    );
    const withDiagnostics = c.req.query('diagnostics') === '1';

    // ADR-126 §5: `deny` скрывает скрипт — и для человека тоже (правило —
    // политика инстанса/сессии, а не только агентская).
    const visible: ScriptSummary[] = scripts.filter(
      (script) => !isDenied(session, script.name),
    );

    return c.json({
      scripts: visible,
      ...(withDiagnostics ? { diagnostics } : {}),
    });
  });

  // GET /api/v2/sessions/:id/scripts/:name — детали декларации.
  app.get('/:id/scripts/:name', deps.requireAuth, async (c) => {
    const sessionId = c.req.param('id');
    const name = c.req.param('name');
    const forwarded = await forwardRemote(c, sessionId, 'GET', `/scripts/${encodeURIComponent(name)}`);
    if (forwarded) return forwarded;

    const service = deps.scriptService;
    if (!service) return scriptsUnavailable(c);

    const { session, workingDir } = await resolveSessionContext(sessionId);
    // Скрытый скрипт выглядит как отсутствующий (существование не раскрываем).
    if (isDenied(session, name)) {
      return jsonError(c, 404, 'SCRIPT_NOT_FOUND', messages.scriptNotFound(c));
    }

    const detail: ScriptDetail | null = await service.get(
      name,
      workingDir ? { projectWorkspace: workingDir } : {},
    );
    if (!detail) return jsonError(c, 404, 'SCRIPT_NOT_FOUND', messages.scriptNotFound(c));

    return c.json(detail);
  });

  // POST /api/v2/sessions/:id/scripts/:name/run — запуск скрипта.
  app.post('/:id/scripts/:name/run', deps.requireAuth, async (c) => {
    const sessionId = c.req.param('id');
    const name = c.req.param('name');
    const rawBody = await c.req.json().catch(() => ({}));
    const forwarded = await forwardRemote(
      c,
      sessionId,
      'POST',
      `/scripts/${encodeURIComponent(name)}/run`,
      rawBody,
    );
    if (forwarded) return forwarded;

    const service = deps.scriptService;
    if (!service) return scriptsUnavailable(c);

    const parsed = scriptRunRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonError(c, 400, 'VALIDATION_ERROR', messages.invalidBody(c));
    }

    const { session, workingDir } = await resolveSessionContext(sessionId);
    // ADR-126 §5: `deny` блокирует запуск. `ask` — не спрашиваем: человек
    // сам инициировал действие (`ask` защищает агентские вызовы).
    if (isDenied(session, name)) {
      return jsonError(c, 403, 'SCRIPT_DENIED', messages.scriptDenied(c));
    }

    // Без периметра сессии запускать нечего: `cwd` скрипта не с чем
    // сравнивать (fail-closed).
    if (!workingDir) {
      return jsonError(c, 400, 'SCRIPT_CWD_OUTSIDE', messages.scriptCwdOutside(c));
    }

    const args = parsed.data.arguments ?? '';

    // ADR-136: журнал исполнений — запись `started` **до** запуска. Только
    // метаданные: имя скрипта, cwd, число аргументов, origin.
    //
    // `execution_id` — один на пару `started`/`finished`: тот же id уходит в
    // запись реестра прогона (`metadata.audit_id`), по нему терминальный
    // переход дописывает парную запись `finished`.
    const audit = deps.commandAudit;
    let auditId: string | undefined;
    if (audit && audit.enabled) {
      const executionId = randomUUID();
      auditId = executionId;
      const argCount = countArguments(args);
      const description = `script.run name=${name} args=${argCount} origin=user`;
      try {
        await audit.append({
          id: executionId,
          ts: new Date().toISOString(),
          sessionId,
          ...(session?.projectId ? { projectId: session.projectId } : {}),
          ...(session?.ownerId ?? session?.userId
            ? { actor: (session.ownerId ?? session.userId)! }
            : {}),
          tool: 'script.run',
          command: description,
          commandHash: sha256Hex(description),
          cwd: workingDir,
          background: true,
          decision: 'allow',
          decidedBy: 'permission',
          phase: 'started',
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonError(c, 503, 'SCRIPT_AUDIT_FAILED', reason);
      }
    }

    try {
      const result = await service.run({
        name,
        ...(args ? { args } : {}),
        sessionId,
        ...(session?.projectId ? { projectId: session.projectId } : {}),
        workingDir,
        origin: 'user',
        projectWorkspace: workingDir,
        ...(auditId ? { auditId } : {}),
      });
      return c.json(result, 202);
    } catch (err) {
      if (!(err instanceof ScriptError)) throw err;
      const mapped = SCRIPT_ERROR_HTTP[err.code];
      return jsonError(c, mapped.status, mapped.code, messages[mapped.message](c));
    }
  });

  return app;
}

/**
 * Число аргументов скрипта — только для аудита (сами аргументы не пишутся).
 *
 * Разбор лексером скриптов: неразобранные аргументы дают `0` — сервис вернёт
 * ошибку разбора отдельно.
 */
function countArguments(args: string): number {
  if (!args.trim()) return 0;
  try {
    return splitScriptArguments(args).length;
  } catch {
    return 0;
  }
}
