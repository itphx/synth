import { describe, expect, it } from 'vitest';
import type { BackgroundRunRecord } from '@itphx/synth-shared';
import type { BackgroundRunRepository } from '../ports/index.js';

/**
 * Паспорт порта `BackgroundRunRepository` (этап 1 roadmap 0.13 — блок 1.2,
 * ADR-096; PROP-096/PROP-097).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - upsert по `id` (полная перезапись записи; `startedAt` иммутабельно,
 *   `updatedAt` — метка вызывающего), чтение, отсутствующая запись — `null`;
 * - список — «свежие первыми» (`startedAt` убыв.), фильтры по «И», потолок
 *   `limit`;
 * - `remove` — существующая запись удаляется, повтор — `false` (не ошибка);
 * - `prune` — **только терминальные** статусы, метка строго старше отсечки
 *   (граница `before` — равная метка сохраняется), нетерминальный `running`
 *   не удаляется никогда, повторный вызов идемпотентен (второй раз — 0).
 */
export function describeBackgroundRunRepository(
  name: string,
  make: () => Promise<{ repo: BackgroundRunRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустой репозиторий: список пуст, записи нет', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('bgr-missing')).toBeNull();
      expect(await repo.remove('bgr-missing')).toBe(false);
    });

    it('upsert: создание и перезапись; startedAt иммутабельно', async () => {
      const { repo } = await make();
      await repo.save(run('bgr-1', { startedAt: '2026-01-01T00:00:00.000Z' }));
      const created = await repo.get('bgr-1');
      expect(created?.kind).toBe('subagent');
      expect(created?.status).toBe('running');
      expect(created?.sessionId).toBe('sess-1');
      expect(created?.childSessionId).toBe('child-1');
      expect(created?.startedAt).toBe('2026-01-01T00:00:00.000Z');

      await repo.save(
        run('bgr-1', {
          status: 'completed',
          summary: 'готово',
          startedAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      const updated = await repo.get('bgr-1');
      expect(updated?.status).toBe('completed');
      expect(updated?.summary).toBe('готово');
      expect(updated?.startedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(updated?.updatedAt).toBe('2026-06-01T00:00:00.000Z');
    });

    it('список: свежие первыми (startedAt убыв.), фильтры по «И», потолок limit', async () => {
      const { repo } = await make();
      await repo.save(run('bgr-1', { startedAt: '2026-01-01T00:00:00.000Z' }));
      await repo.save(
        run('bgr-2', {
          startedAt: '2026-02-01T00:00:00.000Z',
          kind: 'process',
          status: 'failed',
          sessionId: 'sess-2',
          projectId: 'proj-1',
          command: 'npm run build',
        }),
      );
      await repo.save(run('bgr-3', { startedAt: '2026-03-01T00:00:00.000Z' }));

      expect((await repo.list()).map((r) => r.id)).toEqual(['bgr-3', 'bgr-2', 'bgr-1']);
      expect((await repo.list({ kind: 'process' })).map((r) => r.id)).toEqual(['bgr-2']);
      expect((await repo.list({ status: 'running' })).map((r) => r.id)).toEqual(['bgr-3', 'bgr-1']);
      expect((await repo.list({ sessionId: 'sess-2' })).map((r) => r.id)).toEqual(['bgr-2']);
      expect((await repo.list({ projectId: 'proj-1' })).map((r) => r.id)).toEqual(['bgr-2']);
      // AND: вид И статус.
      expect((await repo.list({ kind: 'process', status: 'running' })).map((r) => r.id)).toEqual([]);
      expect((await repo.list({ kind: 'process', status: 'failed' })).map((r) => r.id)).toEqual([
        'bgr-2',
      ]);

      expect((await repo.list({ limit: 2 })).map((r) => r.id)).toEqual(['bgr-3', 'bgr-2']);
      expect((await repo.list({ limit: 1 })).map((r) => r.id)).toEqual(['bgr-3']);
    });

    it('remove: удаляет запись; повтор — false (не ошибка)', async () => {
      const { repo } = await make();
      await repo.save(run('bgr-1'));
      expect(await repo.remove('bgr-1')).toBe(true);
      expect(await repo.get('bgr-1')).toBeNull();
      expect(await repo.remove('bgr-1')).toBe(false);
    });

    it('prune: только терминальные и строго старше отсечки; running не удаляется', async () => {
      const { repo } = await make();
      await repo.save(run('bgr-running', { updatedAt: '2026-01-01T00:00:00.000Z' }));
      await repo.save(
        run('bgr-completed', {
          updatedAt: '2026-01-01T00:00:00.000Z',
          status: 'completed',
        }),
      );
      await repo.save(
        run('bgr-failed', { updatedAt: '2026-01-01T00:00:00.000Z', status: 'failed' }),
      );
      await repo.save(
        run('bgr-boundary', { updatedAt: '2026-02-01T00:00:00.000Z', status: 'completed' }),
      );

      // Отсечка равна метке записи — такая запись **не** старше отсечки и сохраняется.
      expect(await repo.prune('2026-02-01T00:00:00.000Z')).toBe(2);
      expect((await repo.list()).map((r) => r.id).sort()).toEqual(['bgr-boundary', 'bgr-running']);

      // Повторный вызов — ничего не удаляет (идемпотентность).
      expect(await repo.prune('2026-02-01T00:00:00.000Z')).toBe(0);

      // Нетерминальный статус в списке статусов игнорируется: `running`
      // не удаляется никогда. `bgr-boundary` — терминальный и старше
      // новой отсечки, поэтому удаляется.
      expect(await repo.prune('2026-03-01T00:00:00.000Z', ['running', 'completed'])).toBe(1);
      expect((await repo.list()).map((r) => r.id)).toEqual(['bgr-running']);
    });
  });
}

/** Запись фонового прогона для контрактного прогона. */
function run(id: string, overrides: Partial<BackgroundRunRecord> = {}): BackgroundRunRecord {
  return {
    id,
    kind: 'subagent',
    status: 'running',
    sessionId: 'sess-1',
    childSessionId: 'child-1',
    agentRole: 'worker',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
