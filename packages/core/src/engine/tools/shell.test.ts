import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeShellTool } from './shell.js';
import type { ToolContext } from '@itphx/synth-shared';
import type { ProcessService } from '../processes/service.js';

describe('execute_shell — cwd resolution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('без cwd — команда выполняется в рабочем каталоге', async () => {
    const result = await executeShellTool.execute({ command: 'pwd' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(tmpDir);
  });

  it('cwd: относительный путь', async () => {
    await mkdir(join(tmpDir, 'sub'), { recursive: true });
    const result = await executeShellTool.execute({ command: 'pwd', cwd: 'sub' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(join(tmpDir, 'sub'));
  });

  it('cwd: абсолютный путь', async () => {
    const result = await executeShellTool.execute({ command: 'pwd', cwd: tmpDir }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(tmpDir);
  });
});

describe('execute_shell — прерывание по «Стоп» (abortSignal)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-abort-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('abort во время долгой команды: процесс убит, tool_result содержит маркер прерывания и частичный вывод', async () => {
    const ac = new AbortController();
    // exec sleep: sleep заменяет sh — SIGTERM по «Стоп» убивает его напрямую,
    // дочерних процессов-сирот не остаётся
    const promise = executeShellTool.execute(
      { command: 'echo partial-before-stop; exec sleep 60', timeout: 120_000 },
      makeCtx({ abortSignal: ac.signal }),
    );

    // Даём команде стартовать и напечатать частичный вывод
    await new Promise((resolve) => setTimeout(resolve, 500));
    ac.abort();

    const result = await promise;
    const elapsedMs = Date.now();

    // Единый маркер прерывания (консистентно с task.ts)
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.content).toContain('partial-before-stop');
    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
    expect(result.metadata?.partial_output).toContain('partial-before-stop');

    // Процесс убит сразу, а не по 120-секундному таймауту
    expect(Date.now() - elapsedMs).toBeLessThan(30_000);
  });

  it('pre-aborted: команда не стартует (файл-маркер не создаётся)', async () => {
    const ac = new AbortController();
    ac.abort();

    const marker = join(tmpDir, 'should-not-be-created');
    const result = await executeShellTool.execute(
      { command: `touch ${marker}` },
      makeCtx({ abortSignal: ac.signal }),
    );

    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
    expect(result.content).toContain('<status>stopped_by_user</status>');

    // Даём время, если бы команда всё же запустилась
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(access(marker)).rejects.toThrow();
  });

  it('без abortSignal — команда выполняется как раньше (обратная совместимость)', async () => {
    const result = await executeShellTool.execute({ command: 'echo ok' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('ok');
    expect(result.metadata?.interrupted).toBeUndefined();
  });

  it('таймаут (без «Стопа») — обычная ошибка, а не маркер прерывания', async () => {
    const result = await executeShellTool.execute(
      { command: 'sleep 5', timeout: 1000 },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Error');
    expect(result.metadata?.interrupted).toBeUndefined();
    expect(result.metadata?.stopped_by).toBeUndefined();
  });
});

describe('execute_shell — фоновый запуск (background: true)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-bg-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(extra: Record<string, unknown>): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra,
    };
  }

  it('backgroundEnabled=false — отказ process.background_disabled, процесс не запущен', async () => {
    const spawn = vi.fn();
    const processService = { spawn } as unknown as ProcessService;

    const result = await executeShellTool.execute(
      { command: 'sleep 1', background: true },
      makeCtx({ processService, backgroundEnabled: false }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Background processes are disabled');
    expect(result.metadata?.i18n).toMatchObject({ key: 'process.background_disabled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('backgroundEnabled=true — процесс запущен (гейт не мешает)', async () => {
    const spawn = vi.fn().mockResolvedValue({
      runId: 'bgr_1',
      processId: 'proc_1',
      logPath: 'processes/bgr_1.log',
    });
    const processService = { spawn } as unknown as ProcessService;

    const result = await executeShellTool.execute(
      { command: 'sleep 1', background: true },
      makeCtx({ processService, backgroundEnabled: true }),
    );

    expect(result.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.metadata?.process_id).toBe('proc_1');
  });
});
