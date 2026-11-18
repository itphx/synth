/**
 * Реестр активных (блокирующих) прогонов — ADR-111 §detach.
 *
 * Проверяем контракт, на который опирается `POST /api/v2/sessions/:id/background`:
 * регистрация/снятие, фильтр по виду, изоляция ошибок и идемпотентность.
 */
import { describe, it, expect, vi } from 'vitest';
import { ActiveRunRegistry } from './active-runs.js';
import type { ActiveRunHandle } from './active-runs.js';
import { BackgroundLimitExceededError } from './types.js';

/** Хэндл с наблюдаемым `detach`. */
function makeRun(id: string, kind: ActiveRunHandle['kind'] = 'subagent', title?: string) {
  const detach = vi.fn(async () => {});
  const handle: ActiveRunHandle = { id, kind, ...(title ? { title } : {}), detach };
  return { handle, detach };
}

describe('ActiveRunRegistry — регистрация и список', () => {
  it('register/list группируют прогоны по сессии', () => {
    const registry = new ActiveRunRegistry();
    const a = makeRun('child-a');
    const b = makeRun('proc-b', 'process');

    registry.register('s1', a.handle);
    registry.register('s2', b.handle);

    expect(registry.list('s1').map((r) => r.id)).toEqual(['child-a']);
    expect(registry.list('s2').map((r) => r.id)).toEqual(['proc-b']);
    // Чужая/неизвестная сессия — пусто.
    expect(registry.list('s3')).toEqual([]);
  });

  it('unregister идемпотентен: повторное снятие ничего не ломает', () => {
    const registry = new ActiveRunRegistry();
    const run = makeRun('child-a');
    const unregister = registry.register('s1', run.handle);

    unregister();
    unregister();
    expect(registry.list('s1')).toEqual([]);
  });

  it('unregister снимает только «свой» хэндл (перерегистрация того же id)', () => {
    const registry = new ActiveRunRegistry();
    const first = makeRun('child-a');
    const second = makeRun('child-a');

    const unregisterFirst = registry.register('s1', first.handle);
    registry.register('s1', second.handle);
    // Второй прогон той же дочерней сессии вытеснил первый.
    expect(registry.list('s1')).toEqual([second.handle]);

    unregisterFirst();
    expect(registry.list('s1')).toEqual([second.handle]);
  });
});

describe('ActiveRunRegistry — detachAll', () => {
  it('переводит все прогоны сессии и отдаёт сводку', async () => {
    const registry = new ActiveRunRegistry();
    const sub = makeRun('child-a', 'subagent', 'Изучить репозиторий');
    const proc = makeRun('proc-b', 'process', 'npm test');
    registry.register('s1', sub.handle);
    registry.register('s1', proc.handle);

    const result = await registry.detachAll('s1');

    expect(sub.detach).toHaveBeenCalledTimes(1);
    expect(proc.detach).toHaveBeenCalledTimes(1);
    expect(result.failed).toEqual([]);
    expect(result.detached).toEqual([
      { id: 'child-a', kind: 'subagent', title: 'Изучить репозиторий' },
      { id: 'proc-b', kind: 'process', title: 'npm test' },
    ]);
  });

  it('фильтр по виду: переводит только запрошенный тип', async () => {
    const registry = new ActiveRunRegistry();
    const sub = makeRun('child-a', 'subagent');
    const proc = makeRun('proc-b', 'process');
    registry.register('s1', sub.handle);
    registry.register('s1', proc.handle);

    const result = await registry.detachAll('s1', { type: 'process' });

    expect(sub.detach).not.toHaveBeenCalled();
    expect(proc.detach).toHaveBeenCalledTimes(1);
    expect(result.detached).toEqual([{ id: 'proc-b', kind: 'process' }]);
  });

  it('причина перевода: по умолчанию `user`, из фильтра — переданная', async () => {
    const registry = new ActiveRunRegistry();
    const manual = makeRun('child-a');
    const intervened = makeRun('child-b');
    registry.register('s1', manual.handle);
    registry.register('s2', intervened.handle);

    // Ручной перевод (`POST /sessions/:id/background`) причину не передаёт.
    await registry.detachAll('s1');
    expect(manual.detach).toHaveBeenCalledWith('user');

    // Авто-detach при вмешательстве — `'message'`.
    await registry.detachAll('s2', { reason: 'message' });
    expect(intervened.detach).toHaveBeenCalledWith('message');
  });

  it('ошибка одного detach не мешает остальным и попадает в failed', async () => {
    const registry = new ActiveRunRegistry();
    const failing = makeRun('child-a');
    const ok = makeRun('child-b');
    failing.detach.mockRejectedValue(new Error('boom'));
    registry.register('s1', failing.handle);
    registry.register('s1', ok.handle);

    const result = await registry.detachAll('s1');

    expect(ok.detach).toHaveBeenCalledTimes(1);
    expect(result.detached).toEqual([{ id: 'child-b', kind: 'subagent' }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      id: 'child-a',
      kind: 'subagent',
      code: 'DETACH_FAILED',
      message: 'boom',
    });
  });

  it('лимит фоновых прогонов → failed[code=BACKGROUND_LIMIT]', async () => {
    const registry = new ActiveRunRegistry();
    const limited = makeRun('child-a');
    limited.detach.mockRejectedValue(
      new BackgroundLimitExceededError('subagents', 2, 'Превышен лимит фоновых саб-агентов'),
    );
    registry.register('s1', limited.handle);

    const result = await registry.detachAll('s1');

    expect(result.detached).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.code).toBe('BACKGROUND_LIMIT');
    expect(result.failed[0]!.message).toContain('лимит');
  });

  it('повторный detachAll того же прогона — no-op (detach вызван один раз)', async () => {
    const registry = new ActiveRunRegistry();
    const run = makeRun('child-a');
    registry.register('s1', run.handle);

    await registry.detachAll('s1');
    const second = await registry.detachAll('s1');

    expect(run.detach).toHaveBeenCalledTimes(1);
    expect(second.detached).toEqual([]);
    expect(second.failed).toEqual([]);
  });

  it('unregister во время detach не ломает обход снимка', async () => {
    const registry = new ActiveRunRegistry();
    const first = makeRun('child-a');
    const second = makeRun('child-b');
    registry.register('s1', first.handle);
    const unregisterSecond = registry.register('s1', second.handle);
    // Первый прогон снимается с регистрации ровно в момент своего detach.
    first.detach.mockImplementation(async () => { unregisterSecond(); });

    const result = await registry.detachAll('s1');

    expect(first.detach).toHaveBeenCalledTimes(1);
    expect(second.detach).toHaveBeenCalledTimes(1);
    // Снятый с регистрации прогон из снимка всё равно переведён, а сам реестр
    // больше его не показывает (снял владелец прогона).
    expect(registry.list('s1').map((r) => r.id)).toEqual(['child-a']);
    expect(result.failed).toEqual([]);
    expect(result.detached.map((r) => r.id)).toEqual(['child-a', 'child-b']);
  });

  it('после неудачи повторный detach разрешён (лимит мог освободиться)', async () => {
    const registry = new ActiveRunRegistry();
    const run = makeRun('child-a');
    run.detach.mockRejectedValueOnce(new Error('temporary'));
    registry.register('s1', run.handle);

    const first = await registry.detachAll('s1');
    expect(first.failed).toHaveLength(1);

    const second = await registry.detachAll('s1');
    expect(second.detached).toEqual([{ id: 'child-a', kind: 'subagent' }]);
    expect(run.detach).toHaveBeenCalledTimes(2);
  });
});

describe('ActiveRunRegistry — снимок нескольких сессий', () => {
  it('listForSessions отдаёт прогоны только переданных сессий, в порядке регистрации', () => {
    const registry = new ActiveRunRegistry();
    const a = makeRun('child-a');
    const b = makeRun('proc-b', 'process');
    const c = makeRun('child-c');
    registry.register('s1', a.handle);
    registry.register('s1', b.handle);
    registry.register('s2', c.handle);

    expect(registry.listForSessions(['s1']).map((r) => r.id)).toEqual(['child-a', 'proc-b']);
    expect(registry.listForSessions(['s2', 's1']).map((r) => r.id)).toEqual([
      'child-c',
      'child-a',
      'proc-b',
    ]);
    expect(registry.listForSessions([])).toEqual([]);
  });

  it('listForSessions не дублирует сессии и хэндлы', () => {
    const registry = new ActiveRunRegistry();
    const run = makeRun('child-a');
    registry.register('s1', run.handle);

    // Повтор id сессии в списке — прогон в выдаче один раз.
    expect(registry.listForSessions(['s1', 's1'])).toEqual([run.handle]);
  });

  it('find ищет прогон только среди переданных сессий', () => {
    const registry = new ActiveRunRegistry();
    const run = makeRun('child-a');
    registry.register('s1', run.handle);

    expect(registry.find(['s1'], 'child-a')).toBe(run.handle);
    // Чужая сессия — прогон «не существует» (доступ решает вызывающий).
    expect(registry.find(['s2'], 'child-a')).toBeUndefined();
    expect(registry.find(['s1'], 'unknown')).toBeUndefined();
  });

  it('stop у хэндла необязателен: регистрация без него валидна', () => {
    const registry = new ActiveRunRegistry();
    const run = makeRun('child-a');
    registry.register('s1', run.handle);

    const found = registry.find(['s1'], 'child-a');
    expect(found?.stop).toBeUndefined();
  });

  it('сводка detachAll несёт аддитивные поля хэндла', async () => {
    const registry = new ActiveRunRegistry();
    const stop = vi.fn();
    const run: ActiveRunHandle = {
      id: 'proc-1',
      kind: 'process',
      title: 'npm test',
      sessionId: 's1',
      processId: 'proc-1',
      logPath: 'processes/live/proc-1.log',
      startedAt: 1_700_000_000_000,
      stop,
      detach: vi.fn(async () => {}),
    };
    registry.register('s1', run);

    const result = await registry.detachAll('s1');

    expect(result.detached).toEqual([{
      id: 'proc-1',
      kind: 'process',
      title: 'npm test',
      sessionId: 's1',
      processId: 'proc-1',
      logPath: 'processes/live/proc-1.log',
      startedAt: 1_700_000_000_000,
    }]);
  });
});
