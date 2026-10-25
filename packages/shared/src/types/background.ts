/**
 * Контракт единого реестра фоновых прогонов (этап 1 roadmap 0.13 — блок 1.2).
 *
 * Реестр обслуживает два вида фоновой работы:
 * - `subagent` — дочерняя сессия саб-агента, запущенная в фоне (PROP-096);
 * - `process` — шелл-команда, запущенная в фоне (PROP-097).
 *
 * Запись — персистентная (порт `BackgroundRunRepository`, ADR-096): она
 * переживает реконнект UI и рестарт сервиса, поэтому UI/родитель читают
 * состояние прогона из реестра, а не из «живого» канала.
 *
 * Здесь только контракты (типы) — без бизнес-логики: запуск, учёт pid и
 * остановка процесса живут в core.
 */

/**
 * Вид фоновой работы:
 * - `subagent` — фоновая дочерняя сессия (родитель — `sessionId`);
 * - `process` — фоновая шелл-команда (владелец — `sessionId`, запустивший команду).
 */
export type BackgroundRunKind = 'subagent' | 'process';

/**
 * Статус фонового прогона:
 * - `running` — идёт;
 * - `completed` — успешно завершён;
 * - `failed` — завершён с ошибкой;
 * - `cancelled` — остановлен;
 * - `orphaned` — процесс пережил рестарт сервиса, но его уже не отследить.
 */
export type BackgroundRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'orphaned';

/**
 * Терминальные статусы фонового прогона — записи, которые можно чистить
 * (`prune`); `running` — не терминальный.
 */
export const BACKGROUND_RUN_TERMINAL_STATUSES: readonly BackgroundRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'orphaned',
];

/**
 * Запись фонового прогона (`bgr_<uuid>`).
 *
 * Единый реестр для фоновых детей-сабагентов и шелл-процессов (PROP-096/PROP-097
 * рекомендуют один реестр).
 */
export interface BackgroundRunRecord {
  /** `bgr_<uuid>`, уникален в пределах инстанса. */
  id: string;
  kind: BackgroundRunKind;
  status: BackgroundRunStatus;
  /** Владелец-сессия: для `subagent` — родитель, для `process` — запустившая команда. */
  sessionId: string;
  /** Проект сессии-владельца (необязательно). */
  projectId?: string;
  /** `kind=subagent`: дочерняя сессия. */
  childSessionId?: string;
  /** Агент, выполняющий прогон (`subagent` — роль агента). */
  agentRole?: string;
  /** Краткое описание прогона для UI. */
  description?: string;
  /** `kind=process`: запущенная команда. */
  command?: string;
  /** `kind=process`: рабочий каталог команды. */
  cwd?: string;
  /** `kind=process`: pid процесса. */
  pid?: number;
  /**
   * `kind=process`: идентификатор фонового процесса у порта исполнения
   * (`proc_<uuid>`) — по нему процесс останавливается и различается в UI.
   */
  processId?: string;
  /** Относительный путь лога в BlobStore (`processes/<id>.log`). */
  logPath?: string;
  /** Код завершения процесса. */
  exitCode?: number;
  /** Сигнал, завершивший процесс. */
  signal?: string;
  /** Начало прогона (ISO-8601). */
  startedAt: string;
  /** Момент завершения прогона (ISO-8601). */
  finishedAt?: string;
  /** Момент последнего изменения записи (ISO-8601). */
  updatedAt: string;
  /** Краткий итог/ошибка для UI и уведомления родителю. */
  summary?: string;
  /** Дополнительные сведения прогона. */
  metadata?: Record<string, unknown>;
}

/** Фильтр выборки фоновых прогонов (все условия — по «И»). */
export interface BackgroundRunFilter {
  /** Вид фоновой работы. */
  kind?: BackgroundRunKind;
  /** Статус прогона. */
  status?: BackgroundRunStatus;
  /** Сессия-владелец. */
  sessionId?: string;
  /** Проект сессии-владельца. */
  projectId?: string;
  /** Потолок выборки (свежие первыми). */
  limit?: number;
}
