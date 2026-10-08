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
