import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';

/** Имена лог-файлов, доступные для чтения. Строгий whitelist — никакого path traversal. */
const LOG_WHITELIST = ['core', 'ui', 'backend'] as const;

const DEFAULT_TAIL = 200;
const MIN_TAIL = 1;
const MAX_TAIL = 2000;

export interface LogsRoutesDeps {
  /** Каталог лог-файлов ({logDir}/{name}.log). */
  logDir: string;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Резолвит каталог логов: env SYNTH_LOG_DIR приоритетнее, иначе ищет существующий
 * tmp-каталог с лог-файлами (cwd/tmp или cwd/../tmp — dev.sh пишет логи в ROOT/tmp,
 * а backend-процесс запускается из $SYNTH). Финальный fallback — cwd/tmp.
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
 * GET /api/v2/logs/:name?tail=N&search=...
 * Чтение хвоста лог-файлов сервисов (core/ui/backend). Только ADMIN/AUDITOR.
 * - :name — строго из whitelist, иначе 404. Path traversal невозможен.
 * - tail — int, дефолт 200, минимум 1, максимум 2000 (clamp).
 * - search — необязательная подстрока, case-insensitive фильтр по строкам.
 * Ответ: { name, file, total, tail, lines } — lines это последние tail строк
 * после фильтра search, total — сколько строк подходит под фильтр (до tail).
 */
export function createLogsRoutes(kit: AuthKit, deps: LogsRoutesDeps): Hono {
  const app = new Hono();

  app.get('/:name', kit.requirePermission('ADMIN', 'AUDITOR'), async (c) => {
    const name = c.req.param('name');
    if (!LOG_WHITELIST.includes(name as (typeof LOG_WHITELIST)[number])) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Лог «${name}» не найден` } }, 404);
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
        return c.json({ error: { code: 'NOT_FOUND', message: `Файл лога не найден: ${file}` } }, 404);
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
