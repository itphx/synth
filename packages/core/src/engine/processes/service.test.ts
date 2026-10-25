/**
 * Этап 1 roadmap 0.13 (блок 5b): фоновые шелл-процессы
 * (`engine/processes/service.ts`) — остановка прогона.
 *
 * Проверяется:
 *   • успешный `stop` публикует `process.stopped` в канал владельца
 *     (поля `process_id`/`session_id`/`background_run_id`/`reason`);
 *   • повторный `stop` того же прогона событие **не** дублирует;
 *   • фактический выход процесса по-прежнему даёт `process.exited`
 *     (остановка не ломает терминальный переход).
 *
 * Изолированно: memory-порт реестра, memory-blob для лога, порт исполнения —
 * заглушка (реальный процесс не запускается), без сети.
 */
import { describe, it, expect, vi } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus } from '../../events/bus.js';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import { MemoryBackgroundRunRepository } from '../../storage/memory/background-runs.js';
import { BackgroundRunService } from '../background/service.js';
import type { ExecBackgroundExit, ExecutionPort } from '../../execution/ports/index.js';
import { ProcessService } from './service.js';

/** Заглушка порта исполнения: фоновый процесс не запускается, выход — вручную. */
function createHarness() {
  const repository = new MemoryBackgroundRunRepository();
  const eventBus = new EventBus();
  const events: BusEvent[] = [];
  eventBus.subscribe('s1', (e) => events.push(e));

  let counter = 0;
  const background = new BackgroundRunService({
    repository,
    eventBus,
    limits: { maxSubagentsPerSession: 0, maxProcessesPerSession: 0, maxRunsPerSession: 0 },
    generateId: () => `id-${++counter}`,
  });

  const stopSignals: (NodeJS.Signals | undefined)[] = [];
  let resolveExit: ((exit: ExecBackgroundExit) => void) | null = null;
  const exited = new Promise<ExecBackgroundExit>((resolve) => {
    resolveExit = resolve;
  });

  const executionPort = {
    execute: async () => ({ stdout: '', stderr: '' }),
    spawnBackground: async () => ({
      processId: 'proc_1',
      pid: 4242,
      output: (async function* () {
        // вывода нет — процесс ничего не пишет
      })(),
      exited,
      stop: (signal?: NodeJS.Signals) => {
        stopSignals.push(signal);
      },
    }),
  } as unknown as ExecutionPort;

  const service = new ProcessService({
    executionPort,
    background,
    blobs: new MemoryBlobStore(),
    eventBus,
    limits: { maxLogBytes: 1024 },
  });

  return {
    service,
    events,
    stopSignals,
    resolveExit: (exit: ExecBackgroundExit) => resolveExit?.(exit),
  };
}

describe('ProcessService — остановка фонового процесса', () => {
  it('stop публикует process.stopped в канал владельца', async () => {
    const h = createHarness();
    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
    });

    const stopped = await h.service.stop(started.runId, 'user_request');

    expect(stopped).toBe(true);
    // Процессу ушёл SIGTERM (эскалация до SIGKILL — по таймеру).
    expect(h.stopSignals).toContain('SIGTERM');

    const event = h.events.find((e) => e.type === 'process.stopped');
    expect(event).toBeTruthy();
    expect(event!.sessionId).toBe('s1');
    expect(event!.data).toMatchObject({
      process_id: 'proc_1',
      session_id: 's1',
      background_run_id: started.runId,
      reason: 'user_request',
    });
  });

  it('повторный stop того же прогона не дублирует событие', async () => {
    const h = createHarness();
    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
    });

    await h.service.stop(started.runId);
    await h.service.stop(started.runId);

    expect(h.events.filter((e) => e.type === 'process.stopped')).toHaveLength(1);
  });

  it('после фактического выхода приходит process.exited (остановка не ломает выход)', async () => {
    const h = createHarness();
    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
    });

    await h.service.stop(started.runId);
    h.resolveExit({ exitCode: null, signal: 'SIGTERM', durationMs: 10 });

    await vi.waitFor(() => {
      expect(h.events.some((e) => e.type === 'process.exited')).toBe(true);
    });
    const exited = h.events.find((e) => e.type === 'process.exited')!;
    expect(exited.data).toMatchObject({
      state: 'cancelled',
      background_run_id: started.runId,
    });
  });

  it('stop несуществующего прогона — false, события нет', async () => {
    const h = createHarness();

    expect(await h.service.stop('bgr_missing')).toBe(false);
    expect(h.events.filter((e) => e.type === 'process.stopped')).toHaveLength(0);
  });
});
