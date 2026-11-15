/**
 * Контракты терминального сервиса (план терминалов — Ф3а).
 *
 * ## Что описано здесь
 *
 * - `TerminalRecord` — запись реестра терминалов (реестр **in-memory**:
 *   терминал не переживает рестарт инстанса — это свойство, а не дефект,
 *   см. дизайн §1);
 * - `TerminalLimits` — лимиты и тайминги сервиса одним объектом (дефолты +
 *   переопределение конфигом/тестом);
 * - DTO-хелперы — сериализация записи для HTTP-контракта (роуты — Ф3б);
 * - типизированные ошибки с машинными кодами (роут мапит их в HTTP-статус).
 *
 * ## Чего здесь нет (и почему)
 *
 * - **Порта хранения.** Реестр терминалов — в памяти процесса; порт
 *   `TerminalRepository` появится вместе с требованием «список после рестарта»
 *   (дизайн §1).
 */
import type { ExecutionPort } from '../../execution/ports/index.js';
import type { EventBus } from '../../events/bus.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import type { TerminalAuditSink } from './audit.js';
import type { TerminalMetricsHooks } from './metrics.js';
import type { TerminalRunFinishedHandler } from './runs.js';

/**
 * Статус терминала.
 *
 * `closing` — терминал снимается (мастер-выключатель инстанса, «Закрыть»,
 * idle-reaper): запись помечается **синхронно** до ответа, а PTY гаснет
 * асинхронно (`SIGTERM` → `SIGKILL`). Без этого статуса закрываемый терминал
 * ещё мгновение отдавался как `running` («гонка disable→enable»).
 */
export type TerminalStatus = 'starting' | 'running' | 'closing' | 'exited';

/**
 * Типы событий терминала в шине.
 *
 * Объявлены в `EventType` (`packages/shared/src/types/bus-events.ts`) — здесь
 * локальный список для удобства сервиса (проверка типов публикации).
 */
export const TERMINAL_EVENT_TYPES = [
  'terminal.created',
  'terminal.updated',
  'terminal.exited',
  'terminal.deleted',
] as const;

/** Тип события терминала. */
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

/**
 * Где исполняется терминал.
 *
 * - `inline` — в процессе control plane (inline-порт исполнения);
 * - `executor` — на удалённом исполнителе (ADR-077, протокол 8).
 */
export type TerminalTarget = 'inline' | 'executor';

/**
 * Запись реестра терминалов.
 *
 * Поля — как в дизайне §1. `ownerId` — создатель; **не** определяет доступ
 * (доступ — на границе HTTP, инвариант 16). `sessionId` — необязательная
 * привязка: без неё события терминала не публикуются (в шине нет канала
 * проекта, а инстансный канал — broadcast всем, дизайн §4).
 */
export interface TerminalRecord {
  /** Идентификатор терминала (`term_<uuid>`). */
  id: string;
  /** Проект-владелец терминала. */
  projectId: string;
  /** Привязанная сессия (необязательно). */
  sessionId?: string;
  /** Создатель терминала. */
  ownerId: string;
  /** Рабочий каталог терминала. */
  cwd: string;
  /** Оболочка (`bash`/`zsh`/…). */
  shell: string;
  /** Статус терминала. */
  status: TerminalStatus;
  /** Ширина (колонки). */
  cols: number;
  /** Высота (строки). */
  rows: number;
  /** Заголовок вкладки (необязательно). */
  title?: string;
  /** Момент создания (мс epoch). */
  createdAt: number;
  /** Момент последней активности (мс epoch). */
  lastActivityAt: number;
  /** Код завершения (после выхода). */
  exitCode?: number;
  /** Сигнал завершения (после выхода). */
  signal?: string;
  /** Точка исполнения. */
  target: TerminalTarget;
  /** Адрес исполнителя (для `executor`). */
  executorId?: string;
  /**
   * Терминал восстановлен из снимка после рестарта ядра (PROP-132).
   *
   * `true` — запись поднята из `terminals/<id>/meta.json`: поднимается **новый
   * PTY** (те же `cwd`/`shell`/`cols`/`rows`), а в буфере — сохранённый хвост
   * вывода (история). Если PTY подняться не удалось (точка исполнения
   * недоступна, каталог пропал) — терминал остаётся `exited`, но всё равно с
   * `restored: true` и сохранённым выводом: его можно перезапустить вручную.
   */
  restored?: boolean;
}

/** Фрагмент вывода терминала в кольцевом буфере. */
export interface TerminalOutputChunk {
  /** Монотонный номер фрагмента (нумерация буфера). */
  seq: number;
  /** Текст фрагмента (UTF-8). */
  data: string;
  /** Длина фрагмента, байт (в UTF-8). */
  bytes: number;
}

/** Снимок кольцевого буфера вывода. */
export interface TerminalOutputSnapshot {
  /** Фрагменты вывода по порядку. */
  chunks: TerminalOutputChunk[];
  /** Объём удерживаемого вывода, байт. */
  totalBytes: number;
  /** Сколько байт вывода вытеснено из буфера (потеряно для клиента). */
  droppedBytes: number;
  /** Номер самого старого удерживаемого фрагмента (`0` — буфер пуст). */
  firstSeq: number;
  /** Номер самого свежего фрагмента (`0` — буфер пуст). */
  lastSeq: number;
}

/**
 * Лимиты и тайминги терминального сервиса.
 *
 * Значения по умолчанию — дизайн §3: 8 терминалов на проект, 32 на инстанс,
 * ввод ≤ 16 КиБ/кадр, rate limit 20 кадров/с, ring buffer 512 КиБ сегментами
 * по 8 КиБ, батчинг 10–15 мс, idle 2 дня.
 */
export interface TerminalLimits {
  /** Максимум **живых** терминалов на проект. */
  maxPerProject: number;
  /** Максимум **живых** терминалов на инстанс. */
  maxPerInstance: number;
  /** Кап размера одного кадра ввода, байт. */
  maxInputBytes: number;
  /** Скорость ввода, кадров в секунду (token bucket на терминал). */
  inputRatePerSecond: number;
  /** Ёмкость кольцевого буфера вывода на терминал, байт. */
  ringBufferBytes: number;
  /** Размер сегмента кольцевого буфера, байт. */
  ringSegmentBytes: number;
  /** Интервал батчинга вывода подписчикам, мс (диапазон 10–15). */
  flushIntervalMs: number;
  /** Срок простоя терминала до уборки reaper'ом, мс. */
  idleMs: number;
  /** Период тика reaper'а, мс. */
  reaperIntervalMs: number;
}

/** Дефолты лимитов терминального сервиса (дизайн §3). */
export const DEFAULT_TERMINAL_LIMITS: TerminalLimits = {
  maxPerProject: 8,
  maxPerInstance: 32,
  maxInputBytes: 16 * 1024,
  inputRatePerSecond: 20,
  ringBufferBytes: 512 * 1024,
  ringSegmentBytes: 8 * 1024,
  flushIntervalMs: 12,
  idleMs: 2 * 24 * 60 * 60 * 1000,
  reaperIntervalMs: 60 * 60 * 1000,
};

/** Вход создания терминала. */
export interface TerminalCreateInput {
  /**
   * Идентификатор терминала (`term_<uuid>`).
   *
   * Не задан — сгенерирует сервис. Задан — используется как есть (идемпотентность
   * при переподключении: повторное создание с тем же id вернёт существующий
   * терминал).
   */
  id?: string;
  /** Проект-владелец. */
  projectId: string;
  /** Привязанная сессия (необязательно). */
  sessionId?: string;
  /** Создатель (владелец записи; доступ не определяет). */
  ownerId: string;
  /** Рабочий каталог. */
  cwd: string;
  /** Оболочка (не задана — резолвится на точке исполнения). */
  shell?: string;
  /** Ширина (колонки). */
  cols: number;
  /** Высота (строки). */
  rows: number;
  /** Заголовок вкладки (необязательно). */
  title?: string;
  /** Дополнительное окружение терминала (мержится поверх базового). */
  env?: Record<string, string>;
}

/** Обработчики подписки на вывод терминала. */
export interface TerminalSubscriptionHandlers {
  /** Фрагмент вывода (живой поток или replay из буфера). */
  onData: (chunk: TerminalOutputChunk) => void;
  /** Терминал завершился (вызывается один раз). */
  onExit: (info: { exitCode?: number; signal?: string }) => void;
  /**
   * В буфере вытеснено то, чего клиент не видел: клиент должен перечитать
   * вывод (`GET /terminals/:id/output?since=`). Вызывается при подписке (разрыв
   * replay'а) и в живом потоке (вытеснение при активной подписке).
   */
  onReset?: (info: { droppedBytes: number; firstSeq: number }) => void;
}

/** Опции подписки. */
export interface TerminalSubscribeOptions {
  /** Отдать replay из кольцевого буфера: фрагменты с `seq > since`. */
  since?: number;
}

/** Результат подписки на терминал. */
export interface TerminalSubscription {
  /** Снимок буфера вывода на момент подписки (для догоняющего запроса). */
  snapshot: TerminalOutputSnapshot;
  /** Снять подписку (идемпотентно). */
  unsubscribe: () => void;
}

/** Опции фильтра списка терминалов. */
export interface TerminalListFilter {
  /** Только терминалы проекта. */
  projectId?: string;
  /** Только терминалы сессии. */
  sessionId?: string;
  /** Включить завершённые терминалы (по умолчанию — только живые). */
  includeExited?: boolean;
}

/**
 * DTO терминала для клиента.
 *
 * Имена полей — **snake_case** (HTTP-контракт, `docs/API_V2.md` §5.43):
 * запись реестра (`TerminalRecord`) живёт в camelCase, а наружу все её поля
 * отдаются в snake_case — один стиль на весь DTO, без смешения.
 */
export interface TerminalDto {
  /** Идентификатор терминала. */
  id: string;
  /** Проект-владелец. */
  project_id: string;
  /** Привязанная сессия (необязательно). */
  session_id?: string;
  /** Создатель терминала. */
  owner_id: string;
  /** Рабочий каталог. */
  cwd: string;
  /** Оболочка. */
  shell: string;
  /** Статус. */
  status: TerminalStatus;
  /** Ширина (колонки). */
  cols: number;
  /** Высота (строки). */
  rows: number;
  /** Заголовок вкладки (необязательно). */
  title?: string;
  /** Момент создания (мс epoch). */
  created_at: number;
  /** Момент последней активности (мс epoch). */
  last_activity_at: number;
  /** Код завершения (после выхода). */
  exit_code?: number;
  /** Сигнал завершения (после выхода). */
  signal?: string;
  /** Точка исполнения. */
  target: TerminalTarget;
  /** Адрес исполнителя (для `executor`). */
  executor_id?: string;
  /** Может ли текущий пользователь писать в терминал (право на изменение). */
  can_write: boolean;
  /** Сколько клиентов сейчас подписано на вывод. */
  attached_clients: number;
  /**
   * Терминал восстановлен из снимка после рестарта ядра (PROP-132).
   *
   * Отсутствует — терминал обычный (создан в этом процессе). `true` — запись
   * поднята из снимка: поднят **новый PTY**, а в буфере — сохранённый хвост
   * вывода (история).
   */
  restored?: boolean;
}

/** Вход DTO-хелпера. */
export interface TerminalDtoOptions {
  /** Право записи текущего пользователя. */
  canWrite: boolean;
  /** Число подключённых клиентов. */
  attachedClients: number;
}

/** DTO терминала (сериализация записи реестра в snake_case). */
export function toTerminalDto(record: TerminalRecord, options: TerminalDtoOptions): TerminalDto {
  return {
    id: record.id,
    project_id: record.projectId,
    ...(record.sessionId !== undefined ? { session_id: record.sessionId } : {}),
    owner_id: record.ownerId,
    cwd: record.cwd,
    shell: record.shell,
    status: record.status,
    cols: record.cols,
    rows: record.rows,
    ...(record.title !== undefined ? { title: record.title } : {}),
    created_at: record.createdAt,
    last_activity_at: record.lastActivityAt,
    ...(record.exitCode !== undefined ? { exit_code: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
    target: record.target,
    ...(record.executorId !== undefined ? { executor_id: record.executorId } : {}),
    can_write: options.canWrite,
    attached_clients: options.attachedClients,
    ...(record.restored !== undefined ? { restored: record.restored } : {}),
  };
}

/** DTO списка терминалов. */
export function toTerminalDtoList(
  records: readonly TerminalRecord[],
  options: TerminalDtoOptions,
): TerminalDto[] {
  return records.map((record) => toTerminalDto(record, options));
}

// ---------------------------------------------------------------------------
// Таймеры (инъекция для тестов)
// ---------------------------------------------------------------------------

/** Handle таймера (у Node — объект с `unref()`). */
export interface TerminalTimerHandle {
  /** Снять таймер с удержания процесса (если поддерживается). */
  unref?: () => void;
}

/** Таймеры сервиса (по умолчанию — глобальные; в тестах — fake timers). */
export interface TerminalTimers {
  /** Однократный таймер. */
  setTimeout: (handler: () => void, ms: number) => TerminalTimerHandle;
  /** Снять однократный таймер. */
  clearTimeout: (handle: TerminalTimerHandle) => void;
  /** Периодический таймер. */
  setInterval: (handler: () => void, ms: number) => TerminalTimerHandle;
  /** Снять периодический таймер. */
  clearInterval: (handle: TerminalTimerHandle) => void;
}

/** Логгер сервиса (по умолчанию — console). */
export interface TerminalLogger {
  /** Предупреждение. */
  warn: (message: string) => void;
  /** Ошибка. */
  error: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

/** Машинный код ошибки терминального сервиса. */
export type TerminalErrorCode =
  | 'TERMINAL_LIMIT'
  | 'TERMINAL_DISABLED'
  | 'TERMINAL_NOT_FOUND'
  | 'TERMINAL_EXITED'
  | 'TERMINAL_UNAVAILABLE'
  | 'TERMINAL_INVALID_REQUEST'
  | 'TERMINAL_ALREADY_RUNNING';

/** Базовая типизированная ошибка терминального сервиса. */
export class TerminalError extends Error {
  /** Машинный код (роут мапит его в HTTP-статус). */
  readonly code: TerminalErrorCode;

  constructor(code: TerminalErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'TerminalError';
  }
}

/** Что именно исчерпано (для лимитов). */
export type TerminalLimitScope = 'project' | 'instance' | 'input' | 'rate';

/**
 * Превышен лимит терминалов (число терминалов, размер кадра ввода или
 * скорость ввода).
 *
 * `scope` различает ситуации, которые роут мапит по-разному: `project`/
 * `instance` → `429`/`409`, `input` → `413`, `rate` → `429`.
 */
export class TerminalLimitError extends TerminalError {
  /** Что исчерпано. */
  readonly scope: TerminalLimitScope;
  /** Значение лимита. */
  readonly limit: number;
  /** Проект (для `scope: 'project'`). */
  readonly projectId?: string;

  constructor(init: {
    scope: TerminalLimitScope;
    limit: number;
    message: string;
    projectId?: string;
  }) {
    super('TERMINAL_LIMIT', init.message);
    this.name = 'TerminalLimitError';
    this.scope = init.scope;
    this.limit = init.limit;
    if (init.projectId !== undefined) this.projectId = init.projectId;
  }
}

/** Терминалы выключены на инстансе (мастер-выключатель `terminal.enabled`). */
export class TerminalDisabledError extends TerminalError {
  constructor(message = 'Терминалы на инстансе выключены') {
    super('TERMINAL_DISABLED', message);
    this.name = 'TerminalDisabledError';
  }
}

/** Терминал не найден (или уже завершён — запись неживая). */
export class TerminalNotFoundError extends TerminalError {
  /** Идентификатор терминала. */
  readonly terminalId: string;

  constructor(terminalId: string, message?: string) {
    super('TERMINAL_NOT_FOUND', message ?? `Терминал ${terminalId} не найден`);
    this.name = 'TerminalNotFoundError';
    this.terminalId = terminalId;
  }
}

/**
 * PTY недоступен в этой среде (порт не умеет `openPty` или не объявил
 * `features.pty`).
 *
 * Fail-closed: тихого фоллбэка на неинтерактивную команду нет — пользователь
 * получил бы не терминал (ADR-077, дизайн §2).
 */
export class TerminalUnavailableError extends TerminalError {
  /** Техническая причина (без секретов). */
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super('TERMINAL_UNAVAILABLE', message ?? `PTY недоступен: ${reason}`);
    this.name = 'TerminalUnavailableError';
    this.reason = reason;
  }
}

/** Некорректный запрос к сервису терминалов (роут мапит в `400`). */
export class TerminalInvalidRequestError extends TerminalError {
  constructor(message: string) {
    super('TERMINAL_INVALID_REQUEST', message);
    this.name = 'TerminalInvalidRequestError';
  }
}

/**
 * Терминал жив — перезапуск невозможен (PROP-132).
 *
 * `POST /terminals/:id/restart` на живом терминале → `409
 * TERMINAL_ALREADY_RUNNING`: перезапуск поднял бы **вторую** оболочку в том
 * же каталоге, а старая осталась бы жить (две PTY на один терминал — рассинхрон
 * вывода). Перезапуск — только для завершённого терминала (вышел процесс или
 * восстановлен из снимка).
 */
export class TerminalAlreadyRunningError extends TerminalError {
  /** Идентификатор терминала. */
  readonly terminalId: string;

  constructor(terminalId: string, message?: string) {
    super(
      'TERMINAL_ALREADY_RUNNING',
      message ?? `Терминал ${terminalId} ещё работает — перезапуск невозможен`,
    );
    this.name = 'TerminalAlreadyRunningError';
    this.terminalId = terminalId;
  }
}

/**
 * Терминал завершён — ввод/размер/запуск в него невозможны (PROP-132).
 *
 * Отличается от `TerminalNotFoundError`: запись **есть** (её видно в списке
 * с `include_exited`, её можно переименовать и перезапустить) — просто
 * процесс уже вышел. Раньше такой ввод отдавал «не найден» (404), и клиент
 * не понимал, что терминал нужно **перезапустить**, а не открыть заново.
 *
 * Роуут мапит его в `409 TERMINAL_EXITED`.
 */
export class TerminalExitedError extends TerminalError {
  /** Идентификатор терминала. */
  readonly terminalId: string;

  constructor(terminalId: string, message?: string) {
    super('TERMINAL_EXITED', message ?? `Терминал ${terminalId} завершён`);
    this.name = 'TerminalExitedError';
    this.terminalId = terminalId;
  }
}

/** Структурная проверка ошибки терминального сервиса (устойчива к копиям класса). */
export function isTerminalError(value: unknown): value is TerminalError {
  if (value instanceof TerminalError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const e = value as { name?: unknown; code?: unknown; message?: unknown };
  return (
    typeof e.name === 'string' &&
    e.name.startsWith('Terminal') &&
    typeof e.code === 'string' &&
    e.code.startsWith('TERMINAL_') &&
    typeof e.message === 'string'
  );
}

// ---------------------------------------------------------------------------
// Опции сервиса
// ---------------------------------------------------------------------------

/**
 * Контекст выбора порта исполнения для терминала (PROP-135).
 *
 * Ровно то, что роутер исполнения понимает: проект/сессия (область пула) и
 * рабочий каталог (основание для `workspaceSubPath`).
 */
export interface TerminalPortContext {
  /** Проект-владелец терминала. */
  projectId: string;
  /** Привязанная сессия (необязательно) — область сессионного пула. */
  sessionId?: string;
  /** Рабочий каталог терминала (основание для `workspaceSubPath`). */
  cwd: string;
  /** Оболочка терминала (точка исполнения может её уточнить). */
  shell?: string;
}

/**
 * Резолвер порта исполнения терминала.
 *
 * Терминал открывается **на той же точке**, что и тулы сессии: порт выбирает
 * `ExecutionRouter.portFor` по профилю (binding: сессия → агент → проект →
 * дефолт) и области пула (`projectId`/`sessionId` + `workspaceSubPath`).
 * Не задан — инстансный порт сервиса (прежнее поведение).
 */
export type TerminalPortResolver = (
  ctx: TerminalPortContext,
) => ExecutionPort | Promise<ExecutionPort>;

/** Опции терминального сервиса. */
export interface TerminalServiceOptions {
  /** Порт исполнения (PTY открывается через него). */
  port: ExecutionPort;
  /**
   * Резолвер порта по терминалу (PROP-135).
   *
   * Задан — порт выбирается на каждый терминал (профиль/пул сессии или
   * проекта); не задан — используется инстансный `port`.
   */
  resolvePort?: TerminalPortResolver;
  /**
   * Blob-хранилище для снимков терминалов (ADR-096/ADR-116).
   *
   * Не задан — снимки не пишутся и не восстанавливаются (терминал живёт
   * только в памяти процесса — прежнее поведение).
   */
  blobs?: BlobStore;
  /**
   * Восстанавливать ли терминалы из снимков при старте (PROP-132).
   *
   * `false` — снимки не поднимаются, их убирает reaper. По умолчанию `true`.
   */
  autoRestore?: boolean;
  /**
   * Оболочка по умолчанию для **новых** терминалов (`terminal.shell`).
   *
   * `null`/не задано — платформенный дефолт (`$SHELL` → `/bin/bash`).
   * Существующие терминалы не перезапускаются; live-изменение —
   * `TerminalService.setDefaultShell`.
   */
  defaultShell?: string | null;
  /**
   * Писать ли ввод в терминал в журнал исполнений (`terminal.auditInput`).
   *
   * `false` — записи `terminal.input` не пишутся (метрика `op="input"`
   * считается всегда). По умолчанию `true`. Live-изменение —
   * `TerminalService.setAuditInput`.
   */
  auditInput?: boolean;
  /** Шина событий (опционально): метаданные терминала публикуются в канал сессии. */
  eventBus?: EventBus;
  /** Журнал аудита (опционально): `terminal.open`/`terminal.input`/`terminal.close`. */
  audit?: TerminalAuditSink;
  /** Метрики (опционально): реестр метрик инстанса (ADR-094). */
  metrics?: TerminalMetricsHooks;
  /** Переопределение лимитов (deep-merge с дефолтами). */
  limits?: Partial<TerminalLimits>;
  /** Генератор id (тесты подменяют). */
  generateId?: () => string;
  /** Источник времени, мс epoch (тесты подменяют). */
  now?: () => number;
  /** Таймеры (тесты подменяют на fake timers). */
  timers?: TerminalTimers;
  /** Логгер (по умолчанию — console). */
  logger?: TerminalLogger;
  /** Точка исполнения (по умолчанию — по `port.isRemote`). */
  target?: TerminalTarget;
  /** Адрес исполнителя (для `target: 'executor'`). */
  executorId?: string;
  /**
   * Идёт ли ход в сессии — для правила idle («терминал без подписчиков **и**
   * без привязки к активной сессии», дизайн §10).
   *
   * Не задан — терминал с привязкой к сессии **не** считается простаивающим
   * (fail-safe: живой терминал не убиваем, потому что не смогли проверить).
   */
  isSessionActive?: (sessionId: string) => boolean | Promise<boolean>;
  /**
   * Колбэк завершения запуска команды в терминале (PROP-132, Ф5).
   *
   * Вызывается один раз на запуск (статус `done`/`timeout`/`closed`).
   * Точка сборки уведомления — composition root (`server/app/deps.ts`,
   * `backend/app/deps.ts`): сервис терминалов не знает, как доставлять
   * результат в сессию.
   */
  onRunFinished?: TerminalRunFinishedHandler;
}
