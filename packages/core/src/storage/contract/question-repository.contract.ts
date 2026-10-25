import { describe, expect, it } from 'vitest';
import type { QuestionRecord, QuestionStatus } from '@itphx/synth-shared';
import type { QuestionRepository } from '../ports/index.js';

/**
 * Паспорт порта `QuestionRepository` (этап 1 roadmap 0.13 — блок 1.3, ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - upsert по `id` (`createdAt` не теряется, `updatedAt` — метка вызывающего),
 *   чтение, отсутствующая запись — `null`;
 * - список — «свежие первыми», фильтры по «И», потолок `limit`;
 * - `prune` — **только терминальные** записи, метка строго старше отсечки
 *   (граница `before` — равная метка сохраняется), повторный вызов
 *   идемпотентен (второй раз — 0).
 */
export function describeQuestionRepository(
  name: string,
  make: () => Promise<{ repo: QuestionRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустой репозиторий: список пуст, записи нет', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('qst-missing')).toBeNull();
    });

    it('upsert: создание и перезапись; createdAt иммутабельно, updatedAt — от вызывающего', async () => {
      const { repo } = await make();
      await repo.save(question('qst-1', { createdAt: '2026-01-01T00:00:00.000Z' }));
      const created = await repo.get('qst-1');
      expect(created?.sessionId).toBe('sess-1');
      expect(created?.status).toBe('pending');
      expect(created?.questions).toHaveLength(1);
      expect(created?.createdAt).toBe('2026-01-01T00:00:00.000Z');

      await repo.save(
        question('qst-1', {
          status: 'answered',
          answers: [['a']],
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      const updated = await repo.get('qst-1');
      expect(updated?.status).toBe('answered');
      expect(updated?.answers).toEqual([['a']]);
      // `createdAt` иммутабельно, `updatedAt` — метка вызывающего.
      expect(updated?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(updated?.updatedAt).toBe('2026-06-01T00:00:00.000Z');
      expect(Date.parse(updated?.updatedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(created?.updatedAt ?? ''),
      );
    });

    it('список: свежие первыми, фильтры по «И», потолок limit', async () => {
      const { repo } = await make();
      await repo.save(question('qst-1', { createdAt: '2026-01-01T00:00:00.000Z' }));
      await repo.save(
        question('qst-2', {
          createdAt: '2026-02-01T00:00:00.000Z',
          status: 'answered',
          sessionId: 'sess-2',
        }),
      );
      await repo.save(question('qst-3', { createdAt: '2026-03-01T00:00:00.000Z' }));

      expect((await repo.list()).map((q) => q.id)).toEqual(['qst-3', 'qst-2', 'qst-1']);
      expect((await repo.list({ sessionId: 'sess-2' })).map((q) => q.id)).toEqual(['qst-2']);
      expect((await repo.list({ status: 'pending' })).map((q) => q.id)).toEqual(['qst-3', 'qst-1']);
      // AND: сессия И статус.
      expect((await repo.list({ sessionId: 'sess-1', status: 'answered' })).map((q) => q.id)).toEqual(
        [],
      );
      expect((await repo.list({ sessionId: 'sess-2', status: 'answered' })).map((q) => q.id)).toEqual(
        ['qst-2'],
      );

      expect((await repo.list({ limit: 2 })).map((q) => q.id)).toEqual(['qst-3', 'qst-2']);
      expect((await repo.list({ limit: 1 })).map((q) => q.id)).toEqual(['qst-3']);
    });

    it('prune: только терминальные и строго старше отсечки; повтор — идемпотентно', async () => {
      const { repo } = await make();
      await repo.save(
        question('qst-pending', { updatedAt: '2026-01-01T00:00:00.000Z', status: 'pending' }),
      );
      await repo.save(
        question('qst-answered', { updatedAt: '2026-01-01T00:00:00.000Z', status: 'answered' }),
      );
      await repo.save(
        question('qst-cancelled', { updatedAt: '2026-01-01T00:00:00.000Z', status: 'cancelled' }),
      );
      await repo.save(
        question('qst-boundary', { updatedAt: '2026-02-01T00:00:00.000Z', status: 'answered' }),
      );

      // Отсечка равна метке записи — такая запись **не** старше отсечки и сохраняется.
      expect(await repo.prune('2026-02-01T00:00:00.000Z')).toBe(2);
      expect((await repo.list()).map((q) => q.id).sort()).toEqual(['qst-boundary', 'qst-pending']);

      // Повторный вызов — ничего не удаляет (идемпотентность).
      expect(await repo.prune('2026-02-01T00:00:00.000Z')).toBe(0);
      expect((await repo.list()).map((q) => q.id).sort()).toEqual(['qst-boundary', 'qst-pending']);
    });
  });
}

/** Запись вопроса для контрактного прогона. */
function question(id: string, overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  const status: QuestionStatus = overrides.status ?? 'pending';
  return {
    id,
    sessionId: 'sess-1',
    turnId: 'turn-1',
    questions: [
      {
        question: 'Какой вариант?',
        header: 'Выбор',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
    ],
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
