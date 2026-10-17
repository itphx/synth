import { Hono } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { AuthKit } from '../../auth/local.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import type { EgressRequestLogRepository } from '../../storage/ports/egress-request-log-repository.js';
import type { EgressRequestScope, EgressRequestStatus, SecurityAuditScope } from '@itphx/synth-shared';
import { EGRESS_REQUEST_SCOPES, EGRESS_REQUEST_STATUSES, SECURITY_AUDIT_SCOPES } from '@itphx/synth-shared';

/** Тип middleware, совпадающий с core/backend AuthKit. */
type Middleware = ReturnType<typeof createMiddleware>;

export interface AuditRoutesDeps {
  securityAudit: SecurityAuditRepository;
  egressRequests: EgressRequestLogRepository;
}

export interface AuditRoutesOptions {
  /** Guard на чтение; по умолчанию — `requireAuth` (core). Managed — ADMIN/AUDITOR. */
  readGuard?: Middleware;
  /** Максимум записей по умолчанию. */
  defaultLimit?: number;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), 1000);
}

/**
 * Чтение журналов безопасности:
 * - `GET /api/v2/audit/security?limit&scope` — аудит изменений egress/security-политик;
 * - `GET /api/v2/audit/egress?limit&scope&status` — журнал внешних запросов.
 *
 * Только чтение; запись идёт из settings-роутов и egress-guard'а.
 */
export function createAuditRoutes(
  auth: AuthKit,
  deps: AuditRoutesDeps,
  opts: AuditRoutesOptions = {},
): Hono {
  const app = new Hono();
  const readGuard: Middleware = opts.readGuard ?? auth.requireAuth;
  const defaultLimit = opts.defaultLimit ?? 100;

  app.get('/security', readGuard, async (c) => {
    const limit = parseLimit(c.req.query('limit'), defaultLimit);
    const scopeRaw = c.req.query('scope');
    if (scopeRaw !== undefined && !(SECURITY_AUDIT_SCOPES as readonly string[]).includes(scopeRaw)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'scope: ожидается "tools" | "webhooks" | "mcp"' } }, 400);
    }
    const entries = await deps.securityAudit.list({
      limit,
      ...(scopeRaw ? { scope: scopeRaw as SecurityAuditScope } : {}),
    });
    return c.json({ entries, count: entries.length });
  });

  app.get('/egress', readGuard, async (c) => {
    const limit = parseLimit(c.req.query('limit'), defaultLimit);
    const scopeRaw = c.req.query('scope');
    const statusRaw = c.req.query('status');
    if (scopeRaw !== undefined && !(EGRESS_REQUEST_SCOPES as readonly string[]).includes(scopeRaw)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: `scope: ожидается один из ${EGRESS_REQUEST_SCOPES.join(' | ')}` },
      }, 400);
    }
    if (statusRaw !== undefined && !(EGRESS_REQUEST_STATUSES as readonly string[]).includes(statusRaw)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'status: ожидается "allowed" | "blocked" | "error"' } }, 400);
    }
    const entries = await deps.egressRequests.list({
      limit,
      ...(scopeRaw ? { scope: scopeRaw as EgressRequestScope } : {}),
      ...(statusRaw ? { status: statusRaw as EgressRequestStatus } : {}),
    });
    return c.json({ entries, count: entries.length });
  });

  return app;
}
