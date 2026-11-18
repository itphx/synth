/**
 * Detach-готовый foreground-путь `execute_shell` — ADR-113 §«Detach идущего
 * шелла» (механика detach — ADR-111 §«Перевод идущего прогона в фон»).
 *
 * ## Зачем отдельный путь
 *
 * `execute()` порта исполнения возвращает вывод **после** завершения команды —
 * отвязывать нечего (ни `pid`, ни потока, ни промиса завершения). Поэтому, когда
 * доступен detach, команда запускается через `spawnBackground`: та же
 * оболочка (`bash -c`), тот же таймаут и окружение, но хэндл живого процесса есть с первой
 * секунды. Дальше:
 *
 * - команда не отвязана → тул ждёт `exited`, собирает вывод и возвращает
 *   **тот же** результат, что у прежнего синхронного пути;
 * - команда отвязана (`POST /api/v2/sessions/:id/background`) → тул немедленно
 *   возвращает «переведено в фон», а процесс продолжается уже как фоновый
 *   прогон (`ProcessService.adopt`): тот же хэндл, тот же итератор вывода, лог
 *   в `BlobStore`, остановка — только `POST /api/v2/processes/:id/stop`.
 *
 * ## Лог
 *
 * Вывод пишется в лог **с первой секунды** (`openLiveLog`, tee): до detach его
 * видно как живой лог команды (`processes/live/<processId>.log`), после detach
 * тот же файл становится логом прогона (`record.logPath`) — префикс не
 * копируется и не дублируется. Обычное завершение без detach удаляет лог:
 * результат тула прежний, файла не остаётся. Ошибка открытия лога не ломает
 * вызов: лог просто не ведётся (fail-open), detach работает по старому пути
 * (сервис пишет префикс из буферов).
 *
 * ## Инварианты
 *
 * 1. **Ничего не запускается дважды.** Процесс один: и до, и после detach это
 *    тот же `ExecBackgroundProcess`.
 * 2. **Читатель вывода один в каждый момент.** До detach — тул, после — сервис;
 *    очередь `DetachableShellOutput` передаёт чтение по эстафете, а кусок,
 *    пришедший в момент передачи, уходит ровно одному читателю: в живой лог
 *    (он общий) либо обратно в очередь (`pushBack`, когда лога нет) — потери и
 *    дублей нет.
 * 3. **До detach — прежнее поведение.** «Стоп» родительского хода убивает
 *    процесс (`SIGTERM`) и даёт `abortedResult` с частичным выводом; таймаут
 *    убивает процесс портом и даёт `tool.shell_timeout` (величина лимита +
 *    подсказка — как в синхронном пути).
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
  type ExecSecret,
  type ExecutionPort,
} from '../../execution/ports/index.js';
import type { ActiveRunRegistry } from '../background/active-runs.js';
import type { LiveProcessLog } from '../processes/types.js';
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
  /**
   * Секреты вызова (PROP-124 §2) — ключи режима `ssh-агента` на время
   * процесса; в запрос запуска уходят **значением**, в лог и в реестр — нет.
   */
  secrets?: ExecSecret[];
}

/**
 * Доступен ли detach-режим для этого вызова.
 *
 * Нужны все четыре условия: реестр активных прогонов, сервис фоновых
 * процессов, `spawnBackground` у порта (иначе хэндла нет — старый исполнитель,
 * протокол < 3) и разрешённая фоновая работа инстанса. Иначе — прежний путь
 * через `execute` (поведение не меняется).
 *
 * Совместимость `retime` здесь **не проверяется**: у порта такого признака нет
 * (метод живёт на хэндле процесса), поэтому «умеет ли точка исполнения
 * переставлять таймаут» выясняется в момент detach — по наличию
 * `handle.retime`. Нет метода — перевод отклоняется (`DETACH_FAILED`), прогон
 * продолжается foreground; предварительно remote-режим не отключаем, иначе
 * перевод в фон умер бы вместе с foreground-таймаутом.
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
 * тул, после — сервис фоновых процессов. Обёртка это обеспечивает: очередь
 * общая, а незавершённый `next()` у источника — не более одного. Тул читает
 * через `read()`, сервис — через `[Symbol.asyncIterator]()`.
 *
 * Переход не требует «передачи» кусков: с живым логом кусок, прочитанный тулом
 * в момент передачи, просто дописывается в тот же файл (писатель общий), а без
 * лога возвращается в очередь (`pushBack`) — его прочитает сервис (или снова
 * тул, если перевод не состоялся).
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

  constructor(source: AsyncIterator<ExecBackgroundChunk>) {
    this._source = source;
  }

  /** Прочитать кусок (путь тула). */
  async read(): Promise<IteratorResult<ExecBackgroundChunk>> {
    return this._next();
  }

  /**
   * Вернуть кусок в начало очереди.
   *
   * Нужен только без живого лога: кусок, прочитанный тулом в момент передачи
   * вывода, ещё никуда не записан — его должен получить сервис (или,
   * если перевод не состоялся, снова тул).
   */
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
      command: { kind: 'shell', command: input.command, shell: 'bash' },
      // Бинарное требование тула (`bash`) — как у синхронного запуска (ADR-077).
      requires: toolRuntimeRequires('execute_shell'),
      cwd: input.cwd,
      // Таймаут применяет сам фон: `spawnBackground` убивает процесс
      // (`SIGTERM` → `SIGKILL` через 5 с). `signal`/`maxOutputBytes` порт в
      // фоновом режиме не слушает — «Стоп» и лимит буфера делает этот модуль.
      timeoutMs: input.timeoutMs,
      env: { HOME: process.env.HOME || '/root' },
      // Секреты вызова (PROP-124 §2) — на время жизни процесса.
      ...(input.secrets && input.secrets.length > 0 ? { secrets: input.secrets } : {}),
    });
  } catch (err) {
    return spawnFailureResult(input, err);
  }

  const output = new DetachableShellOutput(handle.output[Symbol.asyncIterator]());
  const stdout = createBuffer();
  const stderr = createBuffer();
  const startedAt = Date.now();

  // ─── Живой лог (ADR-113 §detach): tee с первой секунды ─────────────────
  // Вывод виден в файле до detach; `adopt` заберёт тот же писатель и путь.
  // Ошибка открытия лога не ломает вызов: лог просто не ведётся (fail-open),
  // а detach пойдёт прежним путём — с префиксом из буферов.
  const liveLog = await openLiveLogSafely(service, sessionId, handle.processId);

  /** Запись фонового прогона (появляется после успешного `adopt`). */
  const adoptedState: { value: { runId: string; processId: string; logPath: string } | null } = {
    value: null,
  };
  /** Вывод уже передан фону. */
  let released = false;
  /** Живой лог перешёл фоновому прогону (тул его не удаляет). */
  let logKept = false;
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
      const chunk = next.value;
      // tee: каждый кусок — и в живой лог, и (до detach) в буферы результата.
      liveLog?.write(chunk.stream, chunk.data);
      if (released) {
        // Кусок пришёл в момент передачи вывода. С живым логом он уже записан;
        // без лога — возвращаем его в очередь: читать будет сервис (или снова
        // тул, если перевод не состоялся).
        if (!liveLog) output.pushBack(chunk);
        // Исход перевода: промис создаётся вместе с флагом `released`.
        if (!detachSettled) return;
        await detachSettled;
        if (isDetached()) return;
        // Отказ (лимит): кусок должен попасть и в результат тула. Без лога он
        // уже в очереди — его прочитает следующий виток.
        if (!liveLog) continue;
      }
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
   * Порядок: снять подписку на «Стоп» → передать процесс сервису вместе с
   * писателем живого лога (сервис продолжает писать в тот же файл и читает
   * тот же итератор) → снять регистрацию → разбудить ожидание. Отказ (лимит)
   * пробрасывается: реестр активных прогонов соберёт его в `failed`, тул
   * продолжит ждать команду в foreground.
   */
  const detach = (): Promise<void> => {
    if (detachPromise) return detachPromise;
    const attempt = (async () => {
      // Команда уже завершилась — переводить нечего: тул вот-вот вернёт
      // настоящий результат.
      if (exitState.exit) return;

      // Перестановка таймаута обязательна: foreground-срок хода в фоне больше
      // не действует, и без `retime` переведённый процесс умер бы посреди
      // фонового прогона. Нет метода — точка исполнения не умеет (старый
      // исполнитель, протокол < 10): переводить нельзя, прогон остаётся
      // foreground. Ошибку соберёт реестр (`DETACH_FAILED`).
      const retime = handle.retime;
      if (typeof retime !== 'function') {
        throw new Error(
          'перевод в фон недоступен: точка исполнения не умеет переставлять таймаут процесса',
        );
      }

      unsubscribeParent();
      released = true;

      let started: { runId: string; processId: string; logPath: string };
      try {
        // Снимаем foreground-таймаут **до** `adopt`: с этой секунды процесс
        // живёт по правилам фонового прогона, а не хода.
        await retime.call(handle, 0);
        started = await service.adopt({
          sessionId,
          ...(input.ctx.projectId ? { projectId: input.ctx.projectId } : {}),
          command: input.command,
          cwd: input.cwd,
          ...(handle.pid !== undefined ? { pid: handle.pid } : {}),
          processId: handle.processId,
          handle,
          iterator: output[Symbol.asyncIterator](),
          // Живой лог — писатель и путь: сервис продолжает писать в тот же
          // файл, префикс из буферов не нужен (он уже в логе). Без живого
          // лога (fail-open) — прежний путь с префиксом.
          ...(liveLog ? { liveLog } : {}),
          ...(liveLog ? {} : { bufferedStdout: stdout.text, bufferedStderr: stderr.text }),
          title: input.displayCommand,
        });
      } catch (err) {
        // Перевести не удалось (лимит прогонов, сбой перестановки таймаута) —
        // возвращаемся в foreground: процесс жив, вывод снова читает тул.
        released = false;
        subscribeParent();
        // Возвращаем прежний срок, чтобы поведение не изменилось. Ошибка
        // восстановления не важнее исходной: прогон всё равно foreground, а
        // повтор сработает по своей причине.
        await Promise.resolve(retime.call(handle, input.timeoutMs)).catch(() => {});
        throw err;
      }

      adoptedState.value = started;
      // Лог теперь принадлежит фоновому прогону: тул его не удаляет. Писатель
      // остаётся один — и сервис, и цикл чтения тула пишут в него же (кусок,
      // прочитанный тулом в момент передачи, не теряется).
      logKept = true;
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
    sessionId,
    processId: handle.processId,
    startedAt,
    ...(liveLog ? { logPath: liveLog.logPath } : {}),
    stop: () => handle.stop('SIGTERM'),
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
      content: sm('background.started.process', { id: started.processId, log: started.logPath }),
      metadata: {
        process_id: started.processId,
        background_run_id: started.runId,
        log_path: started.logPath,
        status: 'running',
        detached: true,
        command: input.displayCommand,
        i18n: i18nMeta('background.started.process', { id: started.processId, log: started.logPath }),
      },
    };
  }

  // Команда завершилась (или завершилась, пока шёл detach): обычный результат.
  const exit = exitState.exit ?? (await exitPromise);
  unsubscribeParent();
  unregister();
  await pump;
  // Обычное завершение: лог никому не нужен — flush и удаление (best-effort).
  // Переведённый прогон лог забирает себе: файл остаётся.
  await closeLiveLog(liveLog, logKept);
  return completionResult(input, stdout, stderr, exit, startedAt);
}

/**
 * Открыть живой лог, не ломая вызов при отказе (fail-open).
 *
 * Blob-хранилище может быть недоступно (деградированный режим), а сервис —
 * подменён в тестах: в обоих случаях вывод просто не логируется до detach,
 * дальше работает прежний путь (сервис создаст лог при `adopt`, префикс — из
 * буферов).
 */
async function openLiveLogSafely(
  service: ProcessService,
  sessionId: string,
  processId: string,
): Promise<LiveProcessLog | null> {
  const open = (service as Partial<ProcessService>).openLiveLog;
  if (typeof open !== 'function') return null;
  try {
    return (await open.call(service, { sessionId, processId })) ?? null;
  } catch {
    return null;
  }
}

/** Завершить живой лог, не бросая (результат тула важнее файла). */
async function closeLiveLog(log: LiveProcessLog | null, keep: boolean): Promise<void> {
  if (!log) return;
  try {
    await log.finish({ keep });
  } catch {
    // файл останется сиротой — его удалит pruner по сроку
  }
}

/** Прежний путь `execute` — используется, если хэндла нет (прямой вызов). */
async function executionFallback(input: DetachableShellInput): Promise<ToolResult> {
  const { stdout, stderr } = await input.port.execute({
    command: { kind: 'shell', command: input.command, shell: 'bash' },
    requires: toolRuntimeRequires('execute_shell'),
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    signal: input.ctx.abortSignal,
    maxOutputBytes: MAX_BUFFER_BYTES,
    env: { HOME: process.env.HOME || '/root' },
    // Секреты вызова (PROP-124 §2) — как у основного пути.
    ...(input.secrets && input.secrets.length > 0 ? { secrets: input.secrets } : {}),
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

/** Неудача запуска фоновой формы (нет `bash`, неверный `cwd`, ошибка порта). */
function spawnFailureResult(input: DetachableShellInput, err: unknown): ToolResult {
  const execError = isExecutionError(err) ? err : null;
  if (execError?.code === 'ENOENT') {
    return {
      content: sm('tool.binary_missing', { tool: 'execute_shell', binary: 'bash' }),
      isError: true,
      metadata: {
        command: input.displayCommand,
        i18n: i18nMeta('tool.binary_missing', { tool: 'execute_shell', binary: 'bash' }),
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
  if (timedOut) {
    // Таймаут — actionable-текст (величина лимита + следующий шаг), а не
    // generic «Command failed»: так же, как в синхронном пути (`shell.ts`).
    const message = sm('tool.shell_timeout', { timeout: String(input.timeoutMs) });
    return {
      content: (body ? `${body}\n` : '') + message,
      isError: true,
      metadata: {
        command: input.displayCommand,
        exitCode: exit.exitCode ?? -1,
        killed: exit.signal !== null,
        reason: 'timeout',
        timeoutMs: input.timeoutMs,
        timedOut: true,
        truncated,
        i18n: i18nMeta('tool.shell_timeout', { timeout: String(input.timeoutMs) }),
      },
    };
  }
  const message = exit.signal
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
      truncated,
    },
  };
}
