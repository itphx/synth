/**
 * ADR-113 §«Detach идущего шелла»: detach-готовый foreground-путь
 * `execute_shell` (`engine/tools/shell-detachable.ts`).
 *
 * Проверяется:
 *   • detach посреди команды → тул возвращает управление сразу, `adopt`
 *     получает **тот же** итератор и накопленные буферы, `unregister` вызван;
 *   • завершение без detach → прежний результат (stdout/stderr, `isError` при
 *     ненулевом коде);
 *   • «Стоп» до detach → `handle.stop('SIGTERM')`; после detach — не вызывается;
 *   • лимит в `adopt` → отказ в реестре активных прогонов (`BACKGROUND_LIMIT`),
 *     тул продолжает читать команду и возвращает её результат;
 *   • detach снимает foreground-таймаут (`retime(0)`) **до** `adopt`; отказ
 *     `adopt` возвращает прежний срок, а хэндл без `retime` (старый
 *     исполнитель) — отказ `DETACH_FAILED` без перевода в фон;
 *   • порт без `spawnBackground` → прежний путь через `execute`, регистрации нет.
 *
 * Порт — заглушка (процесс не запускается), фабрика процессов — мок: тест
 * проверяет только контракт «тул ↔ реестр ↔ сервис».
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import type { ExecBackgroundChunk, ExecBackgroundExit, ExecBackgroundProcess, ExecutionPort } from '../../execution/ports/index.js';
import { InlineExecutionPort } from '../../execution/inline-execution-port.js';
import { EventBus } from '../../events/bus.js';
import { MemoryBackgroundRunRepository } from '../../storage/memory/background-runs.js';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import { ActiveRunRegistry } from '../background/active-runs.js';
import { BackgroundRunService } from '../background/service.js';
import { BackgroundLimitExceededError } from '../background/types.js';
import { ProcessService } from '../processes/service.js';
import { executeShellTool } from './shell.js';

/** Фейковый фоновый процесс: вывод и завершение управляются из теста. */
interface FakeProcess {
  proc: ExecBackgroundProcess;
  emit(stream: 'stdout' | 'stderr', data: string): void;
  finish(exit: ExecBackgroundExit): void;
  stopSignals: (NodeJS.Signals | undefined)[];
  /** Аргументы, с которыми вызывали `retime` (порядок вызовов). */
  retimeCalls: number[];
}

function createFakeProcess(
  processId = 'proc_1',
  opts: { retime?: boolean; order?: string[] } = {},
): FakeProcess {
  const queue: ExecBackgroundChunk[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  const stopSignals: (NodeJS.Signals | undefined)[] = [];
  const retimeCalls: number[] = [];
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

  const proc: ExecBackgroundProcess = {
    processId,
    pid: 4242,
    output,
    exited,
    stop: (signal?: NodeJS.Signals) => {
      stopSignals.push(signal);
    },
  };
  // `retime` — как у живой точки исполнения; `retime: false` имитирует старый
  // исполнитель (протокол < 10): метода у хэндла нет.
  if (opts.retime !== false) {
    proc.retime = (timeoutMs: number) => {
      retimeCalls.push(timeoutMs);
      opts.order?.push(`retime:${timeoutMs}`);
    };
  }

  return {
    proc,
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
    retimeCalls,
  };
}

/** Вход `adopt`, который получил сервис (проверяется в тестах detach). */
interface AdoptedInput {
  sessionId: string;
  command: string;
  cwd: string;
  processId: string;
  iterator: AsyncIterator<ExecBackgroundChunk>;
  bufferedStdout?: string;
  bufferedStderr?: string;
  liveLog?: { logPath: string };
  pid?: number;
  title?: string;
}

function createHarness(
  options: { withSpawnBackground?: boolean; retime?: boolean; openLiveLogFails?: boolean } = {},
) {
  /** Общий журнал порядка событий «перестановка срока ↔ adopt». */
  const order: string[] = [];
  const fake = createFakeProcess('proc_1', {
    ...(options.retime !== undefined ? { retime: options.retime } : {}),
    order,
  });
  const execute = vi.fn(async () => ({
    stdout: 'sync-out',
    stderr: '',
    exitCode: 0,
    truncated: false,
    durationMs: 1,
  }));
  const port = {
    execute,
    ...(options.withSpawnBackground === false
      ? {}
      : { spawnBackground: vi.fn(async () => fake.proc) }),
  } as unknown as ExecutionPort;

  const adopted: AdoptedInput[] = [];
  const adopt = vi.fn(async (input: AdoptedInput) => {
    order.push('adopt');
    adopted.push(input);
    return { runId: 'bgr_1', processId: input.processId, logPath: 'processes/bgr_1.log' };
  });
  // Живого лога нет: сервис без `openLiveLog` (старый исполнитель) либо его
  // открытие падает (blob недоступен) — оба случая проверяются одинаково.
  const processService = (
    options.openLiveLogFails
      ? {
          adopt,
          openLiveLog: vi.fn(async () => {
            throw new Error('blob-хранилище недоступно');
          }),
        }
      : { adopt }
  ) as unknown as ProcessService;
  const registry = new ActiveRunRegistry();

  return { fake, port, adopt, adopted, processService, registry, execute, order };
}

describe('execute_shell — detach идущего шелла (ADR-113)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-detach-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(extra: Record<string, unknown>, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra,
      ...overrides,
    };
  }

  it('detach посреди команды: тул вернул сразу, adopt получил буферы и тот же итератор', async () => {
    const h = createHarness();
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const promise = executeShellTool.execute({ command: 'npm run dev' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    expect(h.registry.list('s1')[0]).toMatchObject({ id: 'proc_1', kind: 'process', title: 'npm run dev' });

    // Вывод до detach накапливается тулом.
    h.fake.emit('stdout', 'early\n');
    h.fake.emit('stderr', 'warn\n');
    await vi.waitFor(async () => {
      // Ждём, пока цикл чтения обработает оба куска: повторный detach увидит их
      // в буферах (проверяем через сам результат ниже).
      expect(h.registry.list('s1')).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const detached = await h.registry.detachAll('s1');
    expect(detached.failed).toHaveLength(0);
    expect(detached.detached).toEqual([
      expect.objectContaining({
        id: 'proc_1',
        kind: 'process',
        title: 'npm run dev',
        sessionId: 's1',
        processId: 'proc_1',
        startedAt: expect.any(Number),
      }),
    ]);

    const result = await promise;
    expect(result.isError).toBeFalsy();
    // Причина перевода — инициатива пользователя (отдельный ключ, не
    // агентский `background: true`).
    expect(result.content).toContain("moved to the background at the user's request");
    expect(result.metadata?.detached).toBe(true);
    expect(result.metadata).toMatchObject({
      process_id: 'proc_1',
      background_run_id: 'bgr_1',
      log_path: 'processes/bgr_1.log',
    });

    // Сервис получил накопленные буферы и итератор того же хэндла.
    expect(h.adopt).toHaveBeenCalledTimes(1);
    const input = h.adopted[0]!;
    expect(input).toMatchObject({
      sessionId: 's1',
      command: 'npm run dev',
      cwd: tmpDir,
      processId: 'proc_1',
      pid: 4242,
      bufferedStdout: 'early\n',
      bufferedStderr: 'warn\n',
      title: 'npm run dev',
    });
    // Реестр активных прогонов очищен: foreground-обёртка завершена.
    expect(h.registry.list('s1')).toHaveLength(0);

    // Тот же итератор: вывод, пришедший после detach, доходит до сервиса.
    h.fake.emit('stdout', 'after\n');
    const next = await input.iterator.next();
    expect(next.done).toBe(false);
    expect(next.value).toEqual({ stream: 'stdout', data: 'after\n' });

    h.fake.finish({ exitCode: 0, signal: null, durationMs: 10 });
  });

  it('detach с причиной `message`: текст про новое сообщение пользователя', async () => {
    const h = createHarness();
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const promise = executeShellTool.execute({ command: 'npm test' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));

    // Авто-detach при вмешательстве: причина передаётся в хэндл.
    const detached = await h.registry.detachAll('s1', { reason: 'message' });
    expect(detached.failed).toHaveLength(0);

    const result = await promise;
    expect(result.content).toContain('because of a new user message');
    expect(result.content).toContain("The user's message will be handled next");
    expect(result.metadata?.detached).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({ key: 'background.detached.process_message' });
    h.fake.finish({ exitCode: 0, signal: null, durationMs: 10 });
  });

  it('завершение без detach: прежний результат (stdout + stderr, isError при ненулевом коде)', async () => {
    const h = createHarness();
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const ok = executeShellTool.execute({ command: 'echo hi' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    h.fake.emit('stdout', 'hi\n');
    h.fake.emit('stderr', 'note\n');
    h.fake.finish({ exitCode: 0, signal: null, durationMs: 4 });

    const result = await ok;
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('hi\n\n--- stderr ---\nnote\n');
    expect(result.metadata).toMatchObject({ exitCode: 0, truncated: false });
    expect(h.adopt).not.toHaveBeenCalled();
    // Регистрация снята без detach.
    expect(h.registry.list('s1')).toHaveLength(0);
  });

  it('ненулевой код выхода без detach → isError и tool.shell_error', async () => {
    const h = createHarness();
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const promise = executeShellTool.execute({ command: 'false' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    h.fake.emit('stdout', 'partial\n');
    h.fake.finish({ exitCode: 2, signal: null, durationMs: 4 });

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content).toContain('partial');
    expect(result.content).toContain('Error:');
    expect(result.metadata).toMatchObject({ exitCode: 2 });
  });

  it('«Стоп» до detach убивает процесс и даёт маркер прерывания', async () => {
    const h = createHarness();
    const ac = new AbortController();
    const ctx = makeCtx(
      {
        processService: h.processService,
        activeRuns: h.registry,
        backgroundEnabled: true,
        executionPort: h.port,
      },
      { abortSignal: ac.signal },
    );

    const promise = executeShellTool.execute({ command: 'sleep 60' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    h.fake.emit('stdout', 'before-stop\n');
    await new Promise((resolve) => setTimeout(resolve, 20));

    ac.abort();
    expect(h.fake.stopSignals).toContain('SIGTERM');
    h.fake.finish({ exitCode: null, signal: 'SIGTERM', durationMs: 5 });

    const result = await promise;
    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.content).toContain('before-stop');
  });

  it('после detach «Стоп» родителя процесс не убивает', async () => {
    const h = createHarness();
    const ac = new AbortController();
    const ctx = makeCtx(
      {
        processService: h.processService,
        activeRuns: h.registry,
        backgroundEnabled: true,
        executionPort: h.port,
      },
      { abortSignal: ac.signal },
    );

    const promise = executeShellTool.execute({ command: 'npm run dev' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    await h.registry.detachAll('s1');
    await promise;

    expect(h.fake.stopSignals).toHaveLength(0);
    ac.abort();
    expect(h.fake.stopSignals).toHaveLength(0);

    h.fake.finish({ exitCode: 0, signal: null, durationMs: 5 });
  });

  it('лимит в adopt: отказ в реестре (BACKGROUND_LIMIT), тул продолжает читать команду', async () => {
    const h = createHarness();
    h.adopt.mockRejectedValueOnce(
      new BackgroundLimitExceededError('processes', 1, 'лимит фоновых процессов'),
    );
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const promise = executeShellTool.execute({ command: 'npm run dev' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    h.fake.emit('stdout', 'before\n');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const detached = await h.registry.detachAll('s1');
    expect(detached.detached).toHaveLength(0);
    expect(detached.failed).toEqual([
      expect.objectContaining({ id: 'proc_1', kind: 'process', code: 'BACKGROUND_LIMIT' }),
    ]);

    // Прогон остаётся foreground: команда продолжает читаться тулом.
    expect(h.registry.list('s1')).toHaveLength(1);
    h.fake.emit('stdout', 'after-limit\n');
    h.fake.finish({ exitCode: 0, signal: null, durationMs: 5 });

    const result = await promise;
    expect(result.metadata?.detached).toBeUndefined();
    expect(result.content).toContain('before');
    expect(result.content).toContain('after-limit');
  });

  it('detach снимает foreground-таймаут (retime(0)) до adopt', async () => {
    const h = createHarness();
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const promise = executeShellTool.execute({ command: 'npm run dev' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    h.fake.emit('stdout', 'early\n');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const detached = await h.registry.detachAll('s1');
    expect(detached.failed).toHaveLength(0);
    expect(detached.detached).toHaveLength(1);
    await promise;

    // Таймаут снят ровно один раз, и это произошло **до** передачи процесса
    // в сервис фоновых прогонов.
    expect(h.fake.retimeCalls).toEqual([0]);
    expect(h.order.indexOf('retime:0')).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf('retime:0')).toBeLessThan(h.order.indexOf('adopt'));

    h.fake.finish({ exitCode: 0, signal: null, durationMs: 10 });
  });

  it('adopt упал (лимит): прежний срок восстанавливается, тул ждёт команду', async () => {
    const h = createHarness();
    h.adopt.mockRejectedValueOnce(
      new BackgroundLimitExceededError('processes', 1, 'лимит фоновых процессов'),
    );
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const promise = executeShellTool.execute({ command: 'npm run dev' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    h.fake.emit('stdout', 'before\n');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const detached = await h.registry.detachAll('s1');
    expect(detached.detached).toHaveLength(0);
    expect(detached.failed).toEqual([
      expect.objectContaining({ id: 'proc_1', kind: 'process', code: 'BACKGROUND_LIMIT' }),
    ]);
    // Срок восстановлен на исходный (foreground-дефолт `execute_shell` — 120 с).
    expect(h.fake.retimeCalls).toEqual([0, 120_000]);

    // Прогон остаётся foreground: команда продолжает читаться тулом.
    expect(h.registry.list('s1')).toHaveLength(1);
    h.fake.emit('stdout', 'after-limit\n');
    h.fake.finish({ exitCode: 0, signal: null, durationMs: 5 });

    const result = await promise;
    expect(result.metadata?.detached).toBeUndefined();
    expect(result.content).toContain('before');
    expect(result.content).toContain('after-limit');
  });

  it('хэндл без retime: detach отклонён (DETACH_FAILED), прогон остаётся foreground', async () => {
    // Старый исполнитель (протокол < 10): переставить таймаут нечем — молча
    // оставить foreground-срок нельзя, иначе команда умерла бы в фоне.
    const h = createHarness({ retime: false });
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const promise = executeShellTool.execute({ command: 'npm run dev' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    h.fake.emit('stdout', 'before\n');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const detached = await h.registry.detachAll('s1');
    expect(detached.detached).toHaveLength(0);
    expect(detached.failed).toEqual([
      expect.objectContaining({ id: 'proc_1', kind: 'process', code: 'DETACH_FAILED' }),
    ]);
    expect(detached.failed[0]?.message).toContain('переставлять таймаут');

    // Ни перевода, ни retime: прогон живёт как foreground-вызов.
    expect(h.adopt).not.toHaveBeenCalled();
    expect(h.fake.retimeCalls).toEqual([]);
    expect(h.registry.list('s1')).toHaveLength(1);

    h.fake.emit('stdout', 'still-foreground\n');
    h.fake.finish({ exitCode: 0, signal: null, durationMs: 5 });

    const result = await promise;
    expect(result.metadata?.detached).toBeUndefined();
    expect(result.content).toContain('before');
    expect(result.content).toContain('still-foreground');
  });

  it('порт без spawnBackground — прежний путь через execute, регистрации нет', async () => {
    const h = createHarness({ withSpawnBackground: false });
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const result = await executeShellTool.execute({ command: 'echo hi' }, ctx);

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(result.content).toContain('sync-out');
    expect(h.registry.list('s1')).toHaveLength(0);
    expect(h.adopt).not.toHaveBeenCalled();
  });

  it('backgroundEnabled=false — detach-путь выключен (мастер-выключатель)', async () => {
    const h = createHarness();
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: false,
      executionPort: h.port,
    });

    const result = await executeShellTool.execute({ command: 'echo hi' }, ctx);

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(result.content).toContain('sync-out');
    expect(h.registry.list('s1')).toHaveLength(0);
  });

  it('реальный inline-порт: detach идущей команды → лог фонового прогона, стоп через реестр', async () => {
    // Сквозная проверка контракта: тот же итератор реального хэндла, живой
    // процесс, настоящий лог в blob-хранилище и остановка через реестр прогонов.
    const eventBus = new EventBus();
    const background = new BackgroundRunService({
      repository: new MemoryBackgroundRunRepository(),
      eventBus,
      limits: { maxSubagentsPerSession: 0, maxProcessesPerSession: 0, maxRunsPerSession: 0 },
    });
    const service = new ProcessService({
      executionPort: new InlineExecutionPort(),
      background,
      blobs: new MemoryBlobStore(),
      eventBus,
      limits: { maxLogBytes: 0 },
    });
    const registry = new ActiveRunRegistry();
    const ctx = makeCtx({
      processService: service,
      activeRuns: registry,
      backgroundEnabled: true,
    });

    const promise = executeShellTool.execute(
      // `exec sleep` — SIGTERM убивает сам `sleep`, сирот не остаётся.
      { command: 'echo early; exec sleep 30', timeout: 120 },
      ctx,
    );
    await vi.waitFor(() => expect(registry.list('s1')).toHaveLength(1), { timeout: 5_000 });
    // Даём команде напечатать префикс.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const detached = await registry.detachAll('s1');
    expect(detached.failed).toHaveLength(0);
    expect(detached.detached).toHaveLength(1);

    const result = await promise;
    expect(result.metadata?.detached).toBe(true);
    const runId = result.metadata?.background_run_id as string;
    expect((await service.get(runId))?.status).toBe('running');

    // Префикс, накопленный тулом до перевода, попал в журнал фонового прогона.
    await vi.waitFor(async () => {
      expect((await service.logs(runId))?.content).toContain('early');
    }, { timeout: 5_000 });

    // Остановка — только через реестр прогонов (`POST /processes/:id/stop`).
    expect(await service.stop(runId)).toBe(true);
    await vi.waitFor(async () => {
      expect((await service.get(runId))?.status).toBe('cancelled');
    }, { timeout: 5_000 });
  });
});

/**
 * ADR-113 §detach: живой лог команды (tee с первой секунды).
 *
 * Проверяется:
 *   • вывод виден в `processes/live/<processId>.log` **до** detach;
 *   • после detach тот же файл становится логом прогона, префикс не дублируется;
 *   • обычное завершение удаляет живой лог (результат тула прежний);
 *   • отказ `openLiveLog` не ломает вызов: detach идёт с префиксом из буферов.
 */
describe('execute_shell — живой лог команды (ADR-113 §detach)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-live-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(extra: Record<string, unknown>): ToolContext {
    return { sessionId: 's1', messageId: 'm1', workingDir: tmpDir, extra };
  }

  /** Настоящий сервис процессов + фейковый хэндл: лог проверяется в blob. */
  function createLiveHarness() {
    const fake = createFakeProcess('proc_1');
    const port = {
      execute: vi.fn(async () => ({ stdout: '', stderr: '' })),
      spawnBackground: vi.fn(async () => fake.proc),
    } as unknown as ExecutionPort;
    const eventBus = new EventBus();
    const background = new BackgroundRunService({
      repository: new MemoryBackgroundRunRepository(),
      eventBus,
      limits: { maxSubagentsPerSession: 0, maxProcessesPerSession: 0, maxRunsPerSession: 0 },
    });
    const blobs = new MemoryBlobStore();
    const service = new ProcessService({
      executionPort: port,
      background,
      blobs,
      eventBus,
      limits: { maxLogBytes: 0 },
    });
    const registry = new ActiveRunRegistry();
    return { fake, port, blobs, service, registry };
  }

  it('вывод попадает в живой лог до detach, после — тот же файл без дублей', async () => {
    const h = createLiveHarness();
    const ctx = makeCtx({
      processService: h.service,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const promise = executeShellTool.execute({ command: 'npm run dev' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));

    h.fake.emit('stdout', 'early\n');
    // Лог ведётся сразу: файл появляется ещё до перевода в фон.
    await vi.waitFor(async () => {
      expect((await h.blobs.read('processes/live/proc_1.log'))?.toString('utf-8')).toBe('early\n');
    }, { timeout: 2_000 });

    const detached = await h.registry.detachAll('s1');
    expect(detached.failed).toHaveLength(0);
    const result = await promise;
    expect(result.metadata?.detached).toBe(true);
    expect(result.metadata?.log_path).toBe('processes/live/proc_1.log');

    h.fake.emit('stdout', 'after\n');
    h.fake.finish({ exitCode: 0, signal: null, durationMs: 5 });

    const runId = result.metadata?.background_run_id as string;
    await vi.waitFor(async () => {
      expect((await h.service.get(runId))?.status).toBe('completed');
    });
    // Префикс ровно один: до detach писал тул, после — сервис, файл один.
    expect((await h.service.logs(runId))?.content).toBe('early\nafter\n');
  });

  it('обычное завершение удаляет живой лог, результат тула прежний', async () => {
    const h = createLiveHarness();
    const ctx = makeCtx({
      processService: h.service,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const promise = executeShellTool.execute({ command: 'echo hi' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    h.fake.emit('stdout', 'hi\n');
    h.fake.finish({ exitCode: 0, signal: null, durationMs: 4 });

    const result = await promise;
    expect(result.content).toBe('hi\n');
    expect(result.metadata?.detached).toBeUndefined();
    // Лог никому не нужен: файла не остаётся.
    expect(await h.blobs.exists('processes/live/proc_1.log')).toBe(false);
  });

  it('отказ openLiveLog не ломает вызов: detach идёт с префиксом из буферов', async () => {
    const h = createHarness({ openLiveLogFails: true });
    const ctx = makeCtx({
      processService: h.processService,
      activeRuns: h.registry,
      backgroundEnabled: true,
      executionPort: h.port,
    });

    const promise = executeShellTool.execute({ command: 'npm run dev' }, ctx);
    await vi.waitFor(() => expect(h.registry.list('s1')).toHaveLength(1));
    h.fake.emit('stdout', 'early\n');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const detached = await h.registry.detachAll('s1');
    expect(detached.failed).toHaveLength(0);
    const result = await promise;
    expect(result.metadata?.detached).toBe(true);

    // Живого лога нет — прежний путь: префикс из буферов, писателя не передаём.
    const input = h.adopted[0]!;
    expect(input.liveLog).toBeUndefined();
    expect(input.bufferedStdout).toBe('early\n');

    h.fake.finish({ exitCode: 0, signal: null, durationMs: 5 });
  });
});
