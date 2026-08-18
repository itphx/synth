import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { readAuditLog, AuditLogger, PLACEHOLDER_PATTERN } from '@itphx/synth-core';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export interface AuditRoutesDeps {
  /** Путь к append-only JSONL файлу аудита LLM Gateway. */
  auditLogPath: string;
  /** Проверка существования сессии (для POST /api/v2/audit/revealed). */
  sessionExists: (sessionId: string) => Promise<boolean>;
  /** Логгер записи событий аудита (тот же JSONL-файл, что читает GET /api/v2/audit). */
  logger: AuditLogger;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * GET /api/v2/audit — просмотр аудита LLM Gateway (AD-036).
 * RBAC: только ADMIN/AUDITOR.
 * Фильтры: userId, sessionId, since/until (ISO), limit (дефолт 100, макс 500).
 */
export function createAuditRoutes(kit: AuthKit, deps: AuditRoutesDeps): Hono {
  const app = new Hono();

  app.get('/', kit.requirePermission('ADMIN', 'AUDITOR'), async (c) => {
    const query = c.req.query();
    const limit = Math.min(Math.max(toInt(query['limit'], DEFAULT_LIMIT), 1), MAX_LIMIT);

    const { entries, total } = await readAuditLog(deps.auditLogPath, {
      userId: query['userId'] || undefined,
      sessionId: query['sessionId'] || undefined,
      since: query['since'] || undefined,
      until: query['until'] || undefined,
      limit,
    });

    return c.json({ entries, total });
  });

  /**
   * POST /api/v2/audit/revealed — логирование раскрытия плейсхолдера (AD-036).
   * RBAC: любой авторизованный (клик по бейджу SecretPlaceholder делает
   * пользователь сессии), userId фиксируется из токена.
   * Тело: { sessionId, placeholder } (placeholder вида ⟦SYNTH_SECRET_N⟧).
   */
  app.post('/revealed', kit.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const placeholder = typeof body.placeholder === 'string' ? body.placeholder.trim() : '';

    if (!sessionId || !placeholder) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'sessionId и placeholder обязательны' },
      }, 400);
    }

    if (!PLACEHOLDER_PATTERN.test(placeholder)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'placeholder должен соответствовать формату ⟦SYNTH_SECRET_N⟧' },
      }, 400);
    }

    if (!(await deps.sessionExists(sessionId))) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    }

    const user = kit.getCurrentUser(c);
    await deps.logger.append({
      ts: new Date().toISOString(),
      type: 'revealed',
      sessionId,
      userId: user?.id ?? 'unknown',
      placeholder,
    });

    return c.json({ ok: true });
  });

  return app;
}
