import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookBus, HOOK_ASYNC_TIMEOUT_MS } from './hook-bus.js';
import type { HookHandler } from './hook-bus.js';

/** Дождаться опустошения микротасок/таймеров (0 мс). */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('HookBus', () => {
  let bus: HookBus;

  beforeEach(() => {
    bus = new HookBus();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('порядок sync-обработчиков: priority по убыванию', async () => {
    const calls: string[] = [];
    bus.on('pre_tool_use', () => { calls.push('low'); }, { priority: 0 });
    bus.on('pre_tool_use', () => { calls.push('high'); }, { priority: 10 });
    bus.on('pre_tool_use', () => { calls.push('mid'); }, { priority: 5 });

    await bus.emit('pre_tool_use', { tool: 'bash', input: {} });

    expect(calls).toEqual(['high', 'mid', 'low']);
  });

  it('при равном priority сохраняется порядок регистрации', async () => {
    const calls: string[] = [];
    bus.on('pre_tool_use', () => { calls.push('first'); });
    bus.on('pre_tool_use', () => { calls.push('second'); });
    bus.on('pre_tool_use', () => { calls.push('third'); });

    await bus.emit('pre_tool_use', { tool: 'bash', input: {} });

    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('on возвращает функцию отписки', async () => {
    const handler = vi.fn();
    const unsubscribe = bus.on('pre_tool_use', handler);
    expect(typeof unsubscribe).toBe('function');
    expect(bus.count('pre_tool_use')).toBe(1);

    unsubscribe();
    expect(bus.count('pre_tool_use')).toBe(0);

    await bus.emit('pre_tool_use', { tool: 'bash', input: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it('off снимает обработчик по ссылке', async () => {
    const handler = vi.fn();
    bus.on('pre_tool_use', handler);
    bus.off('pre_tool_use', handler);

    expect(bus.count('pre_tool_use')).toBe(0);
    await bus.emit('pre_tool_use', { tool: 'bash', input: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it('block немедленно прерывает цепочку и возвращает reason', async () => {
    const later = vi.fn();
    bus.on('pre_tool_use', () => ({ block: true, reason: 'danger' }), { priority: 10 });
    bus.on('pre_tool_use', later, { priority: 0 });

    const result = await bus.emit('pre_tool_use', { tool: 'bash', input: {} });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('danger');
    expect(later).not.toHaveBeenCalled();
  });

  it('patch поверхностно мержится и виден следующим обработчикам', async () => {
    bus.on('pre_tool_use', () => ({ patch: { agent: 'patched' } }), { priority: 10 });
    const seen = vi.fn<HookHandler<'pre_tool_use'>>();
    bus.on('pre_tool_use', seen, { priority: 0 });

    const result = await bus.emit('pre_tool_use', { tool: 'bash', input: {}, agent: 'orig' });

    expect(seen).toHaveBeenCalledWith({ tool: 'bash', input: {}, agent: 'patched' });
    expect(result.context.agent).toBe('patched');
    expect(result.blocked).toBe(false);
  });

  it('ошибка sync-обработчика изолируется и не ломает остальных', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = vi.fn();
    bus.on('pre_tool_use', () => { throw new Error('boom'); }, { priority: 10 });
    bus.on('pre_tool_use', good, { priority: 0 });

    const result = await bus.emit('pre_tool_use', { tool: 'bash', input: {} });

    expect(result.blocked).toBe(false);
    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[HookBus]'));
  });

  it('emit вызывает только sync-обработчики, emitAsync — только async', async () => {
    const sync = vi.fn();
    const asyncHandler = vi.fn();
    bus.on('pre_tool_use', sync, { mode: 'sync' });
    bus.on('pre_tool_use', asyncHandler, { mode: 'async' });

    await bus.emit('pre_tool_use', { tool: 'bash', input: {} });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(asyncHandler).not.toHaveBeenCalled();
  });

  it('emitAsync не вызывает sync-обработчики и не ждёт async', async () => {
    const sync = vi.fn();
    const asyncHandler = vi.fn(async () => { await flush(); });
    bus.on('pre_tool_use', sync, { mode: 'sync' });
    bus.on('pre_tool_use', asyncHandler, { mode: 'async' });

    bus.emitAsync('pre_tool_use', { tool: 'bash', input: {} });

    // fire-and-forget: sync не тронут, async ещё не успел
    expect(sync).not.toHaveBeenCalled();
    expect(asyncHandler).not.toHaveBeenCalled();

    await flush();
    expect(asyncHandler).toHaveBeenCalledTimes(1);
  });

  it('emitAsync: ошибка async-обработчика логируется и не пробрасывается', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.on('pre_tool_use', () => { throw new Error('async boom'); }, { mode: 'async' });

    expect(() => bus.emitAsync('pre_tool_use', { tool: 'bash', input: {} })).not.toThrow();
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[HookBus]'));
  });

  it('emitAsync: таймаут обработчика логируется (fake timers)', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.on('pre_tool_use', () => new Promise<void>(() => {}), { mode: 'async' });

    bus.emitAsync('pre_tool_use', { tool: 'bash', input: {} });
    await vi.advanceTimersByTimeAsync(HOOK_ASYNC_TIMEOUT_MS);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('removeAll очищает все обработчики', async () => {
    bus.on('pre_tool_use', vi.fn());
    bus.on('post_tool_use', vi.fn());
    bus.on('plan_approved', vi.fn(), { mode: 'async' });

    bus.removeAll();

    expect(bus.count('pre_tool_use')).toBe(0);
    expect(bus.count('post_tool_use')).toBe(0);
    expect(bus.count('plan_approved')).toBe(0);
  });

  it('count считает регистрации по имени (оба режима)', () => {
    bus.on('pre_tool_use', vi.fn());
    bus.on('pre_tool_use', vi.fn(), { mode: 'async' });
    bus.on('post_tool_use', vi.fn());

    expect(bus.count('pre_tool_use')).toBe(2);
    expect(bus.count('post_tool_use')).toBe(1);
    expect(bus.count('session_start')).toBe(0);
  });

  it('emit без обработчиков возвращает контекст без блокировки', async () => {
    const ctx = { tool: 'bash', input: {} };
    const result = await bus.emit('pre_tool_use', ctx);
    expect(result.blocked).toBe(false);
    expect(result.context).toEqual(ctx);
  });
});

describe('HookBus — политика builtin (ADR-090)', () => {
  let bus: HookBus;

  beforeEach(() => {
    bus = new HookBus();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builtin-обработчик нельзя снять через возвращённую функцию отписки', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = vi.fn();
    const unsubscribe = bus.on('message_received', handler, { builtin: true, mode: 'async' });

    unsubscribe();

    expect(bus.count('message_received')).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('builtin handler'));
    bus.emitAsync('message_received', {
      sessionId: 's1',
      kind: 'user',
    });
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('builtin-обработчик нельзя снять через off()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = vi.fn();
    bus.on('session_start', handler, { builtin: true });

    bus.off('session_start', handler);

    expect(bus.count('session_start')).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('off()'));
    await bus.emit('session_start', { sessionId: 's1' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('обычный обработчик снимается как раньше (off и отписка)', async () => {
    const byOff = vi.fn();
    const byUnsubscribe = vi.fn();
    bus.on('session_start', byOff);
    const unsubscribe = bus.on('session_start', byUnsubscribe);

    bus.off('session_start', byOff);
    unsubscribe();

    expect(bus.count('session_start')).toBe(0);
    await bus.emit('session_start', { sessionId: 's1' });
    expect(byOff).not.toHaveBeenCalled();
    expect(byUnsubscribe).not.toHaveBeenCalled();
  });

  it('offBuiltin — явный путь владельца регистрации', async () => {
    const handler = vi.fn();
    bus.on('session_start', handler, { builtin: true });

    bus.offBuiltin('session_start', handler);

    expect(bus.count('session_start')).toBe(0);
    await bus.emit('session_start', { sessionId: 's1' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('offBuiltin не снимает обычные обработчики, если ссылка не совпала', async () => {
    const kept = vi.fn();
    bus.on('session_start', kept, { builtin: true });

    bus.offBuiltin('session_start', vi.fn());

    expect(bus.count('session_start')).toBe(1);
    await bus.emit('session_start', { sessionId: 's1' });
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('removeAll снимает и builtin (служебный путь для тестов)', () => {
    bus.on('session_start', vi.fn(), { builtin: true });
    bus.removeAll();
    expect(bus.count('session_start')).toBe(0);
  });

  it('политика builtin не меняет priority/block/patch/изоляцию ошибок', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    bus.on('pre_tool_use', () => { order.push('builtin-high'); return { patch: { agent: 'patched' } }; }, { priority: 10, builtin: true });
    bus.on('pre_tool_use', () => { order.push('low'); }, { priority: 0 });
    bus.on('pre_tool_use', () => { throw new Error('boom'); }, { priority: 5, builtin: true });

    const result = await bus.emit('pre_tool_use', { tool: 'bash', input: {} });

    expect(order).toEqual(['builtin-high', 'low']);
    expect(result.context.agent).toBe('patched');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[HookBus] handler'));
  });
});
