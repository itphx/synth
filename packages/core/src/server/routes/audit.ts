import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import type { EgressRequestLogRepository } from '../../storage/ports/egress-request-log-repository.js';
import type { EgressRequestScope, EgressRequestStatus, SecurityAuditScope } from '@itphx/synth-shared';
import {
  COMMAND_AUDIT_DECISIONS,
  EGRESS_REQUEST_SCOPES,
  EGRESS_REQUEST_STATUSES,
  SECURITY_AUDIT_SCOPES,
} from '@itphx/synth-shared';
import type { CommandAuditDecision } from '@itphx/synth-shared';
import { readAuditLog, type AuditLogger } from '../../engine/gateway/audit-logger.js';
import { PLACEHOLDER_PATTERN } from '../../engine/gateway/obfuscator.js';
import type { CommandAuditLog } from '../../engine/security/command-audit.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/**
 * Голый аудит LLM Gateway (ADR-036) — append-only JSONL журнала.
 * Отдельный от журналов безопасности (`/security`) и egress (`/egress`).
 */
export interface GatewayAuditDeps {
  /** Путь к append-only JSONL файлу аудита LLM Gateway. */
  auditLogPath: string;
  /** Логгер записи событий аудита (тот же JSONL-файл, что читает GET /api/v2/audit). */
  logger: AuditLogger;
  /** Проверка существования сессии (для POST /api/v2/audit/revealed). */
  sessionExists: (sessionId: string) => Promise<boolean>;
}

export interface AuditRoutesDeps {
  securityAudit: SecurityAuditRepository;
  egressRequests: EgressRequestLogRepository;
  /**
   * PROP-136 (слайс 136a): журнал **исполнений** команд
   * (`GET /api/v2/audit/commands`, `DELETE /api/v2/audit/commands`).
   * Не задан — маршруты не монтируются.
   */
  commandAudit?: CommandAuditLog;
  /**
   * Голый аудит LLM Gateway (ADR-036): `GET /api/v2/audit` и
   * `POST /api/v2/audit/revealed`. Не задан — эти пути не монтируются
   * (только журналы безопасности и egress).
   */
  gatewayAudit?: GatewayAuditDeps;
}

export interface AuditRoutesMessages {
  /** `sessionId` и `placeholder` обязательны. */
  fieldsRequired: (c: Context) => string;
  /** `placeholder` не соответствует формату ⟦SYNTH_SECRET_N⟧. */
  invalidPlaceholder: (c: Context) => string;
  /** Сессия не найдена. */
  sessionNotFound: (c: Context) => string;
}

export interface AuditRoutesOptions {
  /** Guard на чтение журналов безопасности; по умолчанию — `requireAuth` (core). Managed — ADMIN/AUDITOR. */
  readGuard?: Middleware;
  /**
   * Guard на чтение голого аудита Gateway (`GET /api/v2/audit`).
   * По умолчанию — `readGuard`.
   */
  gatewayReadGuard?: Middleware;
  /**
   * Guard на `POST /api/v2/audit/revealed`. По умолчанию — `requireAuth`
   * (любой аутентифицированный: раскрытие плейсхолдера делает пользователь сессии).
   */
  revealedGuard?: Middleware;
  /** Максимум записей по умолчанию. */
  defaultLimit?: number;
  /**
   * Guard на `DELETE /api/v2/audit/commands` (retention-очистка журнала
   * исполнений). По умолчанию — `readGuard` (managed передаёт ADMIN).
   */
  commandsAdminGuard?: Middleware;
  /** Локализуемые сообщения (backend — i18n, core — русские литералы). */
  messages?: Partial<AuditRoutesMessages>;
}

const DEFAULT_MESSAGES: AuditRoutesMessages = {
  fieldsRequired: () => 'sessionId и placeholder обязательны',
  invalidPlaceholder: () => 'placeholder должен соответствовать формату ⟦SYNTH_SECRET_N⟧',
  sessionNotFound: () => 'Сессия не найдена',
};

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), 1000);
}

/**
 * Чтение журналов аудита (core + managed — одна реализация):
 * - `GET /api/v2/audit/security?limit&scope` — аудит изменений egress/security-политик;
 * - `GET /api/v2/audit/egress?limit&scope&status` — журнал внешних запросов;
 * - `GET /api/v2/audit?userId&sessionId&since&until&limit` — аудит LLM Gateway
 *   (ADR-036), только при заданном `deps.gatewayAudit`;
 * - `POST /api/v2/audit/revealed` — фиксация раскрытия плейсхолдера секрета
 *   (ADR-036), только при заданном `deps.gatewayAudit`.
 *
 * Отличаются только guard'ами (managed — ADMIN/AUDITOR, core — requireAuth)
 * и текстами (backend — i18n, core — русские литералы).
 */
export function createAuditRoutes(
  auth: { requireAuth: Middleware },
  deps: AuditRoutesDeps,
  opts: AuditRoutesOptions = {},
): Hono {
  const app = new Hono();
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const gatewayReadGuard = opts.gatewayReadGuard ?? readGuard;
  const revealedGuard = opts.revealedGuard ?? auth.requireAuth;
  const defaultLimit = opts.defaultLimit ?? 100;
  const messages: AuditRoutesMessages = { ...DEFAULT_MESSAGES, ...opts.messages };

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

  // PROP-136 (слайс 136a): журнал **исполнений** команд (append-only JSONL).
  // Только при заданном `deps.commandAudit` — иначе пути не монтируются.
  if (deps.commandAudit) {
    const commands = deps.commandAudit;
    const commandsAdminGuard = opts.commandsAdminGuard ?? readGuard;

    app.get('/commands', readGuard, async (c) => {
      const query = c.req.query();
      // `limit` — строго целое > 0 (иначе 400), выше потолка — обрезается до 1000.
      const limitRaw = query['limit'];
      let limit = Math.min(defaultLimit, 1000);
      if (limitRaw !== undefined) {
        const parsed = Number(limitRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return c.json({
            error: { code: 'VALIDATION_ERROR', message: 'limit: ожидается целое число больше 0' },
          }, 400);
        }
        limit = Math.min(parsed, 1000);
      }
      const decisionRaw = query['decision'];
      if (decisionRaw !== undefined && !(COMMAND_AUDIT_DECISIONS as readonly string[]).includes(decisionRaw)) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `decision: ожидается один из ${COMMAND_AUDIT_DECISIONS.join(' | ')}`,
          },
        }, 400);
      }
      const entries = await commands.list({
        limit,
        ...(query['session_id'] ? { sessionId: query['session_id'] } : {}),
        ...(query['project_id'] ? { projectId: query['project_id'] } : {}),
        ...(query['from'] ? { from: query['from'] } : {}),
        ...(query['to'] ? { to: query['to'] } : {}),
        ...(decisionRaw ? { decision: decisionRaw as CommandAuditDecision } : {}),
      });
      return c.json({ entries, count: entries.length });
    });

    app.delete('/commands', commandsAdminGuard, async (c) => {
      const raw = c.req.query('older_than_days');
      const days = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(days) || days <= 0) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'older_than_days: ожидается положительное целое число дней',
          },
        }, 400);
      }
      const removed = await commands.prune(Math.floor(days));
      return c.json({ removed });
    });
  }

  // Голый аудит LLM Gateway (ADR-036) — только при заданных deps.
  if (deps.gatewayAudit) {
    const gateway = deps.gatewayAudit;

    app.get('/', gatewayReadGuard, async (c) => {
      const query = c.req.query();
      const limit = Math.min(Math.max(parseLimit(query['limit'], 100), 1), 500);

      const { entries, total } = await readAuditLog(gateway.auditLogPath, {
        userId: query['userId'] || undefined,
        sessionId: query['sessionId'] || undefined,
        since: query['since'] || undefined,
        until: query['until'] || undefined,
        limit,
      });

      return c.json({ entries, total });
    });

    app.post('/revealed', revealedGuard, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const placeholder = typeof body.placeholder === 'string' ? body.placeholder.trim() : '';

      if (!sessionId || !placeholder) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: messages.fieldsRequired(c) },
        }, 400);
      }

      if (!PLACEHOLDER_PATTERN.test(placeholder)) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: messages.invalidPlaceholder(c) },
        }, 400);
      }

      if (!(await gateway.sessionExists(sessionId))) {
        return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
      }

      // Пользователь запроса — из контекста (его выставляет requireAuth).
      const user = c.get('user' as never) as { id?: string } | undefined;
      await gateway.logger.append({
        ts: new Date().toISOString(),
        type: 'revealed',
        sessionId,
        userId: user?.id ?? 'unknown',
        placeholder,
      });

      return c.json({ ok: true });
    });
  }

  return app;
}
