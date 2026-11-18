/**
 * Типы подсистемы фоновых шелл-процессов (PROP-097).
 *
 * Контракт записи прогона — в `@itphx/synth-shared` (`types/background.ts`,
 * `kind: 'process'`), здесь — только типы **сервиса**: вход запуска, результат
 * запуска, чтение лога и типизированные ошибки.
 */
import type { BackgroundRunRecord } from '@itphx/synth-shared';
import type { ExecBackgroundChunk, ExecBackgroundProcess, ExecSecret, ExecutionPort } from '../../execution/ports/index.js';
import type { EventBus } from '../../events/bus.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import type { BackgroundRunService } from '../background/service.js';

/** Минимальный логгер (console-совместимый). */
export interface ProcessLogger {
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/** Лимиты подсистемы процессов (из конфигурации `background.*`). */
export interface ProcessLimits {
  /**
   * Предел размера лога процесса, байт. `0` — без ограничения.
   *
   * По превышении запись в лог прекращается, а в записи реестра ставится
   * `metadata.truncated`.
   */
  maxLogBytes: number;
}

/**
 * Предел длины хвоста лога, попадающего в уведомление родителя, символов.
 *
 * Хвост несёт модели итог работы фонового процесса — но не весь лог
 * (он может быть большим).
 */
export const PROCESS_LOG_TAIL_LIMIT = 4000;

/**
 * Порог флаша буфера лога, байт: при превышении пишем в blob немедленно.
 *
 * Действует вместе с интервальным флашем (`PROCESS_LOG_FLUSH_INTERVAL_MS`):
 * «пачками» по 64 КиБ (быстрый вывод не копится в памяти) либо раз в 200 мс
 * (редкий вывод не ждёт накопления).
 */
export const PROCESS_LOG_FLUSH_BYTES = 64 * 1024;

/** Интервал флаша буфера лога, мс (таймер `unref` — процесс не держим). */
export const PROCESS_LOG_FLUSH_INTERVAL_MS = 200;

/**
 * Каталог **живых** логов foreground-команд (ADR-113 §detach).
 *
 * Подкаталог каталога логов прогонов (`PROCESS_LOG_DIR` = `processes`):
 * вывод команды копится в `processes/live/<processId>.log` с первой секунды,
 * а после перевода в фон тот же файл становится логом прогона
 * (`record.logPath`). Файл, не упомянутый ни одной записью реестра, —
 * «сиротский»: его удаляет pruner по сроку (`LIVE_LOG_ORPHAN_TTL_MS`).
 */
export const LIVE_LOG_DIR = 'processes/live';

/**
 * Срок жизни «сиротского» live-лога, мс (1 час).
 *
 * Процесс мог упасть, не удалив лог (аварийное завершение, рестарт инстанса):
 * такой файл удаляется, только когда он не упомянут ни одной живой записью
 * реестра **и** старше этого срока — иначе pruner снёс бы лог идущей команды,
 * у которой записи реестра ещё нет (её создаёт только detach).
 */
export const LIVE_LOG_ORPHAN_TTL_MS = 3600_000;

/**
 * Путь живого лога команды: `processes/live/<processId>.log`.
 *
 * `processId` приходит от точки исполнения (в `remote`-режиме — из сети),
 * поэтому в имя файла попадают только безопасные символы: путь лога не должен
 * выйти за каталог `processes/live`.
 */
export function liveProcessLogPath(processId: string): string {
  return `${LIVE_LOG_DIR}/${processId.replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
}

/**
 * Живой лог команды (ADR-113 §detach): tee с первой секунды.
 *
 * Пишет **тот же** вывод, что копит тул `execute_shell`, в blob-хранилище —
 * по мере прихода чанков (буферизация и предел размера — как у фонового лога).
 * До перевода в фон файл никому не принадлежит: обычное завершение удаляет
 * его (`finish({keep:false})`), а `adopt` забирает писатель и путь, поэтому
 * лог прогона не начинается «с середины» и префикс не копируется.
 *
 * Записи в реестре живых прогонов не создаётся, событий не публикуется,
 * лимиты не проверяются: это только файл.
 */
export interface LiveProcessLog {
  /** Путь лога в blob-хранилище (`processes/live/<processId>.log`). */
  readonly logPath: string;
  /** Дописать кусок вывода (буферизуется; ошибка записи — предупреждение). */
  write(stream: 'stdout' | 'stderr', data: string): void;
  /** Записать накопленное в blob. */
  flush(): Promise<void>;
  /**
   * Завершить живой лог: `keep:false` — flush и удалить файл (best-effort),
   * `keep:true` — только flush (файл остаётся логом прогона после `adopt`).
   */
  finish(opts: { keep: boolean }): Promise<void>;
  /**
   * Дописать кусок — тот же приём, что у писателя фонового лога.
   *
   * Нужен сервису при `adopt`: после перевода в фон читает и пишет он, но
   * файл и буфер записи — те же (`write`/`push` — один путь).
   */
  push(stream: 'stdout' | 'stderr', data: string): void;
  /** Файл усечён по пределу размера (`background.logMaxBytes`). */
  readonly truncated: boolean;
  /**
   * Лог потока усечён — у живого лога потоковых файлов нет, всегда `false`.
   */
  streamTruncated(stream: 'stdout' | 'stderr'): boolean;
  /** Хвост записанного текста (≤ `PROCESS_LOG_TAIL_LIMIT` символов). */
  tail(): string;
}

export interface ProcessServiceOptions {
  /** Порт исполнения команд (ADR-077) — фоновый запуск идёт только через него. */
  executionPort: ExecutionPort;
  /** Реестр фоновых прогонов (PROP-096/PROP-097) — запись `kind: 'process'`. */
  background: BackgroundRunService;
  /** Порт blob-хранилища (ADR-096) — логи процессов (`processes/<id>.log`). */
  blobs: BlobStore;
  /** Шина событий сессии (ADR-009) — `process.started`/`process.stopped`/`process.exited`/`fs.changed`. */
  eventBus: EventBus;
  /**
   * Лимиты подсистемы — **снимок** конструктора (fallback).
   *
   * Если задан `getMaxLogBytes`, предел лога читается из живого резолвера в
   * момент создания лога (runtime-настройка `background.logMaxBytes`
   * применяется к новым прогонам без рестарта).
   */
  limits: ProcessLimits;
  /**
   * Живой предел лога (`LiveBackgroundSettings.getMaxLogBytes`) — читается при
   * создании лога нового прогона. Не задан — снимок `limits.maxLogBytes`.
   */
  getMaxLogBytes?: () => number;
  /** Логгер (по умолчанию — console). */
  logger?: ProcessLogger;
  /**
   * ADR-136/ADR-126 §5: хук терминального перехода фонового процесса.
   *
   * Вызывается **после** фиксации терминального статуса в реестре прогонов;
   * аргумент — финальная запись (`status`/`exitCode`/`finishedAt`). Нужен для
   * парной записи журнала исполнений (`phase: 'finished'`). Ошибки хука не
   * влияют на процесс: переход к этому моменту уже зафиксирован.
   */
  onFinished?: (record: BackgroundRunRecord) => void | Promise<void>;
  /** Источник времени (тесты подменяют). */
  now?: () => string;
}

/** Вход фонового запуска шелл-команды. */
export interface ProcessSpawnInput {
  /** Сессия-владелец (та, что запустила команду). */
  sessionId: string;
  /** Проект сессии-владельца (необязательно). */
  projectId?: string;
  /**
   * Команда (shell-строка).
   *
   * Не обязательна: для argv-формы (`argv`) команда не нужна — запуск идёт
   * без локальной оболочки, и подставлять её нечего (ADR-124 Ф4a).
   */
  command?: string;
  /**
   * Команда в форме **argv** (PROP-124 Ф4a) — прямой запуск бинарника без
   * локальной оболочки.
   *
   * Задана — `command` (shell-строка) игнорируется: аргументы не проходят через
   * shell, поэтому значение аргумента не может быть инъекцией. Нужна тулам,
   * чья команда не является shell-строкой (адресный `ssh_exec`: `ssh` +
   * аргументы без локальной оболочки).
   */
  argv?: { file: string; args: string[] };
  /**
   * Бинарные требования команды (ADR-077) — по умолчанию требование тула
   * `execute_shell` (`bash`). Для argv-команды — свой бинарник (`ssh`).
   */
  requires?: string[];
  /** Рабочий каталог команды. */
  cwd: string;
  /** Дополнительное окружение (мержится поверх базового окружения порта). */
  env?: Record<string, string>;
  /** Таймаут процесса, мс. Не задан/`0` — **без таймаута** (фон по умолчанию). */
  timeoutMs?: number;
  /**
   * Секреты вызова (PROP-124 §7) — материал на время жизни фонового процесса.
   *
   * Доставляются **точке исполнения** (значением, не путём): в remote-режиме
   * путь control plane в контейнере исполнителя не существует. Секреты **не
   * попадают** в запись реестра прогонов и в лог — только в запрос запуска.
   */
  secrets?: ExecSecret[];
  /**
   * ADR-126 §5: кто инициировал запуск — человек (`user`) или агент (`agent`).
   *
   * Поле аддитивное: не задано — поведение прежнее (уведомление родителя,
   * ADR-113 §4). Для запуска человеком уведомление не отправляется — агента
   * будить нельзя (ADR-126 §5 «Лента и уведомления»).
   */
  origin?: 'user' | 'agent';
  /**
   * ADR-126 §5: дополнительные метаданные прогона (пишутся в запись реестра).
   *
   * Аддитивное поле; секреты и абсолютные пути сюда не кладутся.
   */
  metadata?: Record<string, unknown>;
  /** Короткое имя процесса (для UI; в реестр не пишется). */
  title?: string;
}

/** Результат фонового запуска — тул возвращает его модели сразу. */
export interface ProcessSpawnResult {
  /** id записи реестра (`bgr_<uuid>`) — по нему процесс останавливается. */
  runId: string;
  /** Идентификатор процесса у порта исполнения (`proc_<uuid>`). */
  processId: string;
  /** Путь лога в blob-хранилище (`processes/<runId>.log`). */
  logPath: string;
  /** pid процесса ОС (если процесс запустился). */
  pid?: number;
}

/**
 * Вход перевода **идущего** процесса в фон (ADR-113 §«Detach идущего шелла»).
 *
 * Отличие от `ProcessSpawnInput`: процесс **уже запущен** — порт не вызывается,
 * сервис получает готовый хэндл (`ExecBackgroundProcess.spawnBackground`) и
 * итератор вывода, с которого продолжает читать.
 *
 * Лог: если тул вёл живой лог (`liveLog`, tee с первой секунды), сервис
 * забирает его писатель и путь — запись продолжается в **тот же** файл
 * (`record.logPath` = `liveLog.logPath`), префикс не копируется. Без живого
 * лога (blob был недоступен) работает прежний путь: префикс из буферов
 * foreground-ожидания дописывается первым, иначе журнал начался бы «с
 * середины».
 */
export interface ProcessAdoptInput {
  /** Сессия-владелец (та, в ходе которой шла команда). */
  sessionId: string;
  /** Проект сессии-владельца (необязательно). */
  projectId?: string;
  /** Команда (shell-строка). */
  command: string;
  /** Рабочий каталог команды. */
  cwd: string;
  /** pid уже запущенного процесса ОС (если известен). */
  pid?: number;
  /** Идентификатор процесса у порта исполнения (`proc_<uuid>`). */
  processId: string;
  /** Хэндл живого процесса — второй экземпляр команды **не** запускается. */
  handle: ExecBackgroundProcess;
  /**
   * Итератор вывода **того же** хэндла: сервис продолжает читать с него.
   * Передаётся уже «отвязанным» от тула — в каждый момент читатель один.
   */
  iterator: AsyncIterator<ExecBackgroundChunk>;
  /**
   * Живой лог команды (tee с первой секунды): его писатель и путь забирает
   * сервис. Задан — префикс из буферов **не** пишется (он уже в файле), а
   * `record.logPath` указывает на тот же путь.
   */
  liveLog?: LiveProcessLog;
  /**
   * Путь лога без передачи писателя (аддитивно к `liveLog`): нужен, если
   * вызывающий ведёт файл сам. Не задан — путь берётся из `liveLog` либо
   * обычный `processes/<runId>.log`.
   */
  logPath?: string;
  /**
   * Накопленный stdout команды до перевода в фон (префикс лога).
   * Используется только без `liveLog` (обратная совместимость).
   */
  bufferedStdout?: string;
  /** Накопленный stderr команды до перевода в фон (префикс лога). */
  bufferedStderr?: string;
  /** Короткое имя процесса (для события `process.detached`; в реестр не пишется). */
  title?: string;
}

/** Поток вывода фонового процесса. */
export type ProcessLogStream = 'stdout' | 'stderr' | 'combined';

/** Параметры чтения лога процесса. */
export interface ProcessLogsOptions {
  /** Смещение от начала лога, байт. */
  offset?: number;
  /** Предел размера выдачи, байт. Не задан — до конца лога. */
  limit?: number;
  /**
   * Поток вывода.
   *
   * `combined` (по умолчанию) — общий лог прогона (`processes/<id>.log`,
   * stdout и stderr в порядке прихода). `stdout`/`stderr` — файл потока
   * (`processes/<id>.stdout.log` / `.stderr.log`); он появляется у прогонов,
   * запущенных после разделения потоков, у более старых — файла нет. У
   * прогона, переведённого в фон из foreground (ADR-113 §detach), файла
   * потока тоже нет: живой лог ведёт один файл.
   */
  stream?: ProcessLogStream;
}

/** Отрезок лога процесса. */
export interface ProcessLogsResult {
  /** Текст отрезка (UTF-8). */
  content: string;
  /** Смещение, с которого отдан отрезок. */
  offset: number;
  /** Смещение следующего отрезка (конец выданного). */
  nextOffset: number;
  /** Полный размер лога, байт. */
  totalBytes: number;
  /** Лог был усечён при записи (превышен `background.logMaxBytes`). */
  truncated?: boolean;
}

/** Машинные коды ошибок подсистемы фоновых процессов. */
export const PROCESS_ERROR_CODES = [
  'background_unsupported',
  'process_not_found',
] as const;

/** Код ошибки подсистемы фоновых процессов. */
export type ProcessErrorCode = (typeof PROCESS_ERROR_CODES)[number];

/**
 * Базовый класс ошибок подсистемы фоновых процессов: машинный код + текст.
 */
export class ProcessError extends Error {
  readonly code: ProcessErrorCode;

  constructor(code: ProcessErrorCode, message: string) {
    super(message);
    this.name = 'ProcessError';
    this.code = code;
  }
}

/**
 * Фоновое исполнение недоступно в текущем режиме (ADR-077).
 *
 * Удалённый порт (шаг 7c) фоновый запуск пока не реализует — там, где порт
 * без `spawnBackground`, тул `execute_shell` с `background: true` отказывает.
 */
export class BackgroundUnsupportedError extends ProcessError {
  constructor(message = 'Фоновое исполнение недоступно в текущем режиме исполнения') {
    super('background_unsupported', message);
    this.name = 'BackgroundUnsupportedError';
  }
}
