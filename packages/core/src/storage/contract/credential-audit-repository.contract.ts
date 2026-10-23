import { appendFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExternalCredentialAuditEntry } from '@itphx/synth-shared';
import type { CredentialAuditRepository } from '../ports/index.js';

/** Запись журнала операций со слоем доступов для контрактного прогона. */
function entry(id: string, over: Partial<ExternalCredentialAuditEntry> = {}): ExternalCredentialAuditEntry {
  return {
    id,
    ts: new Date().toISOString(),
    op: 'issue',
    credentialId: 'extc_1',
    provider: 'demo',
    outcome: 'ok',
    ...over,
  };
}

/**
 * Паспорт порта `CredentialAuditRepository` (ADR-105 Ф4, ADR-096): append-only
 * журнал операций со слоем доступов, выборка «свежие первыми», фильтры
 * `credentialId`/`provider`/`op`/`outcome`/`limit`, очистка с числом удалённых.
 *
 * Кейсы с `filePath` — файл-специфичные (повреждённая строка, создание
 * каталога); для in-memory реализации `filePath` не задаётся и они пропускаются.
 */
export function describeCredentialAuditRepository(
  name: string,
  make: () => Promise<{
    repo: CredentialAuditRepository;
    dispose?: () => Promise<void>;
    /** Путь к JSONL-файлу — только для файловой реализации. */
    filePath?: string;
  }>,
): void {
  describe(name, () => {
    it('пустой журнал — []; append → list возвращает запись', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.append(entry('ca_1'));
      const list = await repo.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('ca_1');
      expect(list[0]!.op).toBe('issue');
      expect(list[0]!.credentialId).toBe('extc_1');
      expect(list[0]!.provider).toBe('demo');
      expect(list[0]!.outcome).toBe('ok');
    });

    it('порядок «свежие первыми»; фильтры credentialId/provider/op/outcome и limit', async () => {
      const { repo } = await make();
      await repo.append(entry('ca_1', { credentialId: 'extc_1', provider: 'alpha' }));
      await repo.append(entry('ca_2', { credentialId: 'extc_2', provider: 'beta', op: 'revoke' }));
      await repo.append(entry('ca_3', { credentialId: 'extc_1', outcome: 'error' }));

      expect((await repo.list()).map((e) => e.id)).toEqual(['ca_3', 'ca_2', 'ca_1']);
      expect((await repo.list({ credentialId: 'extc_1' })).map((e) => e.id)).toEqual(['ca_3', 'ca_1']);
      expect((await repo.list({ provider: 'beta' })).map((e) => e.id)).toEqual(['ca_2']);
      expect((await repo.list({ op: 'revoke' })).map((e) => e.id)).toEqual(['ca_2']);
      expect((await repo.list({ outcome: 'error' })).map((e) => e.id)).toEqual(['ca_3']);
      expect((await repo.list({ limit: 2 })).map((e) => e.id)).toEqual(['ca_3', 'ca_2']);
      expect(
        (await repo.list({ credentialId: 'extc_1', outcome: 'error', limit: 1 })).map((e) => e.id),
      ).toEqual(['ca_3']);
      // `limit <= 0`/не число — без ограничения.
      expect((await repo.list({ limit: 0 })).map((e) => e.id)).toEqual(['ca_3', 'ca_2', 'ca_1']);
    });

    it('все операции журнала сохраняются без потерь', async () => {
      const { repo } = await make();
      for (const op of ['issue', 'refresh', 'revoke', 'bind', 'use'] as const) {
        await repo.append(entry(`ca_${op}`, { op, connectorId: 'mcp-1' }));
      }
      const list = await repo.list();
      expect(list.map((e) => e.op)).toEqual(['use', 'bind', 'revoke', 'refresh', 'issue']);
      expect(list.every((e) => e.connectorId === 'mcp-1')).toBe(true);
    });

    it('запись сохраняет код ошибки и коннектор без потерь', async () => {
      const { repo } = await make();
      await repo.append(
        entry('ca_1', {
          op: 'refresh',
          outcome: 'error',
          errorCode: 'invalid_grant',
          connectorId: 'mcp-1',
        }),
      );
      const stored = (await repo.list())[0]!;
      expect(stored.errorCode).toBe('invalid_grant');
      expect(stored.connectorId).toBe('mcp-1');
      expect(stored.outcome).toBe('error');
    });

    it('clear возвращает число удалённых и опустошает журнал', async () => {
      const { repo } = await make();
      expect(await repo.clear()).toBe(0);

      await repo.append(entry('ca_1'));
      await repo.append(entry('ca_2'));
      expect(await repo.clear()).toBe(2);
      expect(await repo.list()).toEqual([]);
      expect(await repo.clear()).toBe(0);
    });

    it('list отдаёт независимые копии (мутация не влияет на журнал)', async () => {
      const { repo } = await make();
      await repo.append(entry('ca_1'));
      const listed = await repo.list();
      listed[0]!.outcome = 'error';
      expect((await repo.list())[0]!.outcome).toBe('ok');
    });

    it('файловая реализация: повреждённая строка не ломает list', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      await repo.append(entry('ca_ok'));
      await appendFile(filePath, 'не-json-мусор\n', 'utf-8');
      expect((await repo.list()).map((e) => e.id)).toEqual(['ca_ok']);

      // Повреждённая строка не мешает дальнейшей дозаписи/чтению.
      await repo.append(entry('ca_next'));
      expect((await repo.list()).map((e) => e.id)).toEqual(['ca_next', 'ca_ok']);
    });

    it('файловая реализация: append создаёт каталог журнала', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      // До первой записи каталога `audit/` ещё нет.
      await expect(stat(dirname(filePath))).rejects.toThrow();
      await repo.append(entry('ca_1'));
      expect((await stat(dirname(filePath))).isDirectory()).toBe(true);
      expect((await repo.list()).map((e) => e.id)).toEqual(['ca_1']);
    });
  });
}
