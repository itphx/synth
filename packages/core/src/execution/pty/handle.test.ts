/**
 * Проба переднего плана PTY-хэндла (протокол исполнителя 9).
 *
 * Нативный модуль не нужен: сессия и проба — подделки. Проверяются:
 *
 * - `inspect()` отдаёт факт пробы и передаёт **pid оболочки**;
 * - кэш 250 мс склеивает частые вызовы (проба не бежит на каждый запрос);
 * - после `close()` — `null` (мёртвому терминалу проба не нужна);
 * - ошибка пробы — `null`, а не исключение (fail-open).
 */

import { describe, expect, it } from 'vitest';
import type { PtyForeground } from '../ports/index.js';
import { createPtyHandle, PTY_FOREGROUND_CACHE_MS } from './handle.js';
import type { PtySession } from './provider.js';

/** Подделка PTY-сессии с pid: выход — по `kill`. */
class FakeSession implements PtySession {
  /**
   * pid — намеренно **не задан** по умолчанию у close-сценария: закрытие в
   * core шлёт сигнал группе (`kill(-pid)`), и тест не должен задевать
   * реальные процессы. Для пробы pid передаётся явно.
   */
  readonly pid: number | undefined;
  private readonly exitListeners = new Set<(e: { exitCode?: number; signal?: string }) => void>();

  constructor(pid: number | undefined = 4242) {
    this.pid = pid;
  }

  write(): void {}
  resize(): void {}
  onData(): () => void {
    return () => {};
  }
  onExit(cb: (e: { exitCode?: number; signal?: string }) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }
  kill(signal?: string): void {
    for (const listener of [...this.exitListeners]) listener({ signal: signal ?? 'SIGTERM' });
  }
}

const SHELL_FOREGROUND: PtyForeground = {
  shellPid: 4242,
  foregroundPgid: 4242,
  command: 'bash',
  isShell: true,
};

describe('PtyHandle.inspect', () => {
  it('передаёт pid оболочки и отдаёт факт пробы', async () => {
    const received: Array<number | undefined> = [];
    const handle = createPtyHandle(new FakeSession(), 'pty_test', {
      probe: async (shellPid) => {
        received.push(shellPid);
        return SHELL_FOREGROUND;
      },
    });

    expect(await handle.inspect?.()).toEqual(SHELL_FOREGROUND);
    expect(received).toEqual([4242]);
  });

  it('кэширует результат на 250 мс', async () => {
    let calls = 0;
    const handle = createPtyHandle(new FakeSession(), 'pty_test', {
      probe: async () => {
        calls += 1;
        return SHELL_FOREGROUND;
      },
    });

    expect(PTY_FOREGROUND_CACHE_MS).toBe(250);
    expect(await handle.inspect?.()).toEqual(SHELL_FOREGROUND);
    expect(await handle.inspect?.()).toEqual(SHELL_FOREGROUND);
    expect(calls).toBe(1);
  });

  it('inspectCacheMs: 0 — проба на каждый вызов', async () => {
    let calls = 0;
    const handle = createPtyHandle(new FakeSession(), 'pty_test', {
      inspectCacheMs: 0,
      probe: async () => {
        calls += 1;
        return SHELL_FOREGROUND;
      },
    });

    await handle.inspect?.();
    await handle.inspect?.();
    expect(calls).toBe(2);
  });

  it('одновременные вызовы делят одну пробу', async () => {
    let calls = 0;
    const handle = createPtyHandle(new FakeSession(), 'pty_test', {
      probe: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return SHELL_FOREGROUND;
      },
    });

    const [first, second] = await Promise.all([handle.inspect?.(), handle.inspect?.()]);
    expect(first).toEqual(SHELL_FOREGROUND);
    expect(second).toEqual(SHELL_FOREGROUND);
    expect(calls).toBe(1);
  });

  it('ошибка пробы — null (fail-open), без исключения', async () => {
    const handle = createPtyHandle(new FakeSession(), 'pty_test', {
      probe: async () => {
        throw new Error('boom');
      },
    });
    expect(await handle.inspect?.()).toBeNull();
  });

  it('после close() — null и проба не вызывается', async () => {
    let calls = 0;
    // Без pid: `close()` не шлёт сигнал группе процессов (см. FakeSession).
    const handle = createPtyHandle(new FakeSession(undefined), 'pty_test', {
      probe: async () => {
        calls += 1;
        return SHELL_FOREGROUND;
      },
    });

    await handle.close();
    expect(await handle.inspect?.()).toBeNull();
    expect(calls).toBe(0);
  });
});
