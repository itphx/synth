import { appendFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EgressRequestLogEntry, SecurityAuditEntry } from '@itphx/synth-shared';
import type {
  EgressRequestLogRepository,
  SecurityAuditRepository,
} from '../ports/index.js';

function auditEntry(id: string, over: Partial<SecurityAuditEntry> = {}): SecurityAuditEntry {
  return {
    id,
    ts: new Date().toISOString(),
    actor: 'admin',
    scope: 'tools',
    action: 'update',
    source: 'runtime',
    before: { mode: 'deny', list: [], exceptions: [] },
    after: { mode: 'allow', list: ['10.0.0.0/8'], exceptions: [] },
    version: 1,
    ...over,
  };
}

function egressEntry(id: string, over: Partial<EgressRequestLogEntry> = {}): EgressRequestLogEntry {
  return {
    id,
    ts: new Date().toISOString(),
    scope: 'web_fetch',
    host: 'example.com',
    url: 'https://example.com/',
    status: 'allowed',
    ...over,
  };
}

/**
 * Паспорт порта `SecurityAuditRepository` (аудит egress/security-политик):
 * append-only, «свежие первыми», фильтр `scope`/`limit`, `clear` с числом
 * удалённых. `filePath` — только для файловой реализации (повреждённая строка).
 */
export function describeSecurityAuditRepository(
  name: string,
  make: () => Promise<{
    repo: SecurityAuditRepository;
    dispose?: () => Promise<void>;
    filePath?: string;
  }>,
): void {
  describe(name, () => {
    it('пустой журнал — []; append → list возвращает запись', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.append(auditEntry('sa_1'));
      const list = await repo.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('sa_1');
      expect(list[0]!.scope).toBe('tools');
      expect(list[0]!.action).toBe('update');
      expect(list[0]!.after).toEqual(auditEntry('x').after);
    });

    it('порядок «свежие первыми»; фильтр scope и limit', async () => {
      const { repo } = await make();
      await repo.append(auditEntry('sa_1', { scope: 'tools' }));
      await repo.append(auditEntry('sa_2', { scope: 'webhooks' }));
      await repo.append(auditEntry('sa_3', { scope: 'tools' }));

      expect((await repo.list()).map((e) => e.id)).toEqual(['sa_3', 'sa_2', 'sa_1']);
      expect((await repo.list({ scope: 'tools' })).map((e) => e.id)).toEqual(['sa_3', 'sa_1']);
      expect((await repo.list({ limit: 2 })).map((e) => e.id)).toEqual(['sa_3', 'sa_2']);
      expect((await repo.list({ limit: 0 })).map((e) => e.id)).toEqual(['sa_3', 'sa_2', 'sa_1']);
    });

    it('clear возвращает число удалённых и опустошает журнал', async () => {
      const { repo } = await make();
      expect(await repo.clear()).toBe(0);
      await repo.append(auditEntry('sa_1'));
      await repo.append(auditEntry('sa_2'));
      expect(await repo.clear()).toBe(2);
      expect(await repo.list()).toEqual([]);
    });

    it('list отдаёт независимые копии', async () => {
      const { repo } = await make();
      await repo.append(auditEntry('sa_1'));
      const listed = await repo.list();
      (listed[0] as SecurityAuditEntry).actor = 'other';
      expect((await repo.list())[0]!.actor).toBe('admin');
    });

    it('файловая реализация: повреждённая строка не ломает list', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;
      await repo.append(auditEntry('sa_ok'));
      await appendFile(filePath, 'не-json\n', 'utf-8');
      expect((await repo.list()).map((e) => e.id)).toEqual(['sa_ok']);
    });

    it('файловая реализация: append создаёт каталог', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;
      await expect(stat(dirname(filePath))).rejects.toThrow();
      await repo.append(auditEntry('sa_1'));
      expect((await stat(dirname(filePath))).isDirectory()).toBe(true);
    });
  });
}

/**
 * Паспорт порта `EgressRequestLogRepository`: append-only журнал внешних
 * запросов, «свежие первыми», фильтры `scope`/`status`, `prune(days)` и `clear`.
 */
export function describeEgressRequestLogRepository(
  name: string,
  make: () => Promise<{
    repo: EgressRequestLogRepository;
    dispose?: () => Promise<void>;
    filePath?: string;
  }>,
): void {
  describe(name, () => {
    it('пустой журнал — []; append → list возвращает запись', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.append(egressEntry('eg_1'));
      const list = await repo.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('eg_1');
      expect(list[0]!.scope).toBe('web_fetch');
      expect(list[0]!.status).toBe('allowed');
    });

    it('порядок «свежие первыми»; фильтры scope/status и limit', async () => {
      const { repo } = await make();
      await repo.append(egressEntry('eg_1', { scope: 'web_fetch', status: 'allowed' }));
      await repo.append(egressEntry('eg_2', { scope: 'webhooks', status: 'blocked' }));
      await repo.append(egressEntry('eg_3', { scope: 'web_fetch', status: 'blocked' }));

      expect((await repo.list()).map((e) => e.id)).toEqual(['eg_3', 'eg_2', 'eg_1']);
      expect((await repo.list({ scope: 'web_fetch' })).map((e) => e.id)).toEqual(['eg_3', 'eg_1']);
      expect((await repo.list({ status: 'blocked' })).map((e) => e.id)).toEqual(['eg_3', 'eg_2']);
      expect((await repo.list({ limit: 2 })).map((e) => e.id)).toEqual(['eg_3', 'eg_2']);
    });

    it('prune(0) — no-op; prune удаляет записи старше срока', async () => {
      const { repo } = await make();
      const old = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
      const fresh = new Date().toISOString();
      await repo.append(egressEntry('eg_old', { ts: old }));
      await repo.append(egressEntry('eg_fresh', { ts: fresh }));

      expect(await repo.prune(0)).toBe(0);
      expect((await repo.list()).map((e) => e.id)).toEqual(['eg_fresh', 'eg_old']);
      expect(await repo.prune(1)).toBe(1);
      expect((await repo.list()).map((e) => e.id)).toEqual(['eg_fresh']);
    });

    it('clear возвращает число удалённых и опустошает журнал', async () => {
      const { repo } = await make();
      expect(await repo.clear()).toBe(0);
      await repo.append(egressEntry('eg_1'));
      await repo.append(egressEntry('eg_2'));
      expect(await repo.clear()).toBe(2);
      expect(await repo.list()).toEqual([]);
    });
  });
}
