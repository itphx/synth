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
import type { BackgroundRunRecord, BusEvent } from '@itphx/synth-shared';
import { EventBus } from '../../events/bus.js';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import { MemoryBackgroundRunRepository } from '../../storage/memory/background-runs.js';
import { BackgroundRunService } from '../background/service.js';
import {
  EXECUTION_BACKGROUND_UNSUPPORTED_CODE,
  type ExecBackgroundChunk,
  type ExecBackgroundExit,
  type ExecutionPort,
} from '../../execution/ports/index.js';
import { ProcessService } from './service.js';
import { BackgroundUnsupportedError, type ProcessLogger } from './types.js';

/** Заглушка порта исполнения: фоновый процесс не запускается, выход — вручную. */
function createHarness(opts: {
  onFinished?: (record: BackgroundRunRecord) => void | Promise<void>;
  logger?: ProcessLogger;
} = {}) {
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
  /** Запросы фонового запуска (в них видны секреты вызова). */
  const spawnRequests: Array<{ secrets?: unknown[] }> = [];
  let resolveExit: ((exit: ExecBackgroundExit) => void) | null = null;
  const exited = new Promise<ExecBackgroundExit>((resolve) => {
    resolveExit = resolve;
  });

  const executionPort = {
    execute: async () => ({ stdout: '', stderr: '' }),
    spawnBackground: async (req: { secrets?: unknown[] }) => {
      spawnRequests.push(req);
      return {
        processId: 'proc_1',
        pid: 4242,
        output: (async function* () {
          // вывода нет — процесс ничего не пишет
        })(),
        exited,
        stop: (signal?: NodeJS.Signals) => {
          stopSignals.push(signal);
        },
      };
    },
  } as unknown as ExecutionPort;

  const service = new ProcessService({
    executionPort,
    background,
    blobs: new MemoryBlobStore(),
    eventBus,
    limits: { maxLogBytes: 1024 },
    ...(opts.onFinished ? { onFinished: opts.onFinished } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  return {
    service,
    events,
    stopSignals,
    spawnRequests,
    background,
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

  it('исполнитель без фоновых процессов — BackgroundUnsupportedError (ошибка из другой копии модуля)', async () => {
    const repository = new MemoryBackgroundRunRepository();
    const eventBus = new EventBus();
    const background = new BackgroundRunService({
      repository,
      eventBus,
      limits: { maxSubagentsPerSession: 0, maxProcessesPerSession: 0, maxRunsPerSession: 0 },
      generateId: () => 'id-1',
    });

    // Ошибка — ровно та, что создаёт клиент удалённого порта: она приходит из
    // другой копии модуля core (`dist`), поэтому `instanceof ExecutionError`
    // не срабатывает — опознание идёт структурно (`isExecutionError`).
    const foreignError = {
      name: 'ExecutionError',
      reason: 'spawn_failed',
      message: 'исполнитель не поддерживает фоновые процессы',
      code: EXECUTION_BACKGROUND_UNSUPPORTED_CODE,
    };
    const executionPort = {
      execute: async () => ({ stdout: '', stderr: '' }),
      spawnBackground: async () => {
        throw foreignError;
      },
    } as unknown as ExecutionPort;

    const service = new ProcessService({
      executionPort,
      background,
      blobs: new MemoryBlobStore(),
      eventBus,
      limits: { maxLogBytes: 1024 },
    });

    await expect(
      service.spawn({ sessionId: 's1', command: 'sleep 60', cwd: '/tmp' }),
    ).rejects.toBeInstanceOf(BackgroundUnsupportedError);
  });
});

/**
 * ADR-136/ADR-126 §5: хук терминального перехода фонового процесса.
 *
 * Хук получает **финальную** запись реестра (`status`/`exitCode`/`finishedAt`)
 * — по ней пишется парная запись журнала исполнений (`phase: 'finished'`).
 * Ошибка хука не влияет на процесс: терминальный статус к этому моменту уже
 * зафиксирован.
 */
describe('ProcessService — хук завершения (ADR-136)', () => {
  it('onFinished получает финальную запись (статус/код выхода)', async () => {
    const finished: BackgroundRunRecord[] = [];
    const h = createHarness({ onFinished: (record) => { finished.push(record); } });

    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
    });
    h.resolveExit({ exitCode: 0, signal: null, durationMs: 5 });

    await vi.waitFor(() => {
      expect(finished).toHaveLength(1);
    });
    expect(finished[0]).toMatchObject({
      id: started.runId,
      status: 'completed',
      exitCode: 0,
    });
    expect(finished[0]!.finishedAt).toBeTruthy();
  });

  it('ошибка хука не ломает процесс — запись остаётся completed', async () => {
    const warnings: string[] = [];
    const h = createHarness({
      onFinished: () => {
        throw new Error('аудит не записался');
      },
      logger: { warn: (message: string) => { warnings.push(message); } },
    });

    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
    });
    h.resolveExit({ exitCode: 0, signal: null, durationMs: 5 });

    await vi.waitFor(() => {
      expect(warnings.some((w) => w.includes('хук завершения'))).toBe(true);
    });
    const record = await h.service.get(started.runId);
    expect(record?.status).toBe('completed');
  });
});

/**
 * PROP-124 §7: секреты вызова в фоновом процессе.
 *
 * Материал уходит **в запрос запуска** (значением — точке исполнения), но
 * **не** попадает в запись реестра прогонов и не в лог: иначе приватный ключ
 * оказался бы в персистентном хранилище и в журнале процесса.
 */
describe('ProcessService — секреты вызова', () => {
  it('секреты доходят до порта и не попадают в запись реестра и в лог', async () => {
    const h = createHarness();
    const secret = {
      kind: 'ssh-key' as const,
      privateKey: 'super-secret-private-key',
      mode: 'agent' as const,
    };

    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
      secrets: [secret],
    });

    // Материал ушёл в запрос запуска — точке исполнения.
    expect(h.spawnRequests[0]?.secrets).toEqual([secret]);

    // В записи реестра прогона секрета нет.
    const record = await h.service.get(started.runId);
    expect(record).toBeTruthy();
    expect(JSON.stringify(record)).not.toContain('super-secret-private-key');

    // И в логе процесса — тоже.
    const logs = await h.service.logs(started.runId);
    expect(logs?.content ?? '').not.toContain('super-secret-private-key');
  });

  it('без секретов поле secrets в запрос запуска не появляется', async () => {
    const h = createHarness();

    await h.service.spawn({ sessionId: 's1', command: 'sleep 60', cwd: '/tmp' });

    expect(h.spawnRequests[0]).not.toHaveProperty('secrets');
  });
});

/**
 * ADR-126 §5: `origin` фонового процесса — «запуск человеком» помечается в
 * записи реестра (`metadata.origin`), чтобы реестр прогонов умел отличать
 * пользовательский запуск от агентского (уведомление родителя по нему не
 * отправляется — см. `engine/background/service.ts`).
 */
describe('ProcessService — origin запуска (ADR-126 §5)', () => {
  it('origin: user доходит до startProcess как metadata.origin', async () => {
    const h = createHarness();
    const startProcess = vi.spyOn(h.background, 'startProcess');

    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
      origin: 'user',
    });

    expect(startProcess).toHaveBeenCalledTimes(1);
    expect(startProcess.mock.calls[0]![0]).toMatchObject({
      metadata: { origin: 'user' },
    });

    // И в записи реестра маркер есть.
    const record = await h.service.get(started.runId);
    expect(record?.metadata?.origin).toBe('user');
  });

  it('origin: agent тоже пишется в запись реестра', async () => {
    const h = createHarness();

    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
      origin: 'agent',
    });

    const record = await h.service.get(started.runId);
    expect(record?.metadata?.origin).toBe('agent');
  });

  it('без origin запись реестра не получает metadata', async () => {
    const h = createHarness();

    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'sleep 60',
      cwd: '/tmp',
    });

    const record = await h.service.get(started.runId);
    expect(record?.metadata).toBeUndefined();
  });
});

/**
 * Разделение лога фонового процесса по потокам (ADR-113).
 *
 * Проверяется:
 *   • stdout и stderr попадают в **свои** файлы и в общий лог (порядок
 *     прихода чанков сохраняется);
 *   • предел размера (`background.logMaxBytes`) — свой у каждого файла:
 *     переполнение одного файла не мешает писать остальные;
 *   • `logs({stream})` отдаёт только свой поток;
 *   • у прогона без файлов потоков (старый прогон) — `null`.
 */
describe('ProcessService — разделение лога по потокам', () => {
  /** Песочница с управляемым выводом процесса и доступом к blob-хранилищу. */
  function createStreamHarness(options: { maxLogBytes?: number } = {}) {
    const repository = new MemoryBackgroundRunRepository();
    const eventBus = new EventBus();
    let counter = 0;
    const background = new BackgroundRunService({
      repository,
      eventBus,
      limits: { maxSubagentsPerSession: 0, maxProcessesPerSession: 0, maxRunsPerSession: 0 },
      generateId: () => `id-${++counter}`,
    });

    const queue: ExecBackgroundChunk[] = [];
    let notify: (() => void) | null = null;
    let closed = false;
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

    const executionPort = {
      execute: async () => ({ stdout: '', stderr: '' }),
      spawnBackground: async () => ({
        processId: 'proc_1',
        pid: 4242,
        output,
        exited,
        stop: () => undefined,
      }),
    } as unknown as ExecutionPort;

    const blobs = new MemoryBlobStore();
    const service = new ProcessService({
      executionPort,
      background,
      blobs,
      eventBus,
      limits: { maxLogBytes: options.maxLogBytes ?? 0 },
    });

    return {
      service,
      blobs,
      emit: (stream: 'stdout' | 'stderr', data: string) => {
        queue.push({ stream, data });
        wake();
      },
      finish: (exit: ExecBackgroundExit) => {
        closed = true;
        wake();
        resolveExit(exit);
      },
    };
  }

  it('stdout и stderr пишутся и в свои файлы, и в общий лог (порядок прихода)', async () => {
    const h = createStreamHarness();
    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'npm test',
      cwd: '/tmp',
    });

    h.emit('stdout', 'out-1\n');
    h.emit('stderr', 'err-1\n');
    h.emit('stdout', 'out-2\n');
    h.finish({ exitCode: 0, signal: null, durationMs: 1 });

    await vi.waitFor(async () => {
      const logs = await h.service.logs(started.runId);
      expect(logs?.content).toBe('out-1\nerr-1\nout-2\n');
    });

    // Файлы потоков — только свой поток.
    const stdout = await h.service.logs(started.runId, { stream: 'stdout' });
    expect(stdout?.content).toBe('out-1\nout-2\n');
    const stderr = await h.service.logs(started.runId, { stream: 'stderr' });
    expect(stderr?.content).toBe('err-1\n');

    // Общий лог на месте — путь прогона прежний.
    const combined = await h.blobs.read(`processes/${started.runId}.log`);
    expect(combined?.toString('utf-8')).toBe('out-1\nerr-1\nout-2\n');
    expect(await h.blobs.exists(`processes/${started.runId}.stdout.log`)).toBe(true);
    expect(await h.blobs.exists(`processes/${started.runId}.stderr.log`)).toBe(true);
  });

  it('предел размера — свой у каждого файла: переполнение stdout не мешает stderr', async () => {
    // Предел — 10 байт на файл.
    const h = createStreamHarness({ maxLogBytes: 10 });
    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'npm test',
      cwd: '/tmp',
    });

    h.emit('stdout', '0123456789ABCDEF');
    h.emit('stderr', 'short-err');
    h.finish({ exitCode: 0, signal: null, durationMs: 1 });

    await vi.waitFor(async () => {
      const stderr = await h.service.logs(started.runId, { stream: 'stderr' });
      expect(stderr?.content).toBe('short-err');
    });

    // stdout обрезан по своему пределу.
    const stdout = await h.service.logs(started.runId, { stream: 'stdout' });
    expect(stdout?.totalBytes).toBe(10);
    expect(stdout?.truncated).toBe(true);

    // Общий лог — свой предел: он тоже обрезан.
    const combined = await h.service.logs(started.runId);
    expect(combined?.totalBytes).toBe(10);
    expect(combined?.truncated).toBe(true);

    // Признак усечения потока попадает в запись реестра.
    const record = await h.service.get(started.runId);
    expect(record?.metadata?.truncated).toBe(true);
    expect(record?.metadata?.stdout_truncated).toBe(true);
    expect(record?.metadata?.stderr_truncated).toBeUndefined();
  });

  it('старый прогон без файлов потоков — logs({stream}) отдаёт null', async () => {
    const h = createStreamHarness();
    // Запись реестра без файлов потоков — как у прогона, запущенного до
    // разделения потоков: общий лог есть, файлов потоков нет.
    const started = await h.service.spawn({
      sessionId: 's1',
      command: 'npm test',
      cwd: '/tmp',
    });
    await h.blobs.write(`processes/${started.runId}.log`, 'old-output');

    expect(await h.service.logs(started.runId, { stream: 'stdout' })).toBeNull();
    expect(await h.service.logs(started.runId, { stream: 'stderr' })).toBeNull();
    // Общий лог на месте.
    expect((await h.service.logs(started.runId))?.content).toBe('old-output');
  });
});

describe('ProcessService — живой предел лога (getMaxLogBytes)', () => {
  it('предел нового лога берётся из резолвера, а не из снимка конструктора', async () => {
    const repository = new MemoryBackgroundRunRepository();
    const eventBus = new EventBus();
    let counter = 0;
    const background = new BackgroundRunService({
      repository,
      eventBus,
      limits: { maxSubagentsPerSession: 0, maxProcessesPerSession: 0, maxRunsPerSession: 0 },
      generateId: () => `id-${++counter}`,
    });

    let maxLogBytes = 3;
    /** Один прогон: чанк '0123456789', затем ожидание завершения. */
    const spawn = async (): Promise<void> => {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      let resolveExit!: (exit: ExecBackgroundExit) => void;
      const exited = new Promise<ExecBackgroundExit>((resolve) => { resolveExit = resolve; });
      const executionPort = {
        execute: async () => ({ stdout: '', stderr: '' }),
        spawnBackground: async () => ({
          processId: 'proc_1',
          pid: 4242,
          output: (async function* () {
            yield { stream: 'stdout', data: '0123456789' } as ExecBackgroundChunk;
            await wait;
          })(),
          exited,
          stop: () => undefined,
        }),
      } as unknown as ExecutionPort;
      const service = new ProcessService({
        executionPort,
        background,
        blobs: new MemoryBlobStore(),
        eventBus,
        // Снимок конструктора — большой; действует живой резолвер.
        limits: { maxLogBytes: 1024 },
        getMaxLogBytes: () => maxLogBytes,
      });
      const started = await service.spawn({ sessionId: 's1', command: 'x', cwd: '/tmp' });
      release();
      resolveExit({ exitCode: 0, signal: null, durationMs: 1 });
      await vi.waitFor(async () => {
        const logs = await service.logs(started.runId);
        expect(logs?.totalBytes).toBe(maxLogBytes);
        expect(logs?.truncated).toBe(true);
      });
    };

    await spawn();
    // Изменение резолвера действует на **новый** лог.
    maxLogBytes = 5;
    await spawn();
  });
});
