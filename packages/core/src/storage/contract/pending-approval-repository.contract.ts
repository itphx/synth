import { describe, expect, it } from 'vitest';
import type {
  PendingApprovalRecord,
  PendingApprovalRepository,
} from '../ports/index.js';

/**
 * Паспорт порта `PendingApprovalRepository` (ADR-029, ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - upsert по `approvalId` (полная перезапись записи), чтение по списку;
 * - фильтр по сессии (`list(sessionId)`) и общий список (`list()`);
 * - `delete` — идемпотентно (удаление отсутствующей записи — не ошибка);
 * - `clear` — число снятых записей, чужие сессии не трогаются;
 * - «редкая» запись (без необязательных полей) читается без потерь;
 * - запись ожидания **не зависит** от документа сессии (отдельный стор).
 */
export function describePendingApprovalRepository(
  name: string,
  make: () => Promise<{ repo: PendingApprovalRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустой репозиторий: список пуст', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.list('s1')).toEqual([]);
    });

    it('upsert: создание и перезапись записи по approvalId', async () => {
      const { repo } = await make();
      await repo.save(record('ap-1'));

      let stored = (await repo.list('s1'))[0];
      expect(stored?.approvalId).toBe('ap-1');
      expect(stored?.sessionId).toBe('s1');
      expect(stored?.toolName).toBe('execute_shell');
      expect(stored?.arguments).toEqual({ command: 'ls -la' });
      expect(stored?.reason).toBe('правило shell.* → ask');
      expect(stored?.timeoutMs).toBe(5000);
      expect(stored?.askedAt).toBe('2026-01-01T00:00:00.000Z');

      // Перезапись — полная: запись по-прежнему одна, поля обновились.
      await repo.save(record('ap-1', { toolName: 'read_file', arguments: { path: 'a.txt' } }));
      stored = (await repo.list('s1'))[0];
      expect(stored?.toolName).toBe('read_file');
      expect(stored?.arguments).toEqual({ path: 'a.txt' });
      expect((await repo.list()).filter((r) => r.approvalId === 'ap-1')).toHaveLength(1);
    });

    it('список: фильтр по сессии и общий список', async () => {
      const { repo } = await make();
      await repo.save(record('ap-1'));
      await repo.save(record('ap-2', { sessionId: 's2' }));

      expect((await repo.list('s1')).map((r) => r.approvalId)).toEqual(['ap-1']);
      expect((await repo.list('s2')).map((r) => r.approvalId)).toEqual(['ap-2']);
      expect((await repo.list()).map((r) => r.approvalId).sort()).toEqual(['ap-1', 'ap-2']);
    });

    it('delete: запись удаляется, повторный вызов — не ошибка', async () => {
      const { repo } = await make();
      await repo.save(record('ap-1'));

      await repo.delete('ap-1');
      expect(await repo.list()).toEqual([]);

      // Идемпотентность: удаление отсутствующей записи — не ошибка.
      await expect(repo.delete('ap-1')).resolves.toBeUndefined();
      await expect(repo.delete('ap-never-existed')).resolves.toBeUndefined();
    });

    it('clear: снимает записи сессии (или все), чужие не трогает', async () => {
      const { repo } = await make();
      await repo.save(record('ap-1'));
      await repo.save(record('ap-2'));
      await repo.save(record('ap-3', { sessionId: 's2' }));

      expect(await repo.clear('s1')).toBe(2);
      expect((await repo.list()).map((r) => r.approvalId)).toEqual(['ap-3']);

      // Повторный вызов — 0 (записей сессии уже нет).
      expect(await repo.clear('s1')).toBe(0);
      // Чужая сессия не тронута.
      expect(await repo.clear('s-none')).toBe(0);
      expect((await repo.list()).map((r) => r.approvalId)).toEqual(['ap-3']);

      // Без фильтра — снимаются все.
      expect(await repo.clear()).toBe(1);
      expect(await repo.list()).toEqual([]);
    });

    it('запись без необязательных полей читается без потерь', async () => {
      const { repo } = await make();
      const sparse: PendingApprovalRecord = {
        approvalId: 'ap-sparse',
        sessionId: 's1',
        toolName: 'execute_shell',
        arguments: {},
        reason: '',
        askedAt: '2026-01-01T00:00:00.000Z',
        timeoutMs: 0,
      };
      await repo.save(sparse);
      const loaded = (await repo.list('s1'))[0];
      expect(loaded).toEqual(sparse);
      expect(loaded?.ownerId).toBeUndefined();
      expect(loaded?.trigger).toBeUndefined();
      expect(loaded?.turnId).toBeUndefined();
      expect(loaded?.principal).toBeUndefined();
    });

    it('структурная причина ask\'а («виновник») сохраняется', async () => {
      const { repo } = await make();
      await repo.save(record('ap-trigger', {
        trigger: {
          messageId: 'ask-protected-path',
          params: { path: '/etc/passwd' },
          matchedRule: 'protected_paths',
          askKind: 'protected',
        },
        turnId: 'turn-1',
        principal: 'user-1',
        ownerId: 'user-1',
      }));

      const loaded = (await repo.list('s1'))[0];
      expect(loaded?.trigger).toEqual({
        messageId: 'ask-protected-path',
        params: { path: '/etc/passwd' },
        matchedRule: 'protected_paths',
        askKind: 'protected',
      });
      expect(loaded?.turnId).toBe('turn-1');
      expect(loaded?.principal).toBe('user-1');
      expect(loaded?.ownerId).toBe('user-1');
    });
  });
}

/** Запись ожидания для контрактного прогона. */
function record(
  approvalId: string,
  overrides: Partial<PendingApprovalRecord> = {},
): PendingApprovalRecord {
  return {
    approvalId,
    sessionId: 's1',
    toolName: 'execute_shell',
    arguments: { command: 'ls -la' },
    reason: 'правило shell.* → ask',
    askedAt: '2026-01-01T00:00:00.000Z',
    timeoutMs: 5000,
    ...overrides,
  };
}
