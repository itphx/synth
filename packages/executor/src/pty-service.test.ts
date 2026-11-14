import { describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PtyProvider, PtySession } from '@itphx/synth-core';
import { PtyService } from './pty-service.js';

/** Состояние поддельной PTY-сессии (для проверок). */
interface FakeSessionState {
  written: string[];
  killed: string[];
  resizes: Array<[number, number]>;
}

/** Поддельный провайдер PTY: эхо ввода, без нативного модуля. */
function createFakeProvider(): { provider: PtyProvider; sessions: FakeSessionState[] } {
  const sessions: FakeSessionState[] = [];
  const provider: PtyProvider = {
    spawn: () => {
      const state: FakeSessionState = { written: [], killed: [], resizes: [] };
      sessions.push(state);
      const dataListeners = new Set<(chunk: string) => void>();
      const exitListeners = new Set<(e: { exitCode?: number; signal?: string }) => void>();
      let exited = false;
      const session: PtySession = {
        // `pid` намеренно не задан: закрытие в core шлёт сигнал **группе**
        // процессов (`kill(-pid)`) — в тестах это не должно задевать
        // реальные процессы.
        write: (data: string) => {
          state.written.push(data);
          for (const cb of dataListeners) cb(data);
        },
        resize: (cols: number, rows: number) => {
          state.resizes.push([cols, rows]);
        },
        onData: (cb) => {
          dataListeners.add(cb);
          return () => {
            dataListeners.delete(cb);
          };
        },
        onExit: (cb) => {
          exitListeners.add(cb);
          return () => {
            exitListeners.delete(cb);
          };
        },
        kill: (signal?: string) => {
          state.killed.push(signal ?? 'SIGTERM');
          if (exited) return;
          exited = true;
          for (const cb of exitListeners) cb({ exitCode: 0 });
        },
      };
      return session;
    },
  };
  return { provider, sessions };
}

/** Дождаться условия (окно батчинга вывода — десятки мс). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('условие не выполнилось за отведённое время');
}

/** Рабочий каталог и корень workspace для тестов. */
async function makeWorkspace(): Promise<{ root: string; outside: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'synth-pty-ws-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'synth-pty-out-')));
  return { root, outside };
}

describe('PTY-сервис исполнителя', () => {
  it('открывает сессию: id, размеры терминала', async () => {
    const { root } = await makeWorkspace();
    const { provider, sessions } = createFakeProvider();
    const service = new PtyService({
      workspaceRoot: root,
      maxSessions: 4,
      idleTimeoutMs: 60_000,
      inputMaxBytes: 16 * 1024,
      providerFactory: async () => provider,
    });
    try {
      const outcome = await service.open({ cwd: root, cols: 80, rows: 24 });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.created).toBe(true);
      expect(outcome.response.id.startsWith('pty_')).toBe(true);
      expect(outcome.response.cols).toBe(80);
      expect(outcome.response.rows).toBe(24);
      expect(sessions.length).toBe(1);
      const status = service.status(outcome.response.id);
      expect(status?.exited).toBe(false);
      expect(status?.seq).toBe(0);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('лимит живых сессий: превышение → pty_limit', async () => {
    const { root } = await makeWorkspace();
    const { provider } = createFakeProvider();
    const service = new PtyService({
      workspaceRoot: root,
      maxSessions: 1,
      idleTimeoutMs: 60_000,
      inputMaxBytes: 16 * 1024,
      providerFactory: async () => provider,
    });
    try {
      const first = await service.open({ cwd: root, cols: 80, rows: 24 });
      expect(first.ok).toBe(true);
      const second = await service.open({ cwd: root, cols: 80, rows: 24 });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toBe('pty_limit');
      expect(service.liveCount).toBe(1);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('containment: cwd вне workspace → cwd_outside_workspace', async () => {
    const { root, outside } = await makeWorkspace();
    const { provider, sessions } = createFakeProvider();
    const service = new PtyService({
      workspaceRoot: root,
      maxSessions: 4,
      idleTimeoutMs: 60_000,
      inputMaxBytes: 16 * 1024,
      providerFactory: async () => provider,
    });
    try {
      const outcome = await service.open({ cwd: outside, cols: 80, rows: 24 });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toBe('cwd_outside_workspace');
      // Терминал не заводится вовсе.
      expect(sessions.length).toBe(0);
      expect(service.liveCount).toBe(0);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('закрытие: сигнал группе процессов, сессия помечается завершённой', async () => {
    const { root } = await makeWorkspace();
    const { provider, sessions } = createFakeProvider();
    const service = new PtyService({
      workspaceRoot: root,
      maxSessions: 4,
      idleTimeoutMs: 60_000,
      inputMaxBytes: 16 * 1024,
      providerFactory: async () => provider,
    });
    try {
      const outcome = await service.open({ cwd: root, cols: 80, rows: 24 });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const id = outcome.response.id;

      const closed = service.close(id);
      expect(closed.ok).toBe(true);
      expect(sessions[0]?.killed).toContain('SIGTERM');
      await waitFor(() => service.status(id)?.exited === true);
      expect(service.status(id)?.exited).toBe(true);
      // Слот освободился: закрытая сессия не занимает лимит.
      expect(service.liveCount).toBe(0);
      // Повторное закрытие — не ошибка (идемпотентность реестра).
      expect(service.close(id).ok).toBe(true);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('открытие идемпотентно по id: второй терминал не заводится', async () => {
    const { root } = await makeWorkspace();
    const { provider, sessions } = createFakeProvider();
    const service = new PtyService({
      workspaceRoot: root,
      maxSessions: 4,
      idleTimeoutMs: 60_000,
      inputMaxBytes: 16 * 1024,
      providerFactory: async () => provider,
    });
    try {
      const first = await service.open({ id: 'pty_fixed', cwd: root, cols: 80, rows: 24 });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.created).toBe(true);
      expect(first.response.id).toBe('pty_fixed');

      const second = await service.open({ id: 'pty_fixed', cwd: root, cols: 80, rows: 24 });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.created).toBe(false);
      expect(second.response.id).toBe('pty_fixed');
      // Провайдер вызван один раз — терминал один.
      expect(sessions.length).toBe(1);
      expect(service.liveCount).toBe(1);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('повтор вывода: буфер кадров и чтение с номера since', async () => {
    const { root } = await makeWorkspace();
    const { provider } = createFakeProvider();
    const service = new PtyService({
      workspaceRoot: root,
      maxSessions: 4,
      idleTimeoutMs: 60_000,
      inputMaxBytes: 16 * 1024,
      providerFactory: async () => provider,
    });
    try {
      const outcome = await service.open({ cwd: root, cols: 80, rows: 24 });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const id = outcome.response.id;

      const written = service.write(id, 'hello');
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      expect(written.bytes).toBe(5);

      await waitFor(() => (service.framesSince(id, 0) ?? []).length > 0);
      const frames = service.framesSince(id, 0) ?? [];
      expect(frames.length).toBe(1);
      expect(frames[0]?.seq).toBe(1);
      expect(frames[0]?.data).toBe('hello');
      // Клиент, у которого уже есть кадр 1, новых не получает.
      expect(service.framesSince(id, 1)).toEqual([]);
      expect(service.status(id)?.seq).toBe(1);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ввод сверх потолка → payload_too_large', async () => {
    const { root } = await makeWorkspace();
    const { provider } = createFakeProvider();
    const service = new PtyService({
      workspaceRoot: root,
      maxSessions: 4,
      idleTimeoutMs: 60_000,
      inputMaxBytes: 8,
      providerFactory: async () => provider,
    });
    try {
      const outcome = await service.open({ cwd: root, cols: 80, rows: 24 });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const result = service.write(outcome.response.id, '0123456789');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('payload_too_large');
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resize меняет размер терминала; несуществующая сессия — pty_not_found', async () => {
    const { root } = await makeWorkspace();
    const { provider, sessions } = createFakeProvider();
    const service = new PtyService({
      workspaceRoot: root,
      maxSessions: 4,
      idleTimeoutMs: 60_000,
      inputMaxBytes: 16 * 1024,
      providerFactory: async () => provider,
    });
    try {
      const outcome = await service.open({ cwd: root, cols: 80, rows: 24 });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const id = outcome.response.id;

      expect(service.resize(id, 120, 40).ok).toBe(true);
      expect(sessions[0]?.resizes).toEqual([[120, 40]]);
      expect(service.status(id)?.cols).toBe(120);
      expect(service.status(id)?.rows).toBe(40);

      const missing = service.resize('pty_missing', 80, 24);
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.reason).toBe('pty_not_found');
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispose закрывает все живые сессии', async () => {
    const { root } = await makeWorkspace();
    const { provider, sessions } = createFakeProvider();
    const service = new PtyService({
      workspaceRoot: root,
      maxSessions: 4,
      idleTimeoutMs: 60_000,
      inputMaxBytes: 16 * 1024,
      providerFactory: async () => provider,
    });
    const first = await service.open({ cwd: root, cols: 80, rows: 24 });
    const second = await service.open({ cwd: root, cols: 80, rows: 24 });
    expect(first.ok && second.ok).toBe(true);
    expect(sessions.length).toBe(2);

    await service.dispose();
    expect(sessions[0]?.killed.length).toBeGreaterThan(0);
    expect(sessions[1]?.killed.length).toBeGreaterThan(0);
    expect(service.liveCount).toBe(0);
    await rm(root, { recursive: true, force: true });
  });
});
