/**
 * Типы подсистемы фоновых шелл-процессов (PROP-097).
 *
 * Контракт записи прогона — в `@itphx/synth-shared` (`types/background.ts`,
 * `kind: 'process'`), здесь — только типы **сервиса**: вход запуска, результат
 * запуска, чтение лога и типизированные ошибки.
 */
import type { ExecBackgroundChunk, ExecBackgroundProcess, ExecutionPort } from '../../execution/ports/index.js';
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

export interface ProcessServiceOptions {
  /** Порт исполнения команд (ADR-077) — фоновый запуск идёт только через него. */
  executionPort: ExecutionPort;
  /** Реестр фоновых прогонов (PROP-096/PROP-097) — запись `kind: 'process'`. */
  background: BackgroundRunService;
  /** Порт blob-хранилища (ADR-096) — логи процессов (`processes/<id>.log`). */
  blobs: BlobStore;
  /** Шина событий сессии (ADR-009) — `process.started`/`process.stopped`/`process.exited`/`fs.changed`. */
  eventBus: EventBus;
  /** Лимиты подсистемы (`background.logMaxBytes`). */
  limits: ProcessLimits;
  /** Логгер (по умолчанию — console). */
  logger?: ProcessLogger;
  /** Источник времени (тесты подменяют). */
  now?: () => string;
}

/** Вход фонового запуска шелл-команды. */
export interface ProcessSpawnInput {
  /** Сессия-владелец (та, что запустила команду). */
  sessionId: string;
  /** Проект сессии-владельца (необязательно). */
  projectId?: string;
  /** Команда (shell-строка). */
  command: string;
  /** Рабочий каталог команды. */
  cwd: string;
  /** Дополнительное окружение (мержится поверх базового окружения порта). */
  env?: Record<string, string>;
  /** Таймаут процесса, мс. Не задан/`0` — **без таймаута** (фон по умолчанию). */
  timeoutMs?: number;
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
 * итератор вывода, с которого продолжает читать. Вывод, полученный до перевода
 * (буферы foreground-ожидания), дописывается в лог префиксом — иначе журнал
 * начался бы «с середины».
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
  /** Накопленный stdout команды до перевода в фон (префикс лога). */
  bufferedStdout: string;
  /** Накопленный stderr команды до перевода в фон (префикс лога). */
  bufferedStderr: string;
  /** Короткое имя процесса (для события `process.detached`; в реестр не пишется). */
  title?: string;
}

/** Параметры чтения лога процесса. */
export interface ProcessLogsOptions {
  /** Смещение от начала лога, байт. */
  offset?: number;
  /** Предел размера выдачи, байт. Не задан — до конца лога. */
  limit?: number;
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
