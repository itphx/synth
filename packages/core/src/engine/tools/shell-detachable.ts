/**
 * Detach-готовый foreground-путь `execute_shell` — ADR-113 §«Detach идущего
 * шелла» (механика detach — ADR-111 §«Перевод идущего прогона в фон»).
 *
 * ## Зачем отдельный путь
 *
 * `execute()` порта исполнения возвращает вывод **после** завершения команды —
 * отвязывать нечего (ни `pid`, ни потока, ни промиса завершения). Поэтому, когда
 * доступен detach, команда запускается через `spawnBackground`: тот же
 * `sh -c`, тот же таймаут и окружение, но хэндл живого процесса есть с первой
 * секунды. Дальше:
 *
 * - команда не отвязана → тул ждёт `exited`, собирает вывод и возвращает
 *   **тот же** результат, что у прежнего синхронного пути;
 * - команда отвязана (`POST /api/v2/sessions/:id/background`) → тул немедленно
 *   возвращает «переведено в фон», а процесс продолжается уже как фоновый
 *   прогон (`ProcessService.adopt`): тот же хэндл, тот же итератор вывода, лог
 *   в `BlobStore`, остановка — только `POST /api/v2/processes/:id/stop`.
 *
 * ## Инварианты
 *
 * 1. **Ничего не запускается дважды.** Процесс один: и до, и после detach это
 *    тот же `ExecBackgroundProcess`.
 * 2. **Читатель вывода один.** До detach — тул, после — сервис; переход идёт
 *    через `DetachableShellOutput` (кусок, пришедший в момент передачи, не
 *    теряется и попадает в лог первым).
 * 3. **До detach — прежнее поведение.** «Стоп» родительского хода убивает
 *    процесс (`SIGTERM`) и даёт `abortedResult` с частичным выводом; таймаут
 *    убивает процесс портом и даёт `tool.shell_error`.
 * 4. **После detach ход ни при чём:** подписка на `ctx.abortSignal` снята,
 *    `unregister` реестра активных прогонов вызван — процесс живёт по правилам
 *    фонового прогона.
 * 5. **Отказ перевода не теряет вывод.** Если `adopt` отказал (лимит фоновых
 *    прогонов), команда остаётся в foreground: тул продолжает читать её вывод
 *    и возвращает обычный результат.
 * 6. **Нет реестра/сервиса/фонового запуска у порта — нет detach:** вызывающий
 *    (`shell.ts`) остаётся на прежнем пути через `execute`.
 */
import type { ToolContext, ToolResult } from '@itphx/synth-shared';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  isExecutionError,
  type ExecBackgroundChunk,
  type ExecBackgroundExit,
  type ExecBackgroundProcess,
  type ExecutionPort,
} from '../../execution/ports/index.js';
import type { ActiveRunRegistry } from '../background/active-runs.js';
import type { ProcessService } from '../processes/service.js';
import { i18n as i18nMeta, t as sm } from '../system-messages.js';
import { abortedResult } from './abort.js';
import { toolRuntimeRequires } from './runtime-deps.js';

/**
 * Предел длины строкового вывода тула (символов).
 *
 * Общий для foreground-пути (`shell.ts`) и detach-пути: модель получает один и
 * тот же формат, независимо от того, отвязали команду или нет.
 */
export const MAX_OUTPUT_LENGTH = 100_000;

/** Предел буфера вывода (байт на поток) — как `maxOutputBytes` у `execute`. */
const MAX_BUFFER_BYTES = DEFAULT_MAX_OUTPUT_BYTES;

/** Зависимости тула из `ToolContext.extra`, нужные detach-пути. */
interface DetachableShellExtra {
  /** Сервис фоновых процессов (он же принимает процесс при detach). */
  processService?: ProcessService;
  /** Реестр активных (блокирующих) прогонов сессии. */
  activeRuns?: ActiveRunRegistry;
  /** Мастер-выключатель фоновой работы (`background.enabled`). */
  backgroundEnabled?: boolean;
}

/** Вход detach-готового foreground-запуска. */
export interface DetachableShellInput {
  /** Контекст тула (сигнал «Стоп», сессия, проект, рабочий каталог). */
  ctx: ToolContext;
  /** Порт исполнения (тот же, что у `execute`). */
  port: ExecutionPort;
  /** Команда **после** деобфускации — она исполняется. */
  command: string;
  /** Команда как её передала модель — она попадает в metadata/title. */
  displayCommand: string;
  /** Рабочий каталог команды. */
  cwd: string;
  /** Таймаут команды, мс (как у синхронного пути). */
  timeoutMs: number;
}

/**
 * Доступен ли detach-режим для этого вызова.
 *
 * Нужны все четыре условия: реестр активных прогонов, сервис фоновых
 * процессов, `spawnBackground` у порта (иначе хэндла нет — старый исполнитель,
 * протокол < 3) и разрешённая фоновая работа инстанса. Иначе — прежний путь
 * через `execute` (поведение не меняется).
 */
export function isDetachableShellEnabled(ctx: ToolContext, port: ExecutionPort): boolean {
  const extra = ctx.extra as DetachableShellExtra | undefined;
  if (!extra) return false;
  if (!extra.activeRuns || !extra.processService) return false;
  if (extra.backgroundEnabled === false) return false;
  if (typeof port.spawnBackground !== 'function') return false;
  return Boolean(ctx.sessionId);
}

/**
 * Склейка потоков в один текст — **формат foreground-пути** (`shell.ts`):
 * stdout, затем `--- stderr ---`, затем stderr.
 */
export function combineShellStreams(stdout: string, stderr: string): string {
  let output = '';
  if (stdout) output += stdout;
  if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;
  return output;
}

/** Состояние буфера одного потока (предел — `MAX_BUFFER_BYTES`). */
interface StreamBuffer {
  text: string;
  bytes: number;
  truncated: boolean;
}

/** Создать пустой буфер потока. */
function createBuffer(): StreamBuffer {
  return { text: '', bytes: 0, truncated: false };
}

/**
 * Дописать кусок в буфер, не превышая предел порта.
 *
 * Переполнение не ошибка: лишнее отбрасывается, `truncated` фиксируется (у
 * `execute` в этом случае вывод обрезан портом — здесь обрезаем сами, потому
 * что `spawnBackground` лимит вывода **не** применяет).
 */
function appendChunk(buffer: StreamBuffer, chunk: string): void {
  if (!chunk) return;
  const room = MAX_BUFFER_BYTES - buffer.bytes;
  if (room <= 0) {
    buffer.truncated = true;
    return;
  }
  const size = Buffer.byteLength(chunk, 'utf-8');
  if (size > room) {
    buffer.text += Buffer.from(chunk, 'utf-8').subarray(0, room).toString('utf-8');
    buffer.bytes = MAX_BUFFER_BYTES;
    buffer.truncated = true;
    return;
  }
  buffer.text += chunk;
  buffer.bytes += size;
}

/**
 * Вывод шелла, передаваемый фону.
 *
 * У `handle.output` в каждый момент должен быть **один** читатель: до detach —
 * тул, после — сервис фоновых процессов. Обёртка это обеспечивает: тул читает
 * через `read()`, а `[Symbol.asyncIterator]()` отдаётся сервису. Кусок,
 * пришедший в момент передачи (уже запрошенный `next()`), не теряется —
 * `read()` отдаёт его тулу, а тул возвращает кусок в очередь (`pushBack`), и
 * сервис получает его первым.
 */
export class DetachableShellOutput implements AsyncIterable<ExecBackgroundChunk> {
  private readonly _source: AsyncIterator<ExecBackgroundChunk>;
  /** Готовые куски (порядок источника сохраняется). */
  private readonly _queue: ExecBackgroundChunk[] = [];
  /** Ожидающие читатели (пробуждение обоих данных не дублирует — очередь общая). */
  private readonly _waiters: Array<() => void> = [];
  /** В источнике есть незавершённый `next()`. */
  private _refilling = false;
  /** Источник закрыт (процесс завершился). */
  private _closed = false;
  /** Вывод передан фону: тул больше не накапливает его. */
  private _released = false;

  constructor(source: AsyncIterator<ExecBackgroundChunk>) {
    this._source = source;
  }

  /** Передать вывод фону (тул перестаёт накапливать). */
  release(): void {
    this._released = true;
  }

  /**
   * Вернуть вывод тулу (перевод в фон не состоялся — например, лимит):
   * тул продолжает читать команду, как будто detach не запрашивали.
   */
  resume(): void {
    this._released = false;
  }

  /** Вывод уже передан фону. */
  get released(): boolean {
    return this._released;
  }

  /** Прочитать кусок (путь тула). */
  async read(): Promise<IteratorResult<ExecBackgroundChunk>> {
    return this._next();
  }

  /** Вернуть кусок в начало очереди (кусок пришёл после передачи вывода). */
  pushBack(chunk: ExecBackgroundChunk): void {
    this._queue.unshift(chunk);
    this._wakeAll();
  }

  /** Путь сервиса фоновых процессов (`ProcessService.adopt`). */
  [Symbol.asyncIterator](): AsyncIterator<ExecBackgroundChunk> {
    return { next: () => this._next() };
  }

  /** Следующий кусок (или `done`, когда источник закрыт). */
  private async _next(): Promise<IteratorResult<ExecBackgroundChunk>> {
    for (;;) {
      const buffered = this._queue.shift();
      if (buffered !== undefined) return { done: false, value: buffered };
      if (this._closed) return { done: true, value: undefined };
      this._refill();
      await new Promise<void>((resolve) => this._waiters.push(resolve));
    }
  }

  /** Запросить у источника один кусок (не более одного `next()` одновременно). */
  private _refill(): void {
    if (this._refilling || this._closed) return;
    this._refilling = true;
    void this._source.next().then(
      (result) => {
        this._refilling = false;
        if (result.done) this._closed = true;
        else this._queue.push(result.value);
        this._wakeAll();
      },
      () => {
        // Ошибка потока трактуется как завершение: чтение не должно зависнуть.
        this._refilling = false;
        this._closed = true;
        this._wakeAll();
      },
    );
  }

  /** Разбудить всех ожидающих (очередь общая — данные не дублируются). */
  private _wakeAll(): void {
    const waiters = this._waiters.splice(0, this._waiters.length);
    for (const wake of waiters) wake();
  }
}

/**
 * Запустить команду с возможностью перевода в фон (ADR-113 §detach).
 *
 * Команда стартует сразу; разница с прежним путём — способ ожидания:
 * хэндл (`spawnBackground`) позволяет отвязать процесс на любом этапе.
 */
export async function runDetachableShell(input: DetachableShellInput): Promise<ToolResult> {
  const extra = input.ctx.extra as DetachableShellExtra;
  const service = extra.processService as ProcessService;
  const registry = extra.activeRuns as ActiveRunRegistry;
  const sessionId = input.ctx.sessionId as string;
  const port = input.port;
  const spawnBackground = port.spawnBackground?.bind(port);
  if (!spawnBackground) {
    // Повторная проверка (вызывающий уже проверил) — на случай прямого вызова.
    return executionFallback(input);
  }

  let handle: ExecBackgroundProcess;
  try {
    handle = await spawnBackground({
      command: { kind: 'shell', command: input.command, shell: 'sh' },
      // Бинарное требование тула (`sh`) — как у синхронного запуска (ADR-077).
      requires: toolRuntimeRequires('execute_shell'),
      cwd: input.cwd,
      // Таймаут применяет сам фон: `spawnBackground` убивает процесс
      // (`SIGTERM` → `SIGKILL` через 5 с). `signal`/`maxOutputBytes` порт в
      // фоновом режиме не слушает — «Стоп» и лимит буфера делает этот модуль.
      timeoutMs: input.timeoutMs,
      env: { HOME: process.env.HOME || '/root' },
    });
  } catch (err) {
    return spawnFailureResult(input, err);
  }

  const output = new DetachableShellOutput(handle.output[Symbol.asyncIterator]());
  const stdout = createBuffer();
  const stderr = createBuffer();
  const startedAt = Date.now();

  /** Запись фонового прогона (появляется после успешного `adopt`). */
  const adoptedState: { value: { runId: string; processId: string; logPath: string } | null } = {
    value: null,
  };
  /** Вывод уже передан фону. */
  let released = false;
  /** Исход перевода в фон (не бросает): нужен циклу чтения, чтобы решить судьбу куска. */
  let detachSettled: Promise<void> | undefined;
  /**
   * Завершение процесса — в изменяемом держателе: присваивается из колбэка
   * `exited`, поэтому контроль потока TypeScript его не «схлопывает» в `null`.
   */
  const exitState: { exit: ExecBackgroundExit | null } = { exit: null };
  let detachPromise: Promise<void> | undefined;
  let wakeDetach!: () => void;
  const detachReached = new Promise<void>((resolve) => {
    wakeDetach = resolve;
  });

  // ─── «Стоп» до detach: родительский сигнал убивает процесс ──────────────
  const parentSignal = input.ctx.abortSignal;
  const onParentAbort = (): void => {
    if (released) return;
    handle.stop('SIGTERM');
  };
  const subscribeParent = (): void => {
    if (!parentSignal || parentSignal.aborted) return;
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  };
  const unsubscribeParent = (): void => {
    parentSignal?.removeEventListener('abort', onParentAbort);
  };
  subscribeParent();
  // Сигнал уже был абортирован до запуска — не оставляем процесс жить.
  if (parentSignal?.aborted === true) handle.stop('SIGTERM');

  /** Перевод состоялся (запись реестра создана). */
  const isDetached = (): boolean => adoptedState.value !== null;

  // ─── Чтение вывода: пока тул — foreground, после detach — фон ───────────
  const pump = (async () => {
    for (;;) {
      const next = await output.read();
      if (next.done) return;
      if (released) {
        // Кусок пришёл в момент передачи вывода: вернуть его сервису и дождаться
        // исхода перевода. Успех — чтение тула закончено; отказ (лимит) —
        // продолжаем читать команду в foreground.
        output.pushBack(next.value);
        if (isDetached()) return;
        if (!detachSettled) return;
        await detachSettled;
        if (isDetached()) return;
        continue;
      }
      const chunk = next.value;
      if (chunk.stream === 'stdout') appendChunk(stdout, chunk.data);
      else appendChunk(stderr, chunk.data);
    }
  })();

  const exitPromise = handle.exited.then((exit) => {
    exitState.exit = exit;
    return exit;
  });

  // Регистрация в реестре — до старта ожидания: иначе detach не увидел бы
  // только что запущенный вызов. `unregister` объявлен заранее, потому что
  // `detach` (внутри хэндла) снимает регистрацию после успешного перевода.
  let unregister: () => void = () => {};

  /**
   * Перевод в фон (идемпотентно — повторный вызов возвращает тот же промис).
   *
   * Порядок: снять подписку на «Стоп» → передать вывод сервису (он пишет
   * префикс из буферов и продолжает читать тот же итератор) → снять
   * регистрацию → разбудить ожидание. Отказ (лимит) пробрасывается: реестр
   * активных прогонов соберёт его в `failed`, тул продолжит ждать команду в
   * foreground.
   */
  const detach = (): Promise<void> => {
    if (detachPromise) return detachPromise;
    const attempt = (async () => {
      // Команда уже завершилась — переводить нечего: тул вот-вот вернёт
      // настоящий результат.
      if (exitState.exit) return;

      unsubscribeParent();
      released = true;
      output.release();

      let started: { runId: string; processId: string; logPath: string };
      try {
        started = await service.adopt({
          sessionId,
          ...(input.ctx.projectId ? { projectId: input.ctx.projectId } : {}),
          command: input.command,
          cwd: input.cwd,
          ...(handle.pid !== undefined ? { pid: handle.pid } : {}),
          processId: handle.processId,
          handle,
          iterator: output[Symbol.asyncIterator](),
          bufferedStdout: stdout.text,
          bufferedStderr: stderr.text,
          title: input.displayCommand,
        });
      } catch (err) {
        // Перевести не удалось (лимит прогонов и т.п.) — возвращаемся в
        // foreground: процесс жив, вывод снова читает тул.
        released = false;
        output.resume();
        subscribeParent();
        throw err;
      }

      adoptedState.value = started;
      // Foreground-обёртка завершена: реестр активных прогонов больше не нужен
      // (фоновая часть учитывается реестром прогонов).
      unregister();
      wakeDetach();
    })();
    // Отказ не окончательный — снимаем промис, чтобы повтор сработал.
    detachPromise = attempt.catch((err: unknown) => {
      detachPromise = undefined;
      throw err;
    });
    // Циклу чтения нужен исход (успех/отказ), а не ошибка.
    detachSettled = detachPromise.then(() => undefined, () => undefined);
    return detachPromise;
  };

  unregister = registry.register(sessionId, {
    id: handle.processId,
    kind: 'process',
    title: input.displayCommand,
    detach,
  });

  const first = await Promise.race([
    exitPromise.then(() => 'exit' as const),
    detachReached.then(() => 'detach' as const),
  ]);

  if (first === 'detach' && adoptedState.value) {
    // Detach первым: немедленный `tool_result` «переведено в фон»; судьба
    // процесса — фоновая (уведомление придёт по завершении).
    const started = adoptedState.value;
    return {
      content: sm('process.detached_started', { id: started.processId, log: started.logPath }),
      metadata: {
        process_id: started.processId,
        background_run_id: started.runId,
        log_path: started.logPath,
        status: 'running',
        detached: true,
        command: input.displayCommand,
        i18n: i18nMeta('process.detached_started', { id: started.processId, log: started.logPath }),
      },
    };
  }

  // Команда завершилась (или завершилась, пока шёл detach): обычный результат.
  const exit = exitState.exit ?? (await exitPromise);
  unsubscribeParent();
  unregister();
  await pump;
  return completionResult(input, stdout, stderr, exit, startedAt);
}

/** Прежний путь `execute` — используется, если хэндла нет (прямой вызов). */
async function executionFallback(input: DetachableShellInput): Promise<ToolResult> {
  const { stdout, stderr } = await input.port.execute({
    command: { kind: 'shell', command: input.command, shell: 'sh' },
    requires: toolRuntimeRequires('execute_shell'),
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    signal: input.ctx.abortSignal,
    maxOutputBytes: MAX_BUFFER_BYTES,
    env: { HOME: process.env.HOME || '/root' },
  });
  let output = combineShellStreams(stdout, stderr);
  if (output.length > MAX_OUTPUT_LENGTH) {
    output = output.slice(0, MAX_OUTPUT_LENGTH) + sm('tool.output_truncated');
  }
  return {
    content: output || sm('tool.empty_output'),
    metadata: { command: input.displayCommand, exitCode: 0, truncated: output.length > MAX_OUTPUT_LENGTH },
  };
}

/** Неудача запуска фоновой формы (нет `sh`, неверный `cwd`, ошибка порта). */
function spawnFailureResult(input: DetachableShellInput, err: unknown): ToolResult {
  const execError = isExecutionError(err) ? err : null;
  if (execError?.code === 'ENOENT') {
    return {
      content: sm('tool.binary_missing', { tool: 'execute_shell', binary: 'sh' }),
      isError: true,
      metadata: {
        command: input.displayCommand,
        i18n: i18nMeta('tool.binary_missing', { tool: 'execute_shell', binary: 'sh' }),
      },
    };
  }
  const message = execError?.message || (err instanceof Error ? err.message : String(err));
  let output = combineShellStreams(execError?.stdout ?? '', execError?.stderr ?? '');
  output += (output ? '\n' : '') + sm('tool.shell_error', {
    message: message || sm('tool.command_failed_default'),
  });
  return {
    content: output.slice(0, MAX_OUTPUT_LENGTH),
    isError: true,
    metadata: {
      command: input.displayCommand,
      exitCode: execError?.code ?? -1,
      killed: execError?.killed,
    },
  };
}

/**
 * Результат завершившейся команды — форма прежнего синхронного пути.
 *
 * «Стоп» (не detach) даёт `abortedResult` с частичным выводом; ненулевой код
 * или сигнал — `tool.shell_error`; таймаут различим по сигналу и истёкшему
 * сроку (сообщение — `tool.shell_timeout`).
 */
function completionResult(
  input: DetachableShellInput,
  stdout: StreamBuffer,
  stderr: StreamBuffer,
  exit: ExecBackgroundExit,
  startedAt: number,
): ToolResult {
  const glued = combineShellStreams(stdout.text, stderr.text);

  // Прерывание по «Стоп» — единый маркер отмены + частичный вывод (как раньше).
  if (input.ctx.abortSignal?.aborted === true) {
    return abortedResult('execute_shell', glued || undefined);
  }

  let body = glued;
  let truncated = stdout.truncated || stderr.truncated;
  if (body.length > MAX_OUTPUT_LENGTH) {
    body = body.slice(0, MAX_OUTPUT_LENGTH);
    truncated = true;
  }

  if (exit.exitCode === 0 && !exit.signal) {
    return {
      content: truncated ? body + sm('tool.output_truncated') : (body || sm('tool.empty_output')),
      metadata: { command: input.displayCommand, exitCode: 0, truncated },
    };
  }

  const timedOut = exit.signal !== null
    && input.timeoutMs > 0
    && Date.now() - startedAt >= input.timeoutMs;
  const message = timedOut
    ? sm('tool.shell_timeout', { timeout: String(input.timeoutMs) })
    : exit.signal
      ? `${sm('tool.command_failed_default')} (${exit.signal})`
      : `${sm('tool.command_failed_default')} (exit code ${exit.exitCode ?? -1})`;
  const content = (body ? `${body}\n` : '') + sm('tool.shell_error', { message });

  return {
    content,
    isError: true,
    metadata: {
      command: input.displayCommand,
      exitCode: exit.exitCode ?? -1,
      killed: exit.signal !== null,
      ...(timedOut ? { timedOut: true } : {}),
      truncated,
    },
  };
}
