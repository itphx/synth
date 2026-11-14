/**
 * Обёртка удалённого порта и PTY (план терминалов, Ф2b).
 *
 * Проверяется, что обёртка `RemoteExecutionPortWithExecutorMcp` (то, что
 * control plane получает из `createRemoteExecutionPortFromConfig`) не теряет
 * PTY-контур удалённого исполнителя:
 *
 * - признак `pty` пробрасывается с внутреннего порта (в т.ч. «неизвестно» —
 *   `undefined`, а не «не умеет»);
 * - `openPty` делегируется внутреннему порту;
 * - внутренний порт без `openPty` — метод **не выставляется** (fail-closed:
 *   «PTY не поддерживается» не должно выглядеть как «есть метод, но падает»);
 * - отказ внутреннего порта (`EPTY`/`dependency_missing`) пробрасывается как
 *   есть — вызывающий превращает его в `unavailable(dependency)`.
 *
 * Проводная часть клиента (NDJSON-поток, `/pty/*`) проверяется в пакете
 * исполнителя (`packages/executor/src/pty-client.test.ts`) — там, где клиент
 * и живёт.
 */

import { describe, expect, it } from 'vitest';
import { RemoteExecutionPortWithExecutorMcp } from './remote.js';
import { ExecutionError, isExecutionError } from './ports/index.js';
import type { ExecutionPort, ExecRequest, ExecResult, PtyHandle, PtyOpenRequest } from './ports/index.js';

/** Порт-заглушка: только `execute` (остальное — по требованию теста). */
function fakePort(overrides: Partial<ExecutionPort> = {}): ExecutionPort {
  return {
    async execute(_req: ExecRequest): Promise<ExecResult> {
      return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
    },
    ...overrides,
  };
}

/** Заглушка хэндла PTY-сессии (вызывающий её не трогает). */
function fakeHandle(): PtyHandle {
  return {
    id: 'pty_test',
    write: () => {},
    resize: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    close: async () => {},
  };
}

describe('ADR-077/Ф2b: обёртка удалённого порта и PTY', () => {
  it('признак pty пробрасывается с внутреннего порта', () => {
    const supported = new RemoteExecutionPortWithExecutorMcp(
      fakePort({ pty: true }),
      ['http://127.0.0.1:1'],
      'token',
    );
    expect(supported.pty).toBe(true);

    const unsupported = new RemoteExecutionPortWithExecutorMcp(
      fakePort({ pty: false }),
      ['http://127.0.0.1:1'],
      'token',
    );
    expect(unsupported.pty).toBe(false);

    // «Состав пула неизвестен» — это не «не умеет»: неизвестное не значит «нет».
    const unknown = new RemoteExecutionPortWithExecutorMcp(
      fakePort(),
      ['http://127.0.0.1:1'],
      'token',
    );
    expect(unknown.pty).toBeUndefined();
  });

  it('openPty делегируется внутреннему порту', async () => {
    const calls: PtyOpenRequest[] = [];
    const wrapper = new RemoteExecutionPortWithExecutorMcp(
      fakePort({
        pty: true,
        openPty: async (req: PtyOpenRequest) => {
          calls.push(req);
          return fakeHandle();
        },
      }),
      ['http://127.0.0.1:1'],
      'token',
    );

    expect(typeof wrapper.openPty).toBe('function');
    const handle = await wrapper.openPty!({ cwd: '/workspace', cols: 80, rows: 24 });
    expect(handle.id).toBe('pty_test');
    expect(calls).toEqual([{ cwd: '/workspace', cols: 80, rows: 24 }]);
  });

  it('внутренний порт без openPty — метод не выставляется (fail-closed)', () => {
    const wrapper = new RemoteExecutionPortWithExecutorMcp(
      fakePort(),
      ['http://127.0.0.1:1'],
      'token',
    );
    expect(wrapper.openPty).toBeUndefined();
  });

  it('отказ внутреннего порта (EPTY) пробрасывается как есть', async () => {
    const wrapper = new RemoteExecutionPortWithExecutorMcp(
      fakePort({
        openPty: async () => {
          throw new ExecutionError({
            message: 'исполнитель не поддерживает PTY-сессии',
            code: 'EPTY',
            reason: 'dependency_missing',
          });
        },
      }),
      ['http://127.0.0.1:1'],
      'token',
    );

    const err = await wrapper.openPty!({ cwd: '/workspace', cols: 80, rows: 24 }).catch(
      (e: unknown) => e,
    );
    expect(isExecutionError(err)).toBe(true);
    expect((err as ExecutionError).code).toBe('EPTY');
    expect((err as ExecutionError).reason).toBe('dependency_missing');
  });
});
