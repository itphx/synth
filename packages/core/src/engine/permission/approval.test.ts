import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../events/bus.js';
import { PermissionApprovalManager } from './approval.js';
import type { ApprovalRequest } from './approval.js';

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
});
