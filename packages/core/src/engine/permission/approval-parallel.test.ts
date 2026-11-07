/**
 * PROP-127 (этап T5): параллельные подтверждения прав.
 *
 * Проверяем два свойства менеджера подтверждений:
 * - **одновременность**: несколько `ask` одного шага висят в шине разом (все
 *   `permission.asked` опубликованы до того, как на любой из них ответили);
 * - **каскад отказа**: отказ по одному подтверждению гасит остальные
 *   ожидания той же сессии (паритет с opencode) — ход не ждёт ответов на
 *   вопросы, на которые пользователь уже отказал.
 *
 * Плюс инварианты ADR-106 Ф3: каскадное подтверждение списывается, поздний
 * ответ на него не может его одобрить (`already_consumed`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../events/bus.js';
import { PermissionApprovalManager, ApprovalRegistry, type ApprovalRequest } from './approval.js';
import type { AuthorityPrincipal } from '@itphx/synth-shared';

function request(id: string, tool = 'write_file'): ApprovalRequest {
  return {
    // Формат id — как в проде: `approval_${callId}`, где callId = `call_<id>`
    // (`orchestrator.ts`: `approvalId: \`approval_${tcId}\``).
    approvalId: `approval_call_${id}`,
    callId: `call_${id}`,
    toolName: tool,
    arguments: { file_path: `/tmp/${id}.txt` },
    reason: 'правило → ask',
  };
}

/** Ответ на подтверждение (новый формат WS `permission_reply`). */
function reply(bus: EventBus, sessionId: string, approvalId: string, action: 'allow' | 'deny', once = true): void {
  bus.publish(sessionId, 'permission.replied', {
    approval_id: approvalId,
    session_id: sessionId,
    approved: action === 'allow',
    action,
    once,
  });
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

describe('PermissionApprovalManager — параллельные подтверждения (PROP-127 T5)', () => {
  let bus: EventBus;
  let manager: PermissionApprovalManager;
  let asked: string[];
  let replied: string[];

  beforeEach(() => {
    bus = new EventBus();
    manager = new PermissionApprovalManager(bus);
    asked = [];
    replied = [];
    // «UI»-подписчик: запросы фиксируются, ответы — отдельным действием
    // теста (иначе первый ответ пришёл бы до публикации второго запроса).
    bus.subscribe('s1', (event) => {
      if (event.type === 'permission.asked') {
        asked.push(event.data.approval_id as string);
      } else if (event.type === 'permission.replied') {
        replied.push(event.data.approval_id as string);
      }
    });
  });

  it('несколько ask висят одновременно: оба permission.asked опубликованы до любого ответа', async () => {
    const waiters = manager.prepareWaiters('s1', [request('a'), request('b')], 5000);
    // Подготовка — без публикации: пользователь ещё ничего не видит.
    expect(asked).toEqual([]);

    manager.publishWaiters(waiters);
    // Оба запроса опубликованы разом.
    expect(asked).toEqual(['approval_call_a', 'approval_call_b']);

    // Ответ на второй — первый всё ещё ждёт.
    reply(bus, 's1', 'approval_call_b', 'allow');
    await tick();
    expect(await waiters[1]!.decision).toMatchObject({ approved: true, action: 'allow' });
    expect(waiters[0]!.settled).toBe(false);

    // Ответ на первый — оба решения свои.
    reply(bus, 's1', 'approval_call_a', 'deny');
    expect(await waiters[0]!.decision).toMatchObject({ approved: false, action: 'deny' });
  });

  it('отказ по одному подтверждению каскадит на остальные ожидания сессии', async () => {
    const waiters = manager.prepareWaiters('s1', [request('a'), request('b'), request('c')], 5000);
    manager.publishWaiters(waiters);
    expect(asked).toHaveLength(3);

    reply(bus, 's1', 'approval_call_a', 'deny');

    const decisions = await Promise.all(waiters.map((w) => w.decision));
    // Первый — прямой отказ пользователя, остальные — каскад.
    expect(decisions[0]).toMatchObject({ approved: false, action: 'deny' });
    expect(decisions[0]!.cascaded).toBeUndefined();
    expect(decisions[1]).toMatchObject({ approved: false, action: 'deny', cascaded: true });
    expect(decisions[2]).toMatchObject({ approved: false, action: 'deny', cascaded: true });

    // UI получает `permission.replied` по каскадным запросам — карточки
    // снимаются из очереди (пользователь их не отвечал).
    expect(replied).toEqual(expect.arrayContaining(['approval_call_b', 'approval_call_c']));
  });

  it('каскад не затрагивает другую сессию', async () => {
    // Подписчик нужен и для 's2': без пользовательских подписчиков ожидание
    // закрывается сразу с `noSubscribers` (прод-поведение) — тогда проверять
    // «каскад не затрагивает чужую сессию» было бы бессмысленно.
    bus.subscribe('s2', () => {});
    const other = manager.prepareWaiters('s2', [request('x')], 5000);
    manager.publishWaiters(other);
    const own = manager.prepareWaiters('s1', [request('a')], 5000);
    manager.publishWaiters(own);

    reply(bus, 's1', 'approval_call_a', 'deny');
    await tick();

    expect((await own[0]!.decision).approved).toBe(false);
    // Запрос другой сессии жив — его ждут как прежде.
    expect(other[0]!.settled).toBe(false);
  });

  it('отклонённый сервером ответ (нет гранта) не каскадит — пользователь не отказывал', async () => {
    const waiters = manager.prepareWaiters('s1', [request('a'), request('b')], 5000);
    manager.publishWaiters(waiters);

    // Ответ не принят реестром подтверждений: сервер публикует `reason`.
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_call_a',
      session_id: 's1',
      approved: false,
      action: 'deny',
      reason: 'no_grant',
    });
    await tick();

    expect((await waiters[0]!.decision).approved).toBe(false);
    // Соседний запрос НЕ погашен: отказ выдуман сервером, а не пользователем.
    expect(waiters[1]!.settled).toBe(false);
  });

  it('ADR-106: поздний ответ на каскадное подтверждение не одобряет его (already_consumed)', async () => {
    const registry = new ApprovalRegistry({ coverage: () => true });
    const bound = new PermissionApprovalManager(bus, { registry });
    const boundRequest: ApprovalRequest = {
      ...request('a'),
      turnId: 'turn_1',
      action: 'write',
      target: { kind: 'path', ref: 'a.txt' },
    };
    const waiters = bound.prepareWaiters('s1', [boundRequest], 5000);
    bound.publishWaiters(waiters);

    // Прод-путь ответа: сначала `registry.claim()` (списывает привязку),
    // затем публикация `permission.replied` (`server/routes/sessions.ts`).
    const responder = { kind: 'user', id: 'u1', roles: [] } as AuthorityPrincipal;
    const claim = await registry.claim('approval_call_a', 's1', responder);
    expect(claim.ok).toBe(true);
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_call_a',
      session_id: 's1',
      approved: false,
      action: 'deny',
    });
    await tick();
    expect((await waiters[0]!.decision).approved).toBe(false);

    // Поздний ответ пользователя на уже погашенное подтверждение — отказ.
    const late = await registry.claim('approval_call_a', 's1', responder);
    expect(late.ok).toBe(false);
    expect(late.reason).toBe('already_consumed');
  });

  it('ADR-106: каскад списывает привязку — поздний ответ на каскадный запрос не одобряет его', async () => {
    const registry = new ApprovalRegistry({ coverage: () => true });
    const bound = new PermissionApprovalManager(bus, { registry });
    const boundRequest = (id: string): ApprovalRequest => ({
      ...request(id),
      turnId: 'turn_1',
      action: 'write',
      target: { kind: 'path', ref: `${id}.txt` },
    });
    const waiters = bound.prepareWaiters('s1', [boundRequest('a'), boundRequest('b')], 5000);
    bound.publishWaiters(waiters);

    // Отказ по первому — каскад гасит второй (второй привязку списывает).
    const responder = { kind: 'user', id: 'u1', roles: [] } as AuthorityPrincipal;
    await registry.claim('approval_call_a', 's1', responder);
    bus.publish('s1', 'permission.replied', {
      approval_id: 'approval_call_a',
      session_id: 's1',
      approved: false,
      action: 'deny',
    });
    const decisions = await Promise.all(waiters.map((w) => w.decision));
    expect(decisions[0]).toMatchObject({ approved: false, action: 'deny' });
    expect(decisions[1]).toMatchObject({ approved: false, action: 'deny', cascaded: true });

    // Поздний ответ на каскадный запрос — отказ (привязка списана).
    const late = await registry.claim('approval_call_b', 's1', responder);
    expect(late.ok).toBe(false);
    expect(late.reason).toBe('already_consumed');
  });

  it('таймаут по-прежнему гасит только свой запрос', async () => {
    const waiters = manager.prepareWaiters('s1', [request('a'), request('b')], 30);
    manager.publishWaiters(waiters);
    const decisions = await Promise.all(waiters.map((w) => w.decision));
    expect(decisions[0]).toMatchObject({ approved: false, timeout: true });
    expect(decisions[1]).toMatchObject({ approved: false, timeout: true });
  });

  it('«Стоп» (отмена хода) снимает все ожидания сессии', async () => {
    const controller = new AbortController();
    const waiters = manager.prepareWaiters('s1', [request('a'), request('b')], 5000, controller.signal);
    manager.publishWaiters(waiters);
    controller.abort();
    const decisions = await Promise.all(waiters.map((w) => w.decision));
    expect(decisions[0]).toMatchObject({ approved: false, cancelled: true });
    expect(decisions[1]).toMatchObject({ approved: false, cancelled: true });
  });

  it('грант «в сессии» одобряет соседний запрос без нового вопроса (паритет с opencode)', async () => {
    const waiters = manager.prepareWaiters('s1', [request('a'), request('b')], 5000);
    manager.publishWaiters(waiters);

    // Соседний запрос одобряется из кода (переоценка после гранта).
    waiters[1]!.resolve({ approved: true, action: 'allow' });
    expect((await waiters[1]!.decision).approved).toBe(true);

    // Первый — обычный ответ пользователя.
    reply(bus, 's1', 'approval_call_a', 'allow', false);
    const first = await waiters[0]!.decision;
    expect(first).toMatchObject({ approved: true, action: 'allow', once: false });
  });
});
