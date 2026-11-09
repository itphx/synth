import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { readPayloadLog } from '../../engine/gateway/payload-logger.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Имена лог-файлов, доступные для чтения. Строгий whitelist — никакого path traversal. */
const LOG_WHITELIST = ['core', 'ui', 'backend'] as const;

const DEFAULT_TAIL = 200;
const MIN_TAIL = 1;
const MAX_TAIL = 2000;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface LogsRoutesAuth {
  requireAuth: Middleware;
}

export interface LogsRoutesDeps {
  /** Каталог лог-файлов ({logDir}/{name}.log). */
  logDir: string;
  /** Путь к JSONL полного лога запросов/ответов LLM (llm-payloads.jsonl). */
  payloadLogPath?: string;
}

export interface LogsRouteMessages {
  /** Лог вне whitelist (в т.ч. попытка path traversal). */
  logNotFound: (c: Context, name: string) => string;
  /** Файл лога отсутствует на диске. */
  logFileNotFound: (c: Context, file: string) => string;
}

export interface LogsRoutesOptions {
  /**
   * Guard на чтение логов. Managed — `requirePermission('ADMIN','AUDITOR')`,
   * core — `requireAuth` (локальный пользователь standalone всегда ADMIN).
   */
  readGuard?: Middleware;
  /**
   * Поведение при отсутствии файла лога:
   * - `not-found` (по умолчанию) — `404 NOT_FOUND` (managed: файл должен быть);
   * - `empty` — `200` с пустым хвостом (standalone: файлов логов нет вовсе).
   */
  missingFile?: 'not-found' | 'empty';
  /** Локализуемые сообщения (backend — i18n, core — русские литералы). */
  messages?: Partial<LogsRouteMessages>;
}

const DEFAULT_MESSAGES: LogsRouteMessages = {
  logNotFound: (_c, name) => `Лог «${name}» не найден`,
  logFileNotFound: (_c, file) => `Файл лога не найден: ${file}`,
};

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Резолвит каталог логов: env `SYNTH_LOG_DIR` приоритетнее, иначе ищет
 * существующий tmp-каталог с лог-файлами (cwd/tmp или cwd/../tmp — dev.sh
 * пишет логи в ROOT/tmp, а процесс запускается из $SYNTH). Финальный fallback —
 * cwd/tmp.
 */
export function resolveLogDir(): string {
  if (process.env.SYNTH_LOG_DIR) return process.env.SYNTH_LOG_DIR;

  const candidates = [join(process.cwd(), 'tmp'), join(process.cwd(), '..', 'tmp')];
  for (const dir of candidates) {
    for (const name of LOG_WHITELIST) {
      try {
        if (statSync(join(dir, `${name}.log`)).isFile()) return dir;
      } catch {
        // файла нет — пробуем следующий каталог
      }
    }
  }
  return candidates[0]!;
}

/**
 * HTTP-контур логов сервисов (ADR-095/ADR-036) — общий для core (standalone)
 * и backend (managed).
 *
 * GET /api/v2/logs/llm?sessionId=&limit= — полный лог запросов/ответов LLM
 *   (после обфускации). Если логирование выключено или файла нет — `{entries: [], total: 0}`.
 * GET /api/v2/logs/:name?tail=&search= — хвост лог-файла сервиса
 *   (`core|ui|backend`; строгий whitelist — path traversal невозможен).
 *
 * Отличается только guard'ом (managed — ADMIN|AUDITOR, core — requireAuth)
 * и поведением при отсутствии файла (managed — 404, standalone — пустой хвост).
 */
export function createLogsRoutes(
  auth: LogsRoutesAuth,
  deps: LogsRoutesDeps,
  opts: LogsRoutesOptions = {},
): Hono {
  const app = new Hono();
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const missingFile = opts.missingFile ?? 'not-found';
  const messages: LogsRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };

  /**
   * GET /llm — регистрируется ДО `/:name` (статический сегмент важнее
   * параметрического: иначе `/llm` попал бы под whitelist-фильтр `:name`).
   */
  app.get('/llm', readGuard, async (c) => {
    if (!deps.payloadLogPath) {
      return c.json({ entries: [], total: 0 });
    }
    const query = c.req.query();
    const limit = Math.min(Math.max(toInt(query['limit'], 100), 1), 500);
    const { entries, total } = await readPayloadLog(deps.payloadLogPath, {
      sessionId: query['sessionId'] || undefined,
      limit,
    });
    return c.json({ entries, total });
  });

  app.get('/:name', readGuard, async (c) => {
    const name = c.req.param('name');
    if (!LOG_WHITELIST.includes(name as (typeof LOG_WHITELIST)[number])) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: messages.logNotFound(c, name) } },
        404,
      );
    }

    const query = c.req.query();
    const tail = Math.min(Math.max(toInt(query['tail'], DEFAULT_TAIL), MIN_TAIL), MAX_TAIL);
    const search = (query['search'] ?? '').trim();

    const file = join(deps.logDir, `${name}.log`);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        if (missingFile === 'empty') {
          return c.json({ name, file, total: 0, tail, lines: [] });
        }
        return c.json(
          { error: { code: 'NOT_FOUND', message: messages.logFileNotFound(c, file) } },
          404,
        );
      }
      throw e;
    }

    let lines = raw.split('\n');
    // убираем хвостовую пустую строку от завершающего \n
    if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);

    if (search) {
      const needle = search.toLowerCase();
      lines = lines.filter((line) => line.toLowerCase().includes(needle));
    }

    const total = lines.length;
    const result = lines.slice(-tail);

    return c.json({ name, file, total, tail, lines: result });
  });

  return app;
}
