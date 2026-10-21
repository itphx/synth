import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { egressFetch, ExecutionError } from '@itphx/synth-core';
import { createRemoteExecutionPort, type ExecutorFetch } from './client.js';
import { startExecutorServer, type ExecutorHandle } from './server.js';

const TOKEN = 'executor-client-token-test-1234567890';

let workspace: string;
let handles: ExecutorHandle[] = [];

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-client-')));
});

afterEach(async () => {
  for (const handle of handles) await handle.close();
  handles = [];
  await rm(workspace, { recursive: true, force: true });
});

/** Поднять исполнитель на случайном порту. */
async function startExecutor(): Promise<ExecutorHandle> {
  const handle = await startExecutorServer({
    token: TOKEN,
    workspaceRoot: workspace,
    host: '127.0.0.1',
    port: 0,
    toolchain: {},
  });
  handles.push(handle);
  return handle;
}

/** Порт, на котором никто не слушает (соединение отклоняется). */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('клиент удалённого порта', () => {
  it('успешный вызов — stdout/exitCode/durationMs', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });
    const res = await port.execute({ command: { kind: 'shell', command: 'printf out' } });
    expect(res.stdout).toBe('out');
    expect(res.stderr).toBe('');
    expect(res.exitCode).toBe(0);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ненулевой код выхода — ExecutionError с reason nonzero_exit', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });
    await expect(
      port.execute({ command: { kind: 'shell', command: 'printf o; exit 7' } }),
    ).rejects.toMatchObject({ reason: 'nonzero_exit', code: 7, stdout: 'o' });
  });

  it('адреса перебираются по кругу (round-robin)', async () => {
    const first = await startExecutor();
    const second = await startExecutor();
    const hits: string[] = [];
    const counting: ExecutorFetch = async (url, init) => {
      hits.push(new URL(url).port);
      return egressFetch(url, init);
    };
    const port = createRemoteExecutionPort({
      urls: [first.url, second.url],
      token: TOKEN,
      fetchImpl: counting,
    });
    await port.execute({ command: { kind: 'shell', command: 'printf 1' } });
    await port.execute({ command: { kind: 'shell', command: 'printf 2' } });
    await port.execute({ command: { kind: 'shell', command: 'printf 3' } });
    expect(hits).toEqual([String(first.port), String(second.port), String(first.port)]);
  });

  it('ошибка соединения — переход на следующий адрес', async () => {
    const handle = await startExecutor();
    const dead = await deadPort();
    const port = createRemoteExecutionPort({
      urls: [`http://127.0.0.1:${dead}`, handle.url],
      token: TOKEN,
    });
    const res = await port.execute({ command: { kind: 'shell', command: 'printf ok' } });
    expect(res.stdout).toBe('ok');
  });

  it('failMode "fail" — все адреса недоступны → ExecutionError (fail-closed)', async () => {
    const dead = await deadPort();
    const port = createRemoteExecutionPort({
      urls: [`http://127.0.0.1:${dead}`],
      token: TOKEN,
      failMode: 'fail',
    });
    const err = await port.execute({ command: { kind: 'shell', command: 'printf ok' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).reason).toBe('spawn_failed');
    expect((err as ExecutionError).code).toBe('EUNREACHABLE');
  });

  it('failMode "inline-fallback" — исполнение в процессе', async () => {
    const dead = await deadPort();
    const port = createRemoteExecutionPort({
      urls: [`http://127.0.0.1:${dead}`],
      token: TOKEN,
      failMode: 'inline-fallback',
    });
    const res = await port.execute({ command: { kind: 'shell', command: 'printf local' } });
    expect(res.stdout).toBe('local');
  });

  it('отмена по AbortSignal — ExecutionError с reason aborted', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });
    const ac = new AbortController();
    const promise = port.execute({
      command: { kind: 'shell', command: 'sleep 5' },
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 150);
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).reason).toBe('aborted');
  });

  it('лимит одновременных вызовов — остальные ждут в очереди', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({
      urls: [handle.url],
      token: TOKEN,
      concurrency: 1,
    });
    const started = Date.now();
    await Promise.all([
      port.execute({ command: { kind: 'shell', command: 'sleep 0.3' } }),
      port.execute({ command: { kind: 'shell', command: 'sleep 0.3' } }),
    ]);
    // Второй вызов ждал завершения первого (лимит — одна одновременная команда).
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it('неверный токен — ошибка сервера реконструируется в ExecutionError', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: 'wrong-token' });
    const err = await port.execute({ command: { kind: 'shell', command: 'printf x' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('EAUTH');
  });

  it('cwd вне workspace — ошибка cwd_outside_workspace', async () => {
    const handle = await startExecutor();
    const port = createRemoteExecutionPort({ urls: [handle.url], token: TOKEN });
    const err = await port
      .execute({ command: { kind: 'shell', command: 'pwd' }, cwd: '/etc' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe('EWORKSPACE');
  });
});
