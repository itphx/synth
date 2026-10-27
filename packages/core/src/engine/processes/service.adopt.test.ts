/**
 * ADR-113 §«Detach идущего шелла»: `ProcessService.adopt` — приём **уже
 * идущего** процесса в фон.
 *
 * Проверяется:
 *   • запись реестра создаётся в статусе `running`, `processId` — от хэндла;
 *   • в лог попадает буферизованный префикс (`bufferedStdout` +
 *     `bufferedStderr`) и последующие чанки итератора;
 *   • публикуются `process.started` (реестр) и `process.detached` (detach);
 *   • `stop` вызывает `handle.stop('SIGTERM')`;
 *   • завершение даёт терминальный статус (`completed`/`failed` по коду) и
 *     уведомление родителя;
 *   • уже завершившийся к моменту `adopt` процесс закрывает запись сразу;
 *   • лимит прогонов → `BackgroundLimitExceededError`, процесс **не**
 *     останавливается (тул продолжает читать его в foreground).
 *
 * Изолированно: memory-порт реестра, memory-blob для лога, фейковый хэндл
 * порта (реальный процесс не запускается).
 */
import { describe, it, expect, vi } from 'vitest';
import type { BusEvent, Message } from '@itphx/synth-shared';
import { EventBus } from '../../events/bus.js';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import { MemoryBackgroundRunRepository } from '../../storage/memory/background-runs.js';
import { BackgroundRunService } from '../background/service.js';
import type { ExecBackgroundChunk, ExecBackgroundExit, ExecBackgroundProcess } from '../../execution/ports/index.js';
import { ProcessService } from './service.js';
import type { ProcessLimits } from './types.js';

/** Фейковый фоновый процесс: вывод и завершение управляются из теста. */
interface FakeProcess {
  proc: ExecBackgroundProcess;
  /** Отдать кусок вывода. */
  emit(stream: 'stdout' | 'stderr', data: string): void;
  /** Завершить процесс. */
  finish(exit: ExecBackgroundExit): void;
  /** Сигналы, отправленные через `stop()`. */
  stopSignals: (NodeJS.Signals | undefined)[];
  /** Итератор вывода (тот же, что отдаёт хэндл). */
  iterator: AsyncIterator<ExecBackgroundChunk>;
}

function createFakeProcess(processId = 'proc_1', pid?: number): FakeProcess {
  const queue: ExecBackgroundChunk[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  const stopSignals: (NodeJS.Signals | undefined)[] = [];
  let resolveExit!: (exit: ExecBackgroundExit) => void;
  const exited = new Promise<ExecBackgroundExit>((resolve) => {
    resolveExit = resolve;
  });

  const wake = (): void => {
    const resolve = notify;
    notify = null;
    resolve?.();
  };

  const output: AsyncIterable<ExecBackgroundChunk> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as ExecBackgroundChunk;
        if (closed) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };

  return {
    proc: {
      processId,
      ...(pid !== undefined ? { pid } : {}),
      output,
      exited,
      stop: (signal?: NodeJS.Signals) => {
        stopSignals.push(signal);
      },
    },
    emit: (stream, data) => {
      queue.push({ stream, data });
      wake();
    },
    finish: (exit) => {
      closed = true;
      wake();
      resolveExit(exit);
    },
    stopSignals,
    iterator: output[Symbol.asyncIterator](),
  };
}

function createHarness(options: { limits?: Partial<ProcessLimits>; backgroundLimits?: { maxProcessesPerSession?: number } } = {}) {
  const repository = new MemoryBackgroundRunRepository();
  const eventBus = new EventBus();
  const events: BusEvent[] = [];
  eventBus.subscribe('s1', (event) => events.push(event));
  const notifications: Message[] = [];

  let counter = 0;
  const background = new BackgroundRunService({
    repository,
    eventBus,
    limits: {
      maxSubagentsPerSession: 0,
      maxProcessesPerSession: options.backgroundLimits?.maxProcessesPerSession ?? 0,
      maxRunsPerSession: 0,
    },
    generateId: () => `id-${++counter}`,
    onNotifyParent: async (_sessionId, message) => {
      notifications.push(message);
    },
  });

  const service = new ProcessService({
    executionPort: { execute: async () => ({ stdout: '', stderr: '' }) } as never,
    background,
    blobs: new MemoryBlobStore(),
    eventBus,
    limits: { maxLogBytes: options.limits?.maxLogBytes ?? 0 },
  });

  return { service, events, notifications };
}

describe('ProcessService.adopt — перевод идущего процесса в фон', () => {
  it('создаёт запись running и пишет в лог префикс + последующие чанки', async () => {
    const h = createHarness();
    const fake = createFakeProcess('proc_42', 4242);

    const adopted = await h.service.adopt({
      sessionId: 's1',
      command: 'npm run dev',
      cwd: '/tmp',
      pid: 4242,
      processId: 'proc_42',
      handle: fake.proc,
      iterator: fake.iterator,
      bufferedStdout: 'early-out\n',
      bufferedStderr: 'early-err\n',
      title: 'npm run dev',
    });

    expect(adopted).toMatchObject({
      runId: 'bgr_id-1',
      processId: 'proc_42',
      logPath: 'processes/bgr_id-1.log',
      pid: 4242,
    });

    const running = await h.service.get(adopted.runId);
    expect(running?.status).toBe('running');
    expect(running?.command).toBe('npm run dev');

    // События: `process.started` — реестр (UI создаёт запись), `process.detached` — detach.
    const started = h.events.findIndex((e) => e.type === 'process.started');
    const detached = h.events.findIndex((e) => e.type === 'process.detached');
    expect(started).toBeGreaterThanOrEqual(0);
    expect(detached).toBeGreaterThan(started);
    expect(h.events[detached]!.data).toMatchObject({
      session_id: 's1',
      kind: 'process',
      id: adopted.runId,
      process_id: 'proc_42',
      background_run_id: adopted.runId,
      title: 'npm run dev',
    });

    // Префикс — первым, затем вывод, пришедший уже после перевода.
    fake.emit('stdout', 'later-out\n');
    fake.emit('stderr', 'later-err\n');
    await vi.waitFor(async () => {
      const logs = await h.service.logs(adopted.runId);
      expect(logs?.content).toBe('early-out\nearly-err\nlater-out\nlater-err\n');
    });

    fake.finish({ exitCode: 0, signal: null, durationMs: 5 });
  });

  it('stop вызывает handle.stop(SIGTERM) и публикует process.stopped', async () => {
    const h = createHarness();
    const fake = createFakeProcess();
    const adopted = await h.service.adopt({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
      processId: 'proc_1',
      handle: fake.proc,
      iterator: fake.iterator,
      bufferedStdout: '',
      bufferedStderr: '',
    });

    expect(await h.service.stop(adopted.runId, 'user_request')).toBe(true);
    expect(fake.stopSignals).toContain('SIGTERM');
    expect(h.events.find((e) => e.type === 'process.stopped')?.data).toMatchObject({
      process_id: 'proc_1',
      background_run_id: adopted.runId,
    });

    fake.finish({ exitCode: null, signal: 'SIGTERM', durationMs: 5 });
  });

  it('завершение с кодом 0 → completed, лог и уведомление родителя', async () => {
    const h = createHarness();
    const fake = createFakeProcess();
    const adopted = await h.service.adopt({
      sessionId: 's1',
      command: 'echo done',
      cwd: '/tmp',
      processId: 'proc_1',
      handle: fake.proc,
      iterator: fake.iterator,
      bufferedStdout: 'out-before\n',
      bufferedStderr: '',
    });

    fake.emit('stdout', 'out-after\n');
    fake.finish({ exitCode: 0, signal: null, durationMs: 7 });

    await vi.waitFor(async () => {
      expect((await h.service.get(adopted.runId))?.status).toBe('completed');
    });
    const record = await h.service.get(adopted.runId);
    expect(record?.exitCode).toBe(0);
    // Хвост лога — он же summary и тело уведомления.
    expect(record?.summary).toContain('out-after');

    await vi.waitFor(() => expect(h.notifications).toHaveLength(1));
    expect(h.notifications[0]!.content).toContain('<process');
    expect(h.notifications[0]!.content).toContain('out-after');
  });

  it('завершение с ненулевым кодом → failed', async () => {
    const h = createHarness();
    const fake = createFakeProcess();
    const adopted = await h.service.adopt({
      sessionId: 's1',
      command: 'false',
      cwd: '/tmp',
      processId: 'proc_1',
      handle: fake.proc,
      iterator: fake.iterator,
      bufferedStdout: '',
      bufferedStderr: 'boom\n',
    });

    fake.finish({ exitCode: 2, signal: null, durationMs: 3 });

    await vi.waitFor(async () => {
      expect((await h.service.get(adopted.runId))?.status).toBe('failed');
    });
    expect((await h.service.get(adopted.runId))?.exitCode).toBe(2);
  });

  it('процесс уже завершился к моменту adopt — запись закрывается, runId возвращается', async () => {
    const h = createHarness();
    const fake = createFakeProcess();
    const adopted = await h.service.adopt({
      sessionId: 's1',
      command: 'true',
      cwd: '/tmp',
      processId: 'proc_1',
      handle: fake.proc,
      iterator: fake.iterator,
      bufferedStdout: 'all-output\n',
      bufferedStderr: '',
    });
    fake.finish({ exitCode: 0, signal: null, durationMs: 1 });

    await vi.waitFor(async () => {
      expect((await h.service.get(adopted.runId))?.status).toBe('completed');
    });
    expect((await h.service.logs(adopted.runId))?.content).toContain('all-output');
  });

  it('лимит прогонов → BackgroundLimitExceededError, процесс не останавливается', async () => {
    const h = createHarness({ backgroundLimits: { maxProcessesPerSession: 1 } });
    const first = createFakeProcess('proc_1');
    await h.service.adopt({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
      processId: 'proc_1',
      handle: first.proc,
      iterator: first.iterator,
      bufferedStdout: '',
      bufferedStderr: '',
    });

    const second = createFakeProcess('proc_2');
    await expect(
      h.service.adopt({
        sessionId: 's1',
        command: 'sleep 60',
        cwd: '/tmp',
        processId: 'proc_2',
        handle: second.proc,
        iterator: second.iterator,
        bufferedStdout: 'kept\n',
        bufferedStderr: '',
      }),
    ).rejects.toMatchObject({ name: 'BackgroundLimitExceededError', limitKind: 'processes' });

    // Процесс продолжает жить: тул читает его в foreground, гасить нечего.
    expect(second.stopSignals).toHaveLength(0);
    expect(await h.service.list({ sessionId: 's1' })).toHaveLength(1);

    first.finish({ exitCode: 0, signal: null, durationMs: 1 });
    second.finish({ exitCode: 0, signal: null, durationMs: 1 });
  });
});
