import { appendFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MaintenanceAuditEntry } from '@itphx/synth-shared';
import type { MaintenanceAuditRepository } from '../ports/index.js';

function entry(id: string, over: Partial<MaintenanceAuditEntry> = {}): MaintenanceAuditEntry {
  return {
    id,
    ts: new Date().toISOString(),
    op: 'backup.created',
    status: 'ok',
    ...over,
  };
}

/**
 * Паспорт порта `MaintenanceAuditRepository` (ADR-092): append-only журнал,
 * выборка «свежие первыми», фильтр `op`/`limit`, очистка с числом удалённых.
 * Кейсы с `filePath` — файл-специфичные (повреждённая строка, создание каталога);
 * для in-memory реализации `filePath` не задаётся и они пропускаются.
 */
export function describeMaintenanceAuditRepository(
  name: string,
  make: () => Promise<{
    repo: MaintenanceAuditRepository;
    dispose?: () => Promise<void>;
    /** Путь к JSONL-файлу — только для файловой реализации. */
    filePath?: string;
  }>,
): void {
  describe(name, () => {
    it('пустой журнал — []; append → list возвращает запись', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.append(entry('ma_1'));
      const list = await repo.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('ma_1');
      expect(list[0]!.op).toBe('backup.created');
      expect(list[0]!.status).toBe('ok');
    });

    it('порядок «свежие первыми»; фильтр op и limit', async () => {
      const { repo } = await make();
      await repo.append(entry('ma_1', { op: 'backup.created' }));
      await repo.append(entry('ma_2', { op: 'migrate.applied' }));
      await repo.append(entry('ma_3', { op: 'backup.created' }));

      expect((await repo.list()).map((e) => e.id)).toEqual(['ma_3', 'ma_2', 'ma_1']);
      expect((await repo.list({ op: 'backup.created' })).map((e) => e.id)).toEqual(['ma_3', 'ma_1']);
      expect((await repo.list({ limit: 2 })).map((e) => e.id)).toEqual(['ma_3', 'ma_2']);
      expect((await repo.list({ op: 'backup.created', limit: 1 })).map((e) => e.id)).toEqual(['ma_3']);
      // `limit <= 0`/не число — без ограничения.
      expect((await repo.list({ limit: 0 })).map((e) => e.id)).toEqual(['ma_3', 'ma_2', 'ma_1']);
    });

    it('clear возвращает число удалённых и опустошает журнал', async () => {
      const { repo } = await make();
      expect(await repo.clear()).toBe(0);

      await repo.append(entry('ma_1'));
      await repo.append(entry('ma_2'));
      expect(await repo.clear()).toBe(2);
      expect(await repo.list()).toEqual([]);
      expect(await repo.clear()).toBe(0);
    });

    it('list отдаёт независимые копии (мутация не влияет на журнал)', async () => {
      const { repo } = await make();
      await repo.append(entry('ma_1'));
      const listed = await repo.list();
      listed[0]!.status = 'failed';
      expect((await repo.list())[0]!.status).toBe('ok');
    });

    it('файловая реализация: повреждённая строка не ломает list', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      await repo.append(entry('ma_ok'));
      await appendFile(filePath, 'не-json-мусор\n', 'utf-8');
      expect((await repo.list()).map((e) => e.id)).toEqual(['ma_ok']);

      // Повреждённая строка не мешает дальнейшей дозаписи/чтению.
      await repo.append(entry('ma_next'));
      expect((await repo.list()).map((e) => e.id)).toEqual(['ma_next', 'ma_ok']);
    });

    it('файловая реализация: append создаёт каталог журнала', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      // До первой записи каталога `audit/` ещё нет.
      await expect(stat(dirname(filePath))).rejects.toThrow();
      await repo.append(entry('ma_1'));
      expect((await stat(dirname(filePath))).isDirectory()).toBe(true);
      expect((await repo.list()).map((e) => e.id)).toEqual(['ma_1']);
    });
  });
}
