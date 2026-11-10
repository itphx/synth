import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../events/bus.js';
import { PermissionApprovalManager } from './approval.js';
import type { ApprovalRequest } from './approval.js';
import { MemoryPendingApprovalRepository } from '../../storage/memory/pending-approvals.js';

describe('PermissionApprovalManager — ask flow', () => {
  let bus: EventBus;
  let manager: PermissionApprovalManager;

  beforeEach(() => {
    bus = new EventBus();
    manager = new PermissionApprovalManager(bus);
  });

  const request: ApprovalRequest = {
    approvalId: 'approval_1',
    callId: 'call_1',
    toolName: 'write_file',
    arguments: { file_path: '/tmp/x.txt' },
    reason: 'правило read.* → ask',
  };

  it('нет подписчиков — сразу отказ', async () => {
    const decision = await manager.waitForDecision('s1', request, 1000);
    expect(decision.approved).toBe(false);
    expect(decision.noSubscribers).toBe(true);
  });

  it('watch-all (user-facing) клиент получает permission.asked и резолвит ответ', async () => {
    // Watch-all клиент UI (ADMIN/LEAD, service-key, standalone SSE) подписан
    // глобально и НЕ имеет per-session подписок — подтверждение должно работать.
    const asked: Array<Record<string, unknown>> = [];
    bus.subscribeAll((e) => {
      if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
    }, { userFacing: true });

    const pending = manager.waitForDecision('s1', request, 1000);
    await new Promise((r) => setTimeout(r, 10));
    expect(asked.at(-1)?.approval_id).toBe('approval_1');

    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      action: 'allow',
    });

    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.noSubscribers).toBeUndefined();
  });

  it('машинный глобальный подписчик не считается — сразу noSubscribers', async () => {
    // Webhook/пайплайн/мост гибрида: подтверждение никто не покажет, поэтому
    // не публикуем и не ждём таймаут.
    const machine = vi.fn();
    bus.subscribeAll(machine);

    const decision = await manager.waitForDecision('s1', request, 1000);
    expect(decision.approved).toBe(false);
    expect(decision.noSubscribers).toBe(true);
    expect(machine).not.toHaveBeenCalled();
  });

  it('пользователь подтверждает (allow) — тул выполняется', async () => {
    const events: string[] = [];
    bus.subscribe('s1', (e) => events.push(e.type));

    const pending = manager.waitForDecision('s1', request, 1000);
    // ждём событие permission.asked, затем отвечаем
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toContain('permission.asked');

    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      approved: true,
    });

    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.timeout).toBeUndefined();
  });

  it('save: [] уходит в permission.asked как есть (shell без выводимых паттернов)', async () => {
    const asked: Array<Record<string, unknown>> = [];
    bus.subscribe('s1', (e) => {
      if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
    });

    const pending = manager.waitForDecision('s1', {
      ...request,
      toolName: 'execute_shell',
      arguments: { command: "C='cat /etc/shadow'; $C" },
      save: [],
    }, 1000);
    await new Promise((r) => setTimeout(r, 10));

    // Пустой массив — явный сигнал «в сессии сохранить нельзя» (а не отсутствие поля).
    expect(asked.at(-1)?.save).toEqual([]);

    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      action: 'allow',
      once: true,
    });
    await pending;
  });

  it('без save поле в permission.asked не появляется', async () => {
    const asked: Array<Record<string, unknown>> = [];
    bus.subscribe('s1', (e) => {
      if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
    });

    const pending = manager.waitForDecision('s1', request, 1000);
    await new Promise((r) => setTimeout(r, 10));
    expect(asked.at(-1)).not.toHaveProperty('save');

    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      action: 'allow',
      once: true,
    });
    await pending;
  });

  it('пользователь отклоняет — отказ', async () => {
    const pending = manager.waitForDecision('s1', request, 1000);
    await new Promise((r) => setTimeout(r, 10));
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      approved: false,
    });
    const decision = await pending;
    expect(decision.approved).toBe(false);
  });

  it('ответ с чужим approval_id игнорируется', async () => {
    // внешний подписчик (имитация UI-клиента) — иначе waitForDecision вернёт noSubscribers
    bus.subscribe('s1', () => {});
    const pending = manager.waitForDecision('s1', request, 50);
    await new Promise((r) => setTimeout(r, 10));
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_other',
      session_id: 's1',
      approved: true,
    });
    // чужой ответ не резолвит — ждём до таймаута
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.timeout).toBe(true);
  });

  it('таймаут — отказ с пометкой timeout', async () => {
    bus.subscribe('s1', () => {});
    const decision = await manager.waitForDecision('s1', request, 50);
    expect(decision.approved).toBe(false);
    expect(decision.timeout).toBe(true);
  });

  it('timeoutMs=0 — ждёт ответа бесконечно, без авто-отклонения', async () => {
    const asked: Array<Record<string, unknown>> = [];
    bus.subscribe('s1', (e) => {
      if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
    });
    const pending = manager.waitForDecision('s1', request, 0);
    await new Promise((r) => setTimeout(r, 80));
    // поле ask_timeout_ms в событии передаётся как 0 («без таймаута»)
    expect(asked.at(-1)?.ask_timeout_ms).toBe(0);
    // авто-отклонения нет — отвечаем спустя время, большее «обычного» таймаута
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1', session_id: 's1', action: 'allow', once: false,
    });
    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.timeout).toBeUndefined();
  });

  it('ответ с action=allow + once=false — решение с action/once', async () => {
    bus.subscribe('s1', () => {});
    const pending = manager.waitForDecision('s1', request, 1000);
    await new Promise((r) => setTimeout(r, 10));
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      action: 'allow',
      once: false,
    });
    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.action).toBe('allow');
    expect(decision.once).toBe(false);
  });

  it('ответ с action=deny — approved=false, action=deny', async () => {
    bus.subscribe('s1', () => {});
    const pending = manager.waitForDecision('s1', request, 1000);
    await new Promise((r) => setTimeout(r, 10));
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      action: 'deny',
      once: true,
    });
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.action).toBe('deny');
    expect(decision.once).toBe(true);
  });

  it('старый формат { approved: true } — approved=true без action', async () => {
    bus.subscribe('s1', () => {});
    const pending = manager.waitForDecision('s1', request, 1000);
    await new Promise((r) => setTimeout(r, 10));
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      approved: true,
    });
    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.action).toBeUndefined();
    expect(decision.once).toBeUndefined();
  });

  it('action приоритетнее approved при конфликте', async () => {
    bus.subscribe('s1', () => {});
    const pending = manager.waitForDecision('s1', request, 1000);
    await new Promise((r) => setTimeout(r, 10));
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      approved: true,
      action: 'deny',
    });
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.action).toBe('deny');
  });

  it('после ответа подписка отписана (не утекает)', async () => {
    const spy = vi.spyOn(bus, 'unsubscribe');
    bus.subscribe('s1', () => {});
    const pending = manager.waitForDecision('s1', request, 1000);
    await new Promise((r) => setTimeout(r, 10));
    bus.publish('s1', 'permission.replied', { approval_id: 'approval_1', approved: true });
    await pending;
    expect(spy).toHaveBeenCalled();
  });

  it('permission.hold останавливает таймаут: allow после паузы резолвит без timeout', async () => {
    bus.subscribe('s1', () => {});
    const pending = manager.waitForDecision('s1', request, 50);
    await new Promise((r) => setTimeout(r, 10));
    bus.publish('s1', 'permission.hold', { approval_id: 'approval_1', session_id: 's1' });
    // ждём дольше исходного таймаута — авто-отклонения быть не должно
    await new Promise((r) => setTimeout(r, 80));
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1', session_id: 's1', action: 'allow', once: false,
    });
    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.timeout).toBeUndefined();
    expect(decision.action).toBe('allow');
    expect(decision.once).toBe(false);
  });

  it('после permission.hold ответ deny по-прежнему резолвит отказом', async () => {
    bus.subscribe('s1', () => {});
    const pending = manager.waitForDecision('s1', request, 50);
    await new Promise((r) => setTimeout(r, 10));
    bus.publish('s1', 'permission.hold', { approval_id: 'approval_1', session_id: 's1' });
    await new Promise((r) => setTimeout(r, 80));
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1', session_id: 's1', action: 'deny',
    });
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.action).toBe('deny');
    expect(decision.timeout).toBeUndefined();
  });

  it('чужой approval_id в permission.hold игнорируется', async () => {
    bus.subscribe('s1', () => {});
    const pending = manager.waitForDecision('s1', request, 50);
    await new Promise((r) => setTimeout(r, 10));
    bus.publish('s1', 'permission.hold', { approval_id: 'approval_other', session_id: 's1' });
    // чужой hold не останавливает таймаут — запрос уходит в timeout
    const decision = await pending;
    expect(decision.timeout).toBe(true);
  });

  it('отмена хода (AbortSignal) во время ожидания резолвит cancelled сразу, не ждёт таймаут', async () => {
    const asked: string[] = [];
    bus.subscribe('s1', (e) => asked.push(e.type));
    const controller = new AbortController();
    const startedAt = Date.now();
    // Таймаут заведомо больше времени теста — иначе тест не отличил бы
    // «отмену» от авто-отклонения.
    const pending = manager.waitForDecision('s1', request, 10_000, controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toContain('permission.asked');

    controller.abort();
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.cancelled).toBe(true);
    expect(decision.timeout).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('уже отменённый сигнал — сразу cancelled без публикации permission.asked', async () => {
    const asked: string[] = [];
    bus.subscribe('s1', (e) => asked.push(e.type));
    const controller = new AbortController();
    controller.abort();

    const decision = await manager.waitForDecision('s1', request, 10_000, controller.signal);
    expect(decision.approved).toBe(false);
    expect(decision.cancelled).toBe(true);
    expect(asked).not.toContain('permission.asked');
  });

  it('превью изменений публикуется в permission.asked (аддитивное поле)', async () => {
    const preview = {
      files: [{
        path: 'a.txt',
        diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y',
        additions: 1,
        deletions: 1,
      }],
    };
    const asked: Array<Record<string, unknown>> = [];
    bus.subscribe('s1', (e) => {
      if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
    });

    const pending = manager.waitForDecision('s1', { ...request, preview }, 50);
    await new Promise((r) => setTimeout(r, 10));

    expect(asked.at(-1)?.preview).toEqual(preview);

    bus.publish('s1', 'permission.replied', { approval_id: 'approval_1', session_id: 's1', approved: false });
    await pending;
  });

  it('без превью поле preview в событии отсутствует', async () => {
    const asked: Array<Record<string, unknown>> = [];
    bus.subscribe('s1', (e) => {
      if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
    });

    const pending = manager.waitForDecision('s1', request, 50);
    await new Promise((r) => setTimeout(r, 10));

    expect('preview' in (asked.at(-1) ?? {})).toBe(false);

    bus.publish('s1', 'permission.replied', { approval_id: 'approval_1', session_id: 's1', approved: false });
    await pending;
  });

  it('trigger публикуется в permission.asked (структурная причина ask\'а)', async () => {
    const asked: Array<Record<string, unknown>> = [];
    bus.subscribe('s1', (e) => {
      if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
    });

    const trigger = {
      messageId: 'ask-protected-path',
      params: { path: '/etc/secret' },
      matchedRule: 'protected-paths.ask',
      askKind: 'protected' as const,
    };
    const pending = manager.waitForDecision('s1', { ...request, trigger }, 50);
    await new Promise((r) => setTimeout(r, 10));

    expect(asked.at(-1)?.trigger).toEqual(trigger);

    bus.publish('s1', 'permission.replied', { approval_id: 'approval_1', session_id: 's1', approved: false });
    await pending;
  });

  it('без trigger поле trigger в событии отсутствует', async () => {
    const asked: Array<Record<string, unknown>> = [];
    bus.subscribe('s1', (e) => {
      if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
    });

    const pending = manager.waitForDecision('s1', request, 50);
    await new Promise((r) => setTimeout(r, 10));

    expect('trigger' in (asked.at(-1) ?? {})).toBe(false);

    bus.publish('s1', 'permission.replied', { approval_id: 'approval_1', session_id: 's1', approved: false });
    await pending;
  });
});

/**
 * Счётчик ожидающих подтверждений по сессиям (`listPendingCounts`).
 *
 * Источник для DTO-поля `pending_approvals`: дерево сессий должно знать о
 * висящем запросе и **после перезагрузки страницы** (живой стор клиента пуст).
 */
describe('PermissionApprovalManager — listPendingCounts', () => {
  let bus: EventBus;
  let manager: PermissionApprovalManager;

  beforeEach(() => {
    bus = new EventBus();
    manager = new PermissionApprovalManager(bus);
  });

  /** Опубликовать запрос подтверждения (живой `permission.asked`). */
  function ask(sessionId: string, approvalId: string): void {
    // Подписчик нужен: без пользовательских подписчиков спрашивать некому —
    // менеджер закрывает ожидание без публикации.
    bus.subscribe(sessionId, () => {});
    const waiter = manager.prepareWaiter(
      sessionId,
      {
        approvalId,
        callId: `call-${approvalId}`,
        toolName: 'execute_shell',
        arguments: { command: 'ls -la' },
        reason: 'нужна проверка',
      },
      0, // без таймаута — запрос живёт до ответа
    );
    manager.publishWaiters([waiter]);
  }

  it('пустой реестр — пустая карта', () => {
    expect(manager.listPendingCounts().size).toBe(0);
  });

  it('два ожидания в одной сессии — счётчик 2', () => {
    ask('s1', 'ap-1');
    ask('s1', 'ap-2');

    const counts = manager.listPendingCounts();
    expect(counts.size).toBe(1);
    expect(counts.get('s1')).toBe(2);
  });

  it('две сессии — по одному ожиданию в каждой', () => {
    ask('s1', 'ap-1');
    ask('s2', 'ap-2');

    const counts = manager.listPendingCounts();
    expect(counts.size).toBe(2);
    expect(counts.get('s1')).toBe(1);
    expect(counts.get('s2')).toBe(1);
  });

  it('после ответа запись исчезает из счётчика', () => {
    ask('s1', 'ap-1');
    ask('s1', 'ap-2');
    expect(manager.listPendingCounts().get('s1')).toBe(2);

    bus.publish('s1', 'permission.replied', {
      approval_id: 'ap-1',
      session_id: 's1',
      action: 'allow',
    });

    const counts = manager.listPendingCounts();
    expect(counts.get('s1')).toBe(1);
    expect(manager.get('ap-1')).toBeUndefined();
  });
});

/**
 * ADR-029: **отдельное хранилище ожиданий** — персистентная копия ожидания,
 * переживающая рестарт инстанса (живой реестр живёт в памяти процесса).
 *
 * Контракт:
 * - при публикации запроса — запись ожидания (`repository.save`);
 * - при settle/таймауте/отмене/каскадном отказе — запись снимается
 *   (`repository.delete`);
 * - ошибка хранилища **не ломает ход** (best-effort).
 */
describe('PermissionApprovalManager — хранилище ожиданий', () => {
  let bus: EventBus;

  const request: ApprovalRequest = {
    approvalId: 'approval_1',
    callId: 'call_1',
    toolName: 'execute_shell',
    arguments: { command: 'ls -la' },
    reason: 'правило shell.* → ask',
  };

  beforeEach(() => {
    bus = new EventBus();
  });

  /** Менеджер с хранилищем ожиданий (in-memory) и его снимок. */
  function makeManager(): {
    manager: PermissionApprovalManager;
    repository: MemoryPendingApprovalRepository;
  } {
    const repository = new MemoryPendingApprovalRepository();
    const manager = new PermissionApprovalManager(bus, { repository });
    return { manager, repository };
  }

  it('публикация запроса — запись попадает в хранилище', async () => {
    const { manager, repository } = makeManager();
    bus.subscribe('s1', () => {});

    const pending = manager.waitForDecision('s1', request, 1000);
    await vi.waitFor(async () => {
      expect((await repository.list('s1')).length).toBe(1);
    });

    const [record] = await repository.list('s1');
    expect(record!.approvalId).toBe('approval_1');
    expect(record!.sessionId).toBe('s1');
    expect(record!.toolName).toBe('execute_shell');
    expect(record!.arguments).toEqual({ command: 'ls -la' });
    expect(record!.reason).toBe('правило shell.* → ask');

    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      approved: true,
    });
    await pending;
  });

  it('ответ снимает запись из хранилища', async () => {
    const { manager, repository } = makeManager();
    bus.subscribe('s1', () => {});

    const pending = manager.waitForDecision('s1', request, 1000);
    await vi.waitFor(async () => {
      expect((await repository.list('s1')).length).toBe(1);
    });

    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      approved: true,
    });
    await pending;

    await vi.waitFor(async () => {
      expect((await repository.list('s1')).length).toBe(0);
    });
  });

  it('таймаут снимает запись из хранилища', async () => {
    const { manager, repository } = makeManager();
    bus.subscribe('s1', () => {});

    await manager.waitForDecision('s1', request, 20);

    await vi.waitFor(async () => {
      expect((await repository.list('s1')).length).toBe(0);
    }, { timeout: 2000 });
  });

  it('ошибка хранилища не ломает ход (ответ всё равно резолвится)', async () => {
    const manager = new PermissionApprovalManager(bus, {
      repository: {
        save: () => Promise.reject(new Error('хранилище недоступно')),
        delete: () => Promise.reject(new Error('хранилище недоступно')),
        list: () => Promise.reject(new Error('хранилище недоступно')),
        clear: () => Promise.reject(new Error('хранилище недоступно')),
      },
    });
    bus.subscribe('s1', () => {});

    const pending = manager.waitForDecision('s1', request, 1000);
    await new Promise((r) => setTimeout(r, 10));

    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_1',
      session_id: 's1',
      approved: true,
    });

    const decision = await pending;
    expect(decision.approved).toBe(true);
  });

  it('восстановление после рестарта: запись из хранилища видна как restored', async () => {
    const repository = new MemoryPendingApprovalRepository();
    await repository.save({
      approvalId: 'approval_restored',
      sessionId: 's1',
      toolName: 'execute_shell',
      arguments: { command: 'ls -la' },
      reason: 'правило shell.* → ask',
      askedAt: '2026-01-01T00:00:00.000Z',
      timeoutMs: 5000,
    });

    // «Процесс №2» — новый менеджер поверх того же хранилища.
    const manager = new PermissionApprovalManager(bus, { repository });
    const restored = await manager.restoreFromRepository();
    expect(restored).toBe(1);

    const pending = manager.listPending('s1');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.restored).toBe(true);
    // Таймера после рестарта нет — запрос живёт до ответа.
    expect(pending[0]!.held).toBe(true);
    expect(pending[0]!.request.toolName).toBe('execute_shell');

    // Счётчик DTO учитывает восстановленное ожидание.
    expect(manager.listPendingCounts().get('s1')).toBe(1);
  });

  it('снятие восстановленного ожидания убирает его из хранилища', async () => {
    const repository = new MemoryPendingApprovalRepository();
    await repository.save({
      approvalId: 'approval_restored',
      sessionId: 's1',
      toolName: 'execute_shell',
      arguments: {},
      reason: '',
      askedAt: '2026-01-01T00:00:00.000Z',
      timeoutMs: 0,
    });

    const manager = new PermissionApprovalManager(bus, { repository });
    await manager.restoreFromRepository();
    await manager.removeRestored('approval_restored');

    expect(manager.listPending('s1')).toHaveLength(0);
    expect(await repository.list()).toEqual([]);
  });
});
