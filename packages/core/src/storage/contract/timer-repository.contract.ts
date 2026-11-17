import { describe, expect, it } from 'vitest';
import type { TimerFiring } from '@itphx/synth-shared';
import type { TimerFiringRepository, TimerRepository } from '../ports/index.js';

/**
 * Паспорт портов `TimerRepository`/`TimerFiringRepository` (PROP-141, Часть B;
 * ADR-096 — слой хранения).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - `create` — запись с id `tmr_<uuid>`, таймстемпы заданы, статус по
 *   умолчанию — `active`;
 * - `get` — чтение по `id`, отсутствующая запись — `null`;
 * - `update` — частичная правка (`comment`/`name`/`firesAt`/…), `updatedAt`
 *   меняется, неизменяемые поля не трогаются, отсутствующая запись — `null`;
 * - `setStatus` — смена статуса (+ доводок `firedAt`), отсутствующая — `null`;
 * - `remove` — существующая запись удаляется, повтор — `false` (не ошибка);
 * - `removeBySession` — каскад по сессии, чужие сессии не задеты;
 * - `list` — фильтры по «И», порядок «по ближайшему срабатыванию»
 *   (`firesAt` возраст.), постраничный срез (`offset`/`limit`);
 * - `listDue` — только активные с `firesAt <= at`, порядок тот же;
 * - `countActive` — счётчик активных таймеров сессии (неактивные не считаются);
 * - история срабатываний: `append`/`list` (порядок добавления, `limit` —
 *   последние N)/`prune` (строго старше отсечки, идемпотентно).
 */
export function describeTimerRepository(
  name: string,
  make: () => Promise<{ repo: TimerRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустой репозиторий: список пуст, записи нет', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('tmr-missing')).toBeNull();
      expect(await repo.remove('tmr-missing')).toBe(false);
      expect(await repo.countActive('sess-1')).toBe(0);
      expect(await repo.listDue('2030-01-01T00:00:00.000Z')).toEqual([]);
    });

    it('create: запись с id/tаймстемпами, статус по умолчанию — active', async () => {
      const { repo } = await make();
      const created = await repo.create(timerInput({ comment: 'проверить сборку' }));
      expect(created.id.startsWith('tmr_')).toBe(true);
      expect(created.status).toBe('active');
      expect(created.kind).toBe('timer');
      expect(created.comment).toBe('проверить сборку');
      expect(created.projectId).toBe('proj-1');
      expect(created.sessionId).toBe('sess-1');
      expect(created.ownerId).toBe('user-1');
      expect(created.firesAt).toBe('2026-01-01T00:00:00.000Z');
      expect(created.createdAt).toBeTruthy();
      expect(created.updatedAt).toBe(created.createdAt);

      const loaded = await repo.get(created.id);
      expect(loaded?.id).toBe(created.id);
      expect(loaded?.comment).toBe('проверить сборку');
    });

    it('update: частичная правка; updatedAt меняется, id неизменен', async () => {
      const { repo } = await make();
      const created = await repo.create(timerInput({ comment: 'старое' }));

      const updated = await repo.update(created.id, {
        comment: 'новое',
        name: 'Сборка',
        firesAt: '2026-02-01T10:00:00.000Z',
      });
      expect(updated?.comment).toBe('новое');
      expect(updated?.name).toBe('Сборка');
      expect(updated?.firesAt).toBe('2026-02-01T10:00:00.000Z');
      expect(updated?.id).toBe(created.id);
      expect(updated?.projectId).toBe('proj-1');
      expect(updated?.sessionId).toBe('sess-1');
      expect(updated?.ownerId).toBe('user-1');
      expect(updated?.createdAt).toBe(created.createdAt);
      expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));

      // Отсутствующая запись — `null` (не ошибка).
      expect(await repo.update('tmr-missing', { comment: 'x' })).toBeNull();
    });

    it('setStatus: смена статуса (+ firedAt); отсутствующая — null', async () => {
      const { repo } = await make();
      const created = await repo.create(timerInput());

      const fired = await repo.setStatus(created.id, 'fired', {
        firedAt: '2026-01-01T00:00:05.000Z',
      });
      expect(fired?.status).toBe('fired');
      expect(fired?.firedAt).toBe('2026-01-01T00:00:05.000Z');

      const paused = await repo.setStatus(created.id, 'paused');
      expect(paused?.status).toBe('paused');

      expect(await repo.setStatus('tmr-missing', 'cancelled')).toBeNull();
    });

    it('remove: удаляет запись; повтор — false (не ошибка)', async () => {
      const { repo } = await make();
      const created = await repo.create(timerInput());
      expect(await repo.remove(created.id)).toBe(true);
      expect(await repo.get(created.id)).toBeNull();
      expect(await repo.remove(created.id)).toBe(false);
    });

    it('removeBySession: каскад по сессии; чужие сессии не задеты', async () => {
      const { repo } = await make();
      const a = await repo.create(timerInput({ sessionId: 'sess-1' }));
      await repo.create(timerInput({ sessionId: 'sess-1' }));
      const b = await repo.create(timerInput({ sessionId: 'sess-2' }));

      expect(await repo.removeBySession('sess-1')).toBe(2);
      expect(await repo.get(a.id)).toBeNull();
      expect(await repo.get(b.id)).not.toBeNull();

      // Повтор — 0 (идемпотентно).
      expect(await repo.removeBySession('sess-1')).toBe(0);
    });

    it('list: фильтры по «И», порядок по ближайшему срабатыванию, постраничный срез', async () => {
      const { repo } = await make();
      const t1 = await repo.create(
        timerInput({ firesAt: '2026-03-01T00:00:00.000Z', kind: 'alarm' }),
      );
      const t2 = await repo.create(
        timerInput({ firesAt: '2026-01-01T00:00:00.000Z', status: 'paused' }),
      );
      const t3 = await repo.create(
        timerInput({
          firesAt: '2026-02-01T00:00:00.000Z',
          projectId: 'proj-2',
          sessionId: 'sess-2',
          kind: 'alarm',
        }),
      );

      // Порядок — по `firesAt` возраст.
      expect((await repo.list()).map((t) => t.id)).toEqual([t2.id, t3.id, t1.id]);

      expect((await repo.list({ sessionId: 'sess-1' })).map((t) => t.id)).toEqual([t2.id, t1.id]);
      expect((await repo.list({ projectId: 'proj-2' })).map((t) => t.id)).toEqual([t3.id]);
      expect((await repo.list({ kind: 'alarm' })).map((t) => t.id)).toEqual([t3.id, t1.id]);
      expect((await repo.list({ status: 'paused' })).map((t) => t.id)).toEqual([t2.id]);
      // AND: вид И статус.
      expect(await repo.list({ kind: 'alarm', status: 'paused' })).toEqual([]);

      // Постраничный срез: смещение, затем потолок.
      expect((await repo.list({ limit: 2 })).map((t) => t.id)).toEqual([t2.id, t3.id]);
      expect((await repo.list({ limit: 1 })).map((t) => t.id)).toEqual([t2.id]);
      expect((await repo.list({ offset: 1 })).map((t) => t.id)).toEqual([t3.id, t1.id]);
      expect((await repo.list({ offset: 1, limit: 1 })).map((t) => t.id)).toEqual([t3.id]);
    });

    it('listDue: только активные с firesAt <= at, порядок тот же', async () => {
      const { repo } = await make();
      const overdue = await repo.create(
        timerInput({ firesAt: '2026-01-01T00:00:00.000Z' }),
      );
      const later = await repo.create(timerInput({ firesAt: '2026-05-01T00:00:00.000Z' }));
      const paused = await repo.create(
        timerInput({ firesAt: '2026-01-01T00:00:00.000Z', status: 'paused' }),
      );
      const cancelled = await repo.create(
        timerInput({ firesAt: '2026-01-01T00:00:00.000Z', status: 'cancelled' }),
      );

      const due = await repo.listDue('2026-02-01T00:00:00.000Z');
      expect(due.map((t) => t.id)).toEqual([overdue.id]);
      expect(due.map((t) => t.id)).not.toContain(paused.id);
      expect(due.map((t) => t.id)).not.toContain(cancelled.id);
      expect(due.map((t) => t.id)).not.toContain(later.id);

      // Граница: `firesAt == at` — тоже «пора».
      const boundary = await repo.create(
        timerInput({ firesAt: '2026-02-01T00:00:00.000Z' }),
      );
      expect((await repo.listDue('2026-02-01T00:00:00.000Z')).map((t) => t.id)).toContain(
        boundary.id,
      );
    });

    it('countActive: считает только активные таймеры сессии', async () => {
      const { repo } = await make();
      await repo.create(timerInput({ sessionId: 'sess-1' }));
      await repo.create(timerInput({ sessionId: 'sess-1' }));
      await repo.create(timerInput({ sessionId: 'sess-1', status: 'paused' }));
      await repo.create(timerInput({ sessionId: 'sess-2' }));

      expect(await repo.countActive('sess-1')).toBe(2);
      expect(await repo.countActive('sess-2')).toBe(1);
      expect(await repo.countActive('sess-none')).toBe(0);
    });
  });
}

/**
 * Паспорт порта истории срабатываний таймеров: порядок добавления, потолок
 * `limit` (последние N) и retention-очистка (строго старше отсечки).
 */
export function describeTimerFiringRepository(
  name: string,
  make: () => Promise<{ repo: TimerFiringRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустой журнал: список пуст', async () => {
      const { repo } = await make();
      expect(await repo.list('tmr-1')).toEqual([]);
    });

    it('append/list: порядок добавления (старые → новые), limit — последние N', async () => {
      const { repo } = await make();
      await repo.append(firing('tmf-1', 'tmr-1', '2026-01-01T00:00:01.000Z'));
      await repo.append(firing('tmf-2', 'tmr-1', '2026-01-01T00:00:02.000Z'));
      await repo.append(firing('tmf-3', 'tmr-2', '2026-01-01T00:00:03.000Z'));

      expect((await repo.list('tmr-1')).map((f) => f.id)).toEqual(['tmf-1', 'tmf-2']);
      expect((await repo.list('tmr-2')).map((f) => f.id)).toEqual(['tmf-3']);
      expect((await repo.list('tmr-1', 1)).map((f) => f.id)).toEqual(['tmf-2']);
      expect((await repo.list('tmr-1', 5)).map((f) => f.id)).toEqual(['tmf-1', 'tmf-2']);
    });

    it('запись срабатывания сохраняет поля исхода', async () => {
      const { repo } = await make();
      await repo.append({
        id: 'tmf-1',
        timerId: 'tmr-1',
        firedAt: '2026-01-01T00:00:07.000Z',
        scheduledFor: '2026-01-01T00:00:00.000Z',
        lagMs: 7000,
        outcome: 'ok',
        sessionId: 'sess-1',
      });

      const [record] = await repo.list('tmr-1');
      expect(record?.firedAt).toBe('2026-01-01T00:00:07.000Z');
      expect(record?.scheduledFor).toBe('2026-01-01T00:00:00.000Z');
      expect(record?.lagMs).toBe(7000);
      expect(record?.outcome).toBe('ok');
      expect(record?.sessionId).toBe('sess-1');
    });

    it('prune: строго старше отсечки; повтор — 0 (идемпотентно)', async () => {
      const { repo } = await make();
      await repo.append(firing('tmf-1', 'tmr-1', '2026-01-01T00:00:00.000Z'));
      await repo.append(firing('tmf-2', 'tmr-1', '2026-02-01T00:00:00.000Z'));
      await repo.append(firing('tmf-3', 'tmr-1', '2026-03-01T00:00:00.000Z'));

      // Отсечка равна метке записи — такая запись **не** старше отсечки.
      expect(await repo.prune('2026-02-01T00:00:00.000Z')).toBe(1);
      expect((await repo.list('tmr-1')).map((f) => f.id)).toEqual(['tmf-2', 'tmf-3']);

      // Повторный вызов — ничего не удаляет.
      expect(await repo.prune('2026-02-01T00:00:00.000Z')).toBe(0);

      // Более поздняя отсечка удаляет оставшиеся старые записи.
      expect(await repo.prune('2026-04-01T00:00:00.000Z')).toBe(2);
      expect(await repo.list('tmr-1')).toEqual([]);
    });
  });
}

/** Вход создания таймера для контрактного прогона. */
function timerInput(
  overrides: Partial<Parameters<TimerRepository['create']>[0]> = {},
): Parameters<TimerRepository['create']>[0] {
  return {
    kind: 'timer',
    comment: 'проверить сборку',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    ownerId: 'user-1',
    repeat: { mode: 'once' },
    firesAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Запись срабатывания для контрактного прогона. */
function firing(id: string, timerId: string, firedAt: string): TimerFiring {
  return {
    id,
    timerId,
    firedAt,
    scheduledFor: firedAt,
    lagMs: 0,
    outcome: 'ok',
    sessionId: 'sess-1',
  };
}
