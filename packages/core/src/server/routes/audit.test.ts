import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditRoutes } from './audit.js';
import { AuditLogger, readAuditLog } from '../../engine/gateway/audit-logger.js';
import type { AuditEntry } from '../../engine/gateway/audit-logger.js';
import { createCommandAuditLog, sha256Hex } from '../../engine/security/command-audit.js';
import type { CommandAuditLog } from '../../engine/security/command-audit.js';
import type { CommandAuditEntry } from '@itphx/synth-shared';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import type { EgressRequestLogRepository } from '../../storage/ports/egress-request-log-repository.js';
import type { User } from '@itphx/synth-shared';

const adminUser: User = {
  id: 'admin',
  username: 'admin',
  roles: ['ADMIN'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'ADMIN',
  notes: '',
  interviewCompleted: false,
};

const auditorUser: User = {
  id: 'auditor',
  username: 'auditor',
  roles: ['AUDITOR'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'AUDITOR',
  notes: '',
  interviewCompleted: false,
};

const userUser: User = {
  id: 'developer',
  username: 'developer',
  roles: ['USER'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'USER',
  notes: '',
  interviewCompleted: false,
};

/** Ответ `GET /api/v2/audit` — записи журнала Gateway и их число. */
interface GatewayAuditListBody {
  entries: AuditEntry[];
  total: number;
}

/** Тело ошибки HTTP-ответа. */
interface ApiErrorBody {
  error: { code: string; message?: string };
}

function createMockKit(user: User | null) {
  return {
    requireAuth: async (c: Context, next: Next) => {
      if (!user) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
      }
      c.set('user', user);
      await next();
    },
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const u = c.get('user') as User | undefined;
      if (!u || !roles.some((r) => u.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
      }
      await next();
    },
    getCurrentUser: () => user,
  };
}

/** Заглушки журналов безопасности/egress — голый аудит Gateway их не касается. */
const emptySecurityAudit: SecurityAuditRepository = {
  append: async () => {},
  list: async () => [],
  clear: async () => 0,
};

const emptyEgressRequests: EgressRequestLogRepository = {
  append: async () => {},
  list: async () => [],
  prune: async () => 0,
  clear: async () => 0,
};

async function writeAuditEntry(logPath: string, entry: Record<string, unknown>): Promise<void> {
  await writeFile(logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
}

const entry1 = {
  ts: '2026-08-05T10:00:00.000Z',
  type: 'obfuscated',
  sessionId: 'ses-1',
  userId: 'admin',
  provider: 'itphx',
  model: 'qwen3:14b',
  secretsFound: ['sk-****'],
  placeholders: ['⟦SYNTH_SECRET_1⟧'],
  tokensIn: 100,
  tokensOut: 50,
};

const entry2 = {
  ts: '2026-08-05T11:00:00.000Z',
  type: 'rate_limited',
  sessionId: 'ses-2',
  userId: 'developer',
  provider: 'itphx',
  model: 'qwen3:14b',
  reason: 'Rate limit exceeded',
};

const entry3 = {
  ts: '2026-08-05T12:00:00.000Z',
  type: 'blocked',
  sessionId: 'ses-1',
  userId: 'admin',
  provider: 'itphx',
  model: 'qwen3:14b',
  secretsFound: ['sk-****'],
  reason: 'Запрос заблокирован',
};

describe('Audit API Routes — голый аудит LLM Gateway (core)', () => {
  let tmpDir: string;
  let auditLogPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-audit-'));
    await mkdir(join(tmpDir, 'audit'), { recursive: true });
    auditLogPath = join(tmpDir, 'audit', 'llm-gateway.jsonl');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp(
    user: User | null,
    opts: {
      withGatewayAudit?: boolean;
      sessionExists?: (id: string) => Promise<boolean>;
      /** PROP-136: журнал исполнений (`/audit/commands`). */
      commandAudit?: CommandAuditLog;
    } = {},
  ) {
    const app = new Hono();
    const kit = createMockKit(user);
    const logger = new AuditLogger(auditLogPath);
    app.use('*', kit.requireAuth);
    app.route('/api/v2/audit', createAuditRoutes(
      { requireAuth: kit.requireAuth },
      {
        securityAudit: emptySecurityAudit,
        egressRequests: emptyEgressRequests,
        ...(opts.commandAudit ? { commandAudit: opts.commandAudit } : {}),
        ...(opts.withGatewayAudit === false ? {} : {
          gatewayAudit: {
            auditLogPath,
            logger,
            sessionExists: opts.sessionExists ?? (async () => true),
          },
        }),
      },
      {
        // Managed-вариант: чтение — ADMIN|AUDITOR; `/revealed` — любой авторизованный.
        readGuard: kit.requirePermission('ADMIN', 'AUDITOR'),
        gatewayReadGuard: kit.requirePermission('ADMIN', 'AUDITOR'),
        revealedGuard: kit.requireAuth,
        // PROP-136: retention-очистка журнала исполнений — только ADMIN.
        commandsAdminGuard: kit.requirePermission('ADMIN'),
      },
    ));
    return app;
  }

  describe('GET /api/v2/audit', () => {
    it('возвращает пустой список если файла аудита нет', async () => {
      const res = await createApp(adminUser).request('/api/v2/audit');
      expect(res.status).toBe(200);
      const body = (await res.json()) as GatewayAuditListBody;
      expect(body).toEqual({ entries: [], total: 0 });
    });

    it('возвращает все записи и total', async () => {
      await writeAuditEntry(auditLogPath, entry1);
      await writeAuditEntry(auditLogPath, entry2);
      await writeAuditEntry(auditLogPath, entry3);

      const res = await createApp(adminUser).request('/api/v2/audit');
      expect(res.status).toBe(200);
      const body = (await res.json()) as GatewayAuditListBody;
      expect(body.total).toBe(3);
      expect(body.entries).toHaveLength(3);
      expect(body.entries[0]!.type).toBe('obfuscated');
      expect(body.entries[2]!.type).toBe('blocked');
    });

    it('фильтрует по userId и sessionId', async () => {
      await writeAuditEntry(auditLogPath, entry1);
      await writeAuditEntry(auditLogPath, entry2);
      await writeAuditEntry(auditLogPath, entry3);

      const res = await createApp(adminUser).request('/api/v2/audit?userId=admin&sessionId=ses-1');
      const body = (await res.json()) as GatewayAuditListBody;
      expect(body.total).toBe(2);
      expect(body.entries.map((e) => e.type)).toEqual(['obfuscated', 'blocked']);
    });

    it('фильтрует по since/until и ограничивает limit (хвост)', async () => {
      await writeAuditEntry(auditLogPath, entry1);
      await writeAuditEntry(auditLogPath, entry2);
      await writeAuditEntry(auditLogPath, entry3);

      const app = createApp(adminUser);

      const sinceRes = await app.request('/api/v2/audit?since=2026-08-05T11:00:00.000Z');
      const sinceBody = (await sinceRes.json()) as GatewayAuditListBody;
      expect(sinceBody.total).toBe(2);

      const untilRes = await app.request('/api/v2/audit?until=2026-08-05T10:30:00.000Z');
      const untilBody = (await untilRes.json()) as GatewayAuditListBody;
      expect(untilBody.total).toBe(1);

      const limitRes = await app.request('/api/v2/audit?limit=2');
      const limitBody = (await limitRes.json()) as GatewayAuditListBody;
      expect(limitBody.total).toBe(3);
      expect(limitBody.entries).toHaveLength(2);
      expect(limitBody.entries[0]!.type).toBe('rate_limited');
      expect(limitBody.entries[1]!.type).toBe('blocked');
    });

    it('доступен только ADMIN и AUDITOR (USER получает 403)', async () => {
      await writeAuditEntry(auditLogPath, entry1);

      const denied = await createApp(userUser).request('/api/v2/audit');
      expect(denied.status).toBe(403);

      const adminOk = await createApp(adminUser).request('/api/v2/audit');
      expect(adminOk.status).toBe(200);

      const auditorOk = await createApp(auditorUser).request('/api/v2/audit');
      expect(auditorOk.status).toBe(200);
    });

    it('не аутентифицирован → 401', async () => {
      const res = await createApp(null).request('/api/v2/audit');
      expect(res.status).toBe(401);
    });

    it('без deps.gatewayAudit путь `/` не монтируется (404)', async () => {
      const res = await createApp(adminUser, { withGatewayAudit: false }).request('/api/v2/audit');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v2/audit/revealed', () => {
    it('логирует раскрытие плейсхолдера в audit-файле', async () => {
      const res = await createApp(userUser).request('/api/v2/audit/revealed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses-1', placeholder: '⟦SYNTH_SECRET_1⟧' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body).toEqual({ ok: true });

      const { entries } = await readAuditLog(auditLogPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.type).toBe('revealed');
      expect(entries[0]!.sessionId).toBe('ses-1');
      expect(entries[0]!.userId).toBe('developer');
      expect(entries[0]!.placeholder).toBe('⟦SYNTH_SECRET_1⟧');
    });

    it('возвращает 400 для невалидного placeholder', async () => {
      const res = await createApp(userUser).request('/api/v2/audit/revealed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses-any', placeholder: 'не-плейсхолдер' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('возвращает 400 без sessionId/placeholder', async () => {
      const res = await createApp(userUser).request('/api/v2/audit/revealed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('возвращает 404 для несуществующей сессии', async () => {
      const res = await createApp(userUser, { sessionExists: async () => false })
        .request('/api/v2/audit/revealed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'ses-nope', placeholder: '⟦SYNTH_SECRET_1⟧' }),
        });
      expect(res.status).toBe(404);
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('доступен любому аутентифицированному (USER тоже)', async () => {
      const res = await createApp(userUser).request('/api/v2/audit/revealed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses-1', placeholder: '⟦SYNTH_SECRET_1⟧' }),
      });
      expect(res.status).toBe(200);
    });
  });
  /**
   * PROP-136 (слайс 136a): журнал исполнений команд.
   *
   * Реальный `CommandAuditLog` на временном каталоге: проверяются фильтры,
   * `limit` (строгий, ≤1000), retention-очистка и guard'ы.
   */
  describe('/api/v2/audit/commands', () => {
    /** Форма ответа `GET /api/v2/audit/commands`. */
    interface ListResponse {
      entries: CommandAuditEntry[];
      count: number;
    }

    function makeEntry(overrides: Partial<CommandAuditEntry> = {}): CommandAuditEntry {
      return {
        id: 'exec-1',
        ts: '2026-11-12T10:00:00.000Z',
        sessionId: 'ses-1',
        projectId: 'prj-1',
        actor: 'local',
        tool: 'execute_shell',
        command: 'ls -la',
        commandHash: sha256Hex('ls -la'),
        cwd: '/work',
        background: false,
        decision: 'allow',
        decidedBy: 'permission',
        phase: 'started',
        ...overrides,
      };
    }

    async function makeLog(entries: CommandAuditEntry[]): Promise<CommandAuditLog> {
      const log = createCommandAuditLog({
        dataDir: tmpDir,
        config: { enabled: true, path: join(tmpDir, 'commands.jsonl') },
        env: {},
      });
      for (const entry of entries) await log.append(entry);
      return log;
    }

    async function readList(res: Response): Promise<ListResponse> {
      return (await res.json()) as ListResponse;
    }

    async function readIds(res: Response): Promise<string[]> {
      return (await readList(res)).entries.map((entry) => entry.id);
    }

    async function readErrorCode(res: Response): Promise<string> {
      return ((await res.json()) as { error?: { code?: string } }).error?.code ?? '';
    }

    async function readRemoved(res: Response): Promise<number> {
      return ((await res.json()) as { removed: number }).removed;
    }

    it('нет журнала в deps — путь не монтируется (404)', async () => {
      const res = await createApp(adminUser).request('/api/v2/audit/commands');
      expect(res.status).toBe(404);
    });

    it('GET: свежие первыми + count', async () => {
      const log = await makeLog([
        makeEntry({ id: 'e1', ts: '2026-11-10T09:00:00.000Z' }),
        makeEntry({ id: 'e2', ts: '2026-11-11T09:00:00.000Z' }),
      ]);
      const res = await createApp(adminUser, { commandAudit: log }).request('/api/v2/audit/commands');
      expect(res.status).toBe(200);
      const body = await readList(res);
      expect(body.count).toBe(2);
      expect(body.entries.map((entry) => entry.id)).toEqual(['e2', 'e1']);
    });

    it('GET: фильтры session_id/project_id/decision/from/to', async () => {
      const log = await makeLog([
        makeEntry({ id: 'e1', ts: '2026-11-10T09:00:00.000Z', sessionId: 'ses-1' }),
        makeEntry({
          id: 'e2',
          ts: '2026-11-11T09:00:00.000Z',
          sessionId: 'ses-2',
          projectId: 'prj-2',
          decision: 'ask',
        }),
      ]);
      const app = createApp(adminUser, { commandAudit: log });

      expect(await readIds(await app.request('/api/v2/audit/commands?session_id=ses-2'))).toEqual(['e2']);
      expect(await readIds(await app.request('/api/v2/audit/commands?project_id=prj-1'))).toEqual(['e1']);
      expect(await readIds(await app.request('/api/v2/audit/commands?decision=ask'))).toEqual(['e2']);
      expect(await readIds(await app.request(
        '/api/v2/audit/commands?from=2026-11-11T00:00:00.000Z&to=2026-11-11T23:59:59.000Z',
      ))).toEqual(['e2']);
    });

    it('GET: limit обрезает, выше 1000 — клампится', async () => {
      const log = await makeLog([
        makeEntry({ id: 'e1', ts: '2026-11-10T09:00:00.000Z' }),
        makeEntry({ id: 'e2', ts: '2026-11-11T09:00:00.000Z' }),
      ]);
      const app = createApp(adminUser, { commandAudit: log });

      expect(await readIds(await app.request('/api/v2/audit/commands?limit=1'))).toEqual(['e2']);

      const clamped = await app.request('/api/v2/audit/commands?limit=5000');
      expect(clamped.status).toBe(200);
      expect((await readList(clamped)).count).toBe(2);
    });

    it('GET: битый limit/decision → 400', async () => {
      const log = await makeLog([makeEntry()]);
      const app = createApp(adminUser, { commandAudit: log });

      for (const query of ['limit=abc', 'limit=0', 'limit=-1', 'limit=1.5']) {
        const res = await app.request(`/api/v2/audit/commands?${query}`);
        expect(res.status, query).toBe(400);
        expect(await readErrorCode(res)).toBe('VALIDATION_ERROR');
      }

      const badDecision = await app.request('/api/v2/audit/commands?decision=maybe');
      expect(badDecision.status).toBe(400);
    });

    it('GET: только ADMIN/AUDITOR (USER → 403), аноним → 401', async () => {
      const log = await makeLog([makeEntry()]);
      expect((await createApp(userUser, { commandAudit: log }).request('/api/v2/audit/commands')).status).toBe(403);
      expect((await createApp(auditorUser, { commandAudit: log }).request('/api/v2/audit/commands')).status).toBe(200);
      expect((await createApp(null, { commandAudit: log }).request('/api/v2/audit/commands')).status).toBe(401);
    });

    it('DELETE ?older_than_days=N — prune и число удалённых', async () => {
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const fresh = new Date().toISOString();
      const log = await makeLog([
        makeEntry({ id: 'old', ts: old }),
        makeEntry({ id: 'fresh', ts: fresh }),
      ]);
      const res = await createApp(adminUser, { commandAudit: log })
        .request('/api/v2/audit/commands?older_than_days=30', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await readRemoved(res)).toBe(1);
      expect((await log.list()).map((entry) => entry.id)).toEqual(['fresh']);
    });

    it('DELETE: без/с невалидным older_than_days → 400', async () => {
      const log = await makeLog([makeEntry()]);
      const app = createApp(adminUser, { commandAudit: log });
      for (const query of ['', '?older_than_days=0', '?older_than_days=abc', '?older_than_days=-3']) {
        const res = await app.request(`/api/v2/audit/commands${query}`, { method: 'DELETE' });
        expect(res.status, query).toBe(400);
      }
      // Ничего не удалено.
      expect(await log.list()).toHaveLength(1);
    });

    it('DELETE: только ADMIN (AUDITOR/USER → 403)', async () => {
      const log = await makeLog([makeEntry()]);
      const del = async (user: User | null) => createApp(user, { commandAudit: log })
        .request('/api/v2/audit/commands?older_than_days=30', { method: 'DELETE' });

      expect((await del(auditorUser)).status).toBe(403);
      expect((await del(userUser)).status).toBe(403);
      expect((await del(null)).status).toBe(401);
      expect((await del(adminUser)).status).toBe(200);
    });
  });
});
