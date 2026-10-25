/**
 * Типы сервисного слоя единого реестра фоновых прогонов (этап 1 roadmap 0.13
 * — блок 4; PROP-096 — фоновые саб-агенты, PROP-097 — фоновые шелл-процессы).
 *
 * Контракт записи — в `@itphx/synth-shared` (`types/background.ts`). Здесь —
 * только типы **сервиса**: вход запуска, патч завершения, лимиты и ошибки.
 */
import type { BackgroundRunRecord, BackgroundRunStatus } from '@itphx/synth-shared';

/** Лимиты фоновой работы (из конфигурации `background.*`). */
export interface BackgroundRunLimits {
  /** Максимум одновременно идущих фоновых саб-агентов на родительскую сессию. */
  maxSubagentsPerSession: number;
  /** Максимум одновременно идущих фоновых шелл-процессов на сессию-владельца. */
  maxProcessesPerSession: number;
  /** Максимум записей реестра на сессию-владельца (чистится retention-ом). */
  maxRunsPerSession: number;
}

/** Вход запуска фонового саб-агента. */
export interface BackgroundSubagentInput {
  /** Родительская сессия (владелец прогона). */
  sessionId: string;
  /** Дочерняя сессия саб-агента. */
  childSessionId: string;
  /** Роль агента-исполнителя. */
  agentRole?: string;
  /** Краткое описание прогона (для UI и уведомления). */
  description?: string;
  /** Проект сессии-владельца (необязательно). */
  projectId?: string;
}

/**
 * Вход запуска фонового шелл-процесса (PROP-097).
 *
 * Запись создаётся **после** фактического старта процесса портом исполнения:
 * так в реестр попадают `pid` и `processId` (идентификатор у порта).
 */
export interface BackgroundProcessInput {
  /** Сессия-владелец (та, что запустила команду). */
  sessionId: string;
  /** Проект сессии-владельца (необязательно). */
  projectId?: string;
  /** Запущенная команда (для UI и уведомления). */
  command: string;
  /** Рабочий каталог команды. */
  cwd: string;
  /** pid процесса ОС (если процесс запустился). */
  pid?: number;
  /** Идентификатор процесса у порта исполнения (`proc_<uuid>`). */
  processId?: string;
  /** Путь лога в BlobStore; не задан — `processes/<id>.log`. */
  logPath?: string;
}

/** Патч завершения прогона. */
export interface BackgroundFinishPatch {
  /** Терминальный статус прогона. */
  status: Extract<BackgroundRunStatus, 'completed' | 'failed' | 'cancelled'>;
  /**
   * Краткий итог/ошибка (для UI и уведомления родителю).
   *
   * Для `kind=process` — **хвост лога** процесса (≤4000 символов): он же
   * попадает в уведомление родителя.
   */
  summary?: string;
  /** Код завершения процесса (`kind=process`). */
  exitCode?: number;
  /** Сигнал, завершивший процесс (`kind=process`). */
  signal?: string;
  /** Дополнительные сведения прогона (например `truncated` — лог усечён). */
  metadata?: Record<string, unknown>;
}

/** Минимальный логгер (console-совместимый). */
export interface BackgroundLogger {
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/** Машинные коды ошибок подсистемы фоновых прогонов. */
export const BACKGROUND_ERROR_CODES = [
  'background_limit_exceeded',
  'background_disabled',
  'background_run_not_found',
] as const;

/** Код ошибки подсистемы фоновых прогонов. */
export type BackgroundErrorCode = (typeof BACKGROUND_ERROR_CODES)[number];

/** База ошибок подсистемы фоновых прогонов: машинный код + текст (для логов/UI). */
export class BackgroundRunError extends Error {
  readonly code: BackgroundErrorCode;

  constructor(code: BackgroundErrorCode, message: string) {
    super(message);
    this.name = 'BackgroundRunError';
    this.code = code;
  }
}

/**
 * Превышен лимит фоновых прогонов (одновременных детей, процессов или
 * записей реестра).
 *
 * Лимит — **свойство сессии**, а не инстанса: фоновые дети независимы, но их
 * количество ограничено, чтобы не устроить параллельный шторм LLM-вызовов
 * (PROP-096 §«Ограничения и контроль»).
 */
export class BackgroundLimitExceededError extends BackgroundRunError {
  /** Текущий лимит. */
  readonly limit: number;
  /** Вид превышенного лимита. */
  readonly limitKind: 'subagents' | 'processes' | 'runs';

  constructor(limitKind: 'subagents' | 'processes' | 'runs', limit: number, message: string) {
    super('background_limit_exceeded', message);
    this.name = 'BackgroundLimitExceededError';
    this.limit = limit;
    this.limitKind = limitKind;
  }
}

/** Состояние фонового прогона в терминальном виде (для уведомления). */
export type BackgroundFinalState = 'completed' | 'failed' | 'cancelled';

/** Запись реестра + её финальное состояние (внутренний вид сервиса). */
export interface BackgroundRunState {
  record: BackgroundRunRecord;
  state: BackgroundFinalState;
}
