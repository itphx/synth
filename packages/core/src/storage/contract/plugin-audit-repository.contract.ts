import { appendFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginAuditEntry } from '@itphx/synth-shared';
import type { PluginAuditRepository } from '../ports/index.js';

/** Запись журнала плагинов для контрактного прогона. */
function entry(id: string, over: Partial<PluginAuditEntry> = {}): PluginAuditEntry {
  return {
    id,
    ts: new Date().toISOString(),
    actor: 'admin',
    scope: 'plugin',
    action: 'activate',
    plugin: 'demo-plugin',
    version: '1.0.0',
    outcome: 'ok',
    ...over,
  };
}

/**
 * Паспорт порта `PluginAuditRepository` (ADR-090, ADR-096): append-only
 * журнал, выборка «свежие первыми», фильтры `plugin`/`action`/`outcome`/`limit`,
 * очистка с числом удалённых.
 *
 * Кейсы с `filePath` — файл-специфичные (повреждённая строка, создание
 * каталога); для in-memory реализации `filePath` не задаётся и они пропускаются.
 */
export function describePluginAuditRepository(
  name: string,
  make: () => Promise<{
    repo: PluginAuditRepository;
    dispose?: () => Promise<void>;
    /** Путь к JSONL-файлу — только для файловой реализации. */
    filePath?: string;
  }>,
): void {
  describe(name, () => {
    it('пустой журнал — []; append → list возвращает запись', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.append(entry('pa_1'));
      const list = await repo.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('pa_1');
      expect(list[0]!.scope).toBe('plugin');
      expect(list[0]!.action).toBe('activate');
      expect(list[0]!.plugin).toBe('demo-plugin');
      expect(list[0]!.version).toBe('1.0.0');
      expect(list[0]!.outcome).toBe('ok');
    });

    it('порядок «свежие первыми»; фильтры plugin/action/outcome и limit', async () => {
      const { repo } = await make();
      await repo.append(entry('pa_1', { plugin: 'alpha' }));
      await repo.append(entry('pa_2', { plugin: 'beta', action: 'deactivate' }));
      await repo.append(entry('pa_3', { plugin: 'alpha', outcome: 'rejected' }));

      expect((await repo.list()).map((e) => e.id)).toEqual(['pa_3', 'pa_2', 'pa_1']);
      expect((await repo.list({ plugin: 'alpha' })).map((e) => e.id)).toEqual(['pa_3', 'pa_1']);
      expect((await repo.list({ action: 'deactivate' })).map((e) => e.id)).toEqual(['pa_2']);
      expect((await repo.list({ outcome: 'rejected' })).map((e) => e.id)).toEqual(['pa_3']);
      expect((await repo.list({ limit: 2 })).map((e) => e.id)).toEqual(['pa_3', 'pa_2']);
      expect(
        (await repo.list({ plugin: 'alpha', outcome: 'rejected', limit: 1 })).map((e) => e.id),
      ).toEqual(['pa_3']);
      // `limit <= 0`/не число — без ограничения.
      expect((await repo.list({ limit: 0 })).map((e) => e.id)).toEqual(['pa_3', 'pa_2', 'pa_1']);
    });

    it('запись сохраняет доверие/скан/hash/режим/причину без потерь', async () => {
      const { repo } = await make();
      await repo.append(
        entry('pa_1', {
          trustLevel: 'trusted',
          scanVerdict: 'caution',
          contentHash: 'a'.repeat(64),
          mode: 'inline',
          outcome: 'rejected',
          reason: 'plugin.trust_below_floor',
          source: 'npm',
        }),
      );
      const stored = (await repo.list())[0]!;
      expect(stored.trustLevel).toBe('trusted');
      expect(stored.scanVerdict).toBe('caution');
      expect(stored.contentHash).toBe('a'.repeat(64));
      expect(stored.mode).toBe('inline');
      expect(stored.reason).toBe('plugin.trust_below_floor');
      expect(stored.source).toBe('npm');
    });

    it('clear возвращает число удалённых и опустошает журнал', async () => {
      const { repo } = await make();
      expect(await repo.clear()).toBe(0);

      await repo.append(entry('pa_1'));
      await repo.append(entry('pa_2'));
      expect(await repo.clear()).toBe(2);
      expect(await repo.list()).toEqual([]);
      expect(await repo.clear()).toBe(0);
    });

    it('list отдаёт независимые копии (мутация не влияет на журнал)', async () => {
      const { repo } = await make();
      await repo.append(entry('pa_1'));
      const listed = await repo.list();
      listed[0]!.outcome = 'rejected';
      expect((await repo.list())[0]!.outcome).toBe('ok');
    });

    it('чтение не создаёт записей (журнал append-only: list — не действие над плагином)', async () => {
      const { repo } = await make();
      await repo.append(entry('pa_1'));

      // Несколько чтений подряд (в т.ч. с фильтрами) — журнал не растёт.
      await repo.list();
      await repo.list({ plugin: 'demo-plugin' });
      await repo.list({ action: 'activate', outcome: 'ok', limit: 10 });
      expect(await repo.list()).toHaveLength(1);
    });

    it('файловая реализация: повреждённая строка не ломает list', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      await repo.append(entry('pa_ok'));
      await appendFile(filePath, 'не-json-мусор\n', 'utf-8');
      expect((await repo.list()).map((e) => e.id)).toEqual(['pa_ok']);

      // Повреждённая строка не мешает дальнейшей дозаписи/чтению.
      await repo.append(entry('pa_next'));
      expect((await repo.list()).map((e) => e.id)).toEqual(['pa_next', 'pa_ok']);
    });

    it('файловая реализация: append создаёт каталог журнала', async () => {
      const { repo, filePath } = await make();
      if (!filePath) return;

      // До первой записи каталога `audit/` ещё нет.
      await expect(stat(dirname(filePath))).rejects.toThrow();
      await repo.append(entry('pa_1'));
      expect((await stat(dirname(filePath))).isDirectory()).toBe(true);
      expect((await repo.list()).map((e) => e.id)).toEqual(['pa_1']);
    });
  });
}
