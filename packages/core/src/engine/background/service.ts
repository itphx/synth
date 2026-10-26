/**
 * Единый сервис реестра фоновых прогонов (этап 1 roadmap 0.13 — блок 4).
 *
 * Обслуживает оба вида фоновой работы (PROP-096 — фоновые саб-агенты,
 * PROP-097 — фоновые шелл-процессы): запись прогона живёт в порте
 * `BackgroundRunRepository` (ADR-096) и переживает рестарт сервиса, а
 * «живые» хэндлы отмены (abort) — в памяти процесса.
 *
 * Инварианты:
 * 1. **Один переход состояния**: `running → completed | failed | cancelled |
 *    orphaned`. Повторный `finish` — no-op (идемпотентно): уведомление
 *    родителя не дублируется.
 * 2. **Лимит — свойство сессии**: одновременных фоновых детей на
 *    родительскую сессию (`maxSubagentsPerSession`) и записей реестра на
 *    сессию-владельца (`maxRunsPerSession`).
 * 3. **Уведомление родителя** — сообщение в историю родителя (роль USER,
 *    видно модели) + автоход (постановка в очередь). Колбэк
 *    `onNotifyParent` задаёт **точка сборки** (composition root) — глобальных
 *    синглтонов здесь нет.
 */
import { MessageRole, generateId as generateMessageId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { BackgroundRunRecord, BackgroundRunStatus, Message } from '@itphx/synth-shared';
import type { EventBus } from '../../events/bus.js';
import type { EventType } from '@itphx/synth-shared';
import type { HookBus } from '../hooks/hook-bus.js';
import type { BackgroundRunRepository } from '../../storage/ports/background-run-repository.js';
import {
  BackgroundLimitExceededError,
  type BackgroundFinishPatch,
  type BackgroundLogger,
  type BackgroundProcessInput,
  type BackgroundRunLimits,
  type BackgroundSubagentInput,
} from './types.js';

/** Префикс id фонового прогона. */
export const BACKGROUND_RUN_ID_PREFIX = 'bgr_';

/**
 * Каталог логов фоновых процессов в BlobStore (PROP-097).
 *
 * Путь лога — `processes/<id>.log`, где `id` — id записи реестра.
 */
export const PROCESS_LOG_DIR = 'processes';

/** Путь лога фонового процесса по id записи реестра. */
export function processLogPath(runId: string): string {
  return `${PROCESS_LOG_DIR}/${runId}.log`;
}

export interface BackgroundRunServiceOptions {
  /** Порт реестра фоновых прогонов (ADR-096) — единственный источник истины. */
  repository: BackgroundRunRepository;
  /** Шина событий сессии (ADR-009) — публикация `child.*`/`process.*`. */
  eventBus: EventBus;
  /** Шина хуков (ADR-030) — `agent_completed`/`agent_failed` (опционально). */
  hooks?: HookBus;
  /** Логгер (по умолчанию — console). */
  logger?: BackgroundLogger;
  /** Лимиты фоновой работы (из конфигурации `background.*`). */
  limits: BackgroundRunLimits;
  /** Генератор id (тесты подменяют). */
  generateId?: () => string;
  /** Источник времени (тесты подменяют). */
  now?: () => string;
  /**
   * Уведомление родителя о завершении фонового прогона: запись сообщения в
   * историю родителя + постановка в очередь (автоход). Точка сборки
   * (`server/app/deps.ts`, `backend/app/deps.ts`) — здесь только вызов.
   */
  onNotifyParent?: (sessionId: string, message: Message) => void | Promise<void>;
}

/**
 * Сервис реестра фоновых прогонов.
 *
 * «Живая» часть (хэндлы отмены) — в памяти процесса: после рестарта
 * прерванные прогоны помечаются `orphaned` (`recoverOnStart`) — их уже не
 * отследить, но запись в реестре остаётся.
 */
export class BackgroundRunService {
  private readonly _repository: BackgroundRunRepository;
  private readonly _eventBus: EventBus;
  private readonly _hooks?: HookBus;
  private readonly _logger: BackgroundLogger;
  private readonly _limits: BackgroundRunLimits;
  private readonly _generateId: () => string;
  private readonly _now: () => string;
  private readonly _onNotifyParent?: (sessionId: string, message: Message) => void | Promise<void>;
  /** Активные прогоны: `id` → хэндл отмены. */
  private readonly _aborts = new Map<string, { abort: (reason?: string) => void }>();

  constructor(options: BackgroundRunServiceOptions) {
    this._repository = options.repository;
    this._eventBus = options.eventBus;
    this._hooks = options.hooks;
    this._logger = options.logger ?? {
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    };
    this._limits = options.limits;
    this._generateId = options.generateId ?? defaultGenerateId;
    this._now = options.now ?? defaultNow;
    this._onNotifyParent = options.onNotifyParent;
  }

  /**
   * Зарегистрировать фоновый саб-агента.
   *
   * Порядок: проверка лимитов → запись `running` в реестр. Возвращает запись
   * реестра (её id — `background_run_id` в уведомлении и tool_result).
   *
   * @throws BackgroundLimitExceededError — лимит исчерпан.
   */
  async startSubagent(input: BackgroundSubagentInput): Promise<BackgroundRunRecord> {
    await this._assertLimits(input.sessionId, 'subagent');

    const now = this._now();
    const record: BackgroundRunRecord = {
      id: `${BACKGROUND_RUN_ID_PREFIX}${this._generateId()}`,
      kind: 'subagent',
      status: 'running',
      sessionId: input.sessionId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      childSessionId: input.childSessionId,
      ...(input.agentRole ? { agentRole: input.agentRole } : {}),
      ...(input.description ? { description: input.description } : {}),
      startedAt: now,
      updatedAt: now,
    };
    await this._repository.save(record);
    return record;
  }

  /**
   * Зарегистрировать фоновый шелл-процесс (PROP-097).
   *
   * Порядок: проверка лимитов → запись `running` в реестр → событие
   * `process.started` в канал владельца.
   *
   * Вызывается **после** фактического старта процесса портом исполнения:
   * тогда известны `pid` и `processId` (идентификатор у порта).
   *
   * @throws BackgroundLimitExceededError — лимит исчерпан.
   */
  async startProcess(input: BackgroundProcessInput): Promise<BackgroundRunRecord> {
    await this._assertLimits(input.sessionId, 'process');

    const now = this._now();
    const id = `${BACKGROUND_RUN_ID_PREFIX}${this._generateId()}`;
    const record: BackgroundRunRecord = {
      id,
      kind: 'process',
      status: 'running',
      sessionId: input.sessionId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      command: input.command,
      cwd: input.cwd,
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      ...(input.processId ? { processId: input.processId } : {}),
      logPath: input.logPath ?? processLogPath(id),
      startedAt: now,
      updatedAt: now,
    };
    await this._repository.save(record);
    this._publishStarted(record);
    return record;
  }

  /**
   * Зарегистрировать хэндл отмены прогона (в памяти процесса).
   *
   * `stop()` вызывает его; после `finish()` хэндл снимается.
   */
  registerAbort(id: string, abort: (reason?: string) => void): void {
    this._aborts.set(id, { abort });
  }

  /**
   * Завершить прогон: обновить запись, снять хэндл отмены, опубликовать
   * терминальное событие и (для `subagent`) уведомить родителя.
   *
   * Идемпотентно: повторный вызов для уже терминальной записи — no-op.
   */
  async finish(id: string, patch: BackgroundFinishPatch): Promise<BackgroundRunRecord | null> {
    const record = await this._repository.get(id);
    if (!record) return null;
    if (record.status !== 'running') return record;

    const now = this._now();
    const updated: BackgroundRunRecord = {
      ...record,
      status: patch.status,
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
      ...(patch.signal !== undefined ? { signal: patch.signal } : {}),
      ...(patch.metadata !== undefined
        ? { metadata: { ...(record.metadata ?? {}), ...patch.metadata } }
        : {}),
      finishedAt: now,
      updatedAt: now,
    };
    await this._repository.save(updated);
    this._aborts.delete(id);

    this._publishTerminal(updated);
    await this._notifyParent(updated);
    return updated;
  }

  /**
   * Остановить прогон: вызвать хэндл отмены.
   *
   * `false` — хэндла нет (прогон не в этом процессе: уже завершён или
   * пережил рестарт).
   */
  async stop(id: string, reason = 'stopped'): Promise<boolean> {
    const handle = this._aborts.get(id);
    if (!handle) return false;
    try {
      handle.abort(reason);
    } catch (err) {
      this._logger.warn?.(
        `[BackgroundRunService] отмена прогона ${id} не удалась: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  }

  /** Запись прогона по id (прокси к порту). */
  async get(id: string): Promise<BackgroundRunRecord | null> {
    return this._repository.get(id);
  }

  /** Список прогонов (прокси к порту) — свежие первыми. */
  async list(filter?: Parameters<BackgroundRunRepository['list']>[0]): Promise<BackgroundRunRecord[]> {
    return this._repository.list(filter);
  }

  /**
   * Восстановление при старте: все `running`-прогоны (прошлый процесс) →
   * `orphaned` с пометкой `interrupted by restart`.
   *
   * Их нельзя отследить и отменить — но запись в реестре должна честно
   * показывать, что прогон не завершился штатно. Идемпотентно.
   */
  async recoverOnStart(): Promise<number> {
    const running = await this._repository.list({ status: 'running' });
    let recovered = 0;
    for (const record of running) {
      try {
        const now = this._now();
        await this._repository.save({
          ...record,
          status: 'orphaned',
          summary: 'interrupted by restart',
          finishedAt: now,
          updatedAt: now,
        });
        recovered += 1;
      } catch (err) {
        this._logger.warn?.(
          `[BackgroundRunService] восстановление прогона ${record.id} не удалось: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return recovered;
  }

  /**
   * Retention-очистка: удалить терминальные записи старше отсечки.
   *
   * `before` — метка ISO-8601; по умолчанию — retention из опций сервиса.
   */
  async prune(before: string): Promise<number> {
    return this._repository.prune(before);
  }

  /**
   * Проверка лимитов сессии-владельца (бросок при превышении).
   *
   * Лимит одновременных прогонов — **по виду** работы (`subagents`/`processes`):
   * фоновые саб-агенты и шелл-процессы считаются раздельно (у них разные
   * лимиты в конфигурации `background.*`).
   */
  private async _assertLimits(sessionId: string, kind: 'subagent' | 'process'): Promise<void> {
    if (kind === 'subagent') {
      const maxSubagents = this._limits.maxSubagentsPerSession;
      if (maxSubagents > 0) {
        const running = await this._repository.list({ kind: 'subagent', status: 'running', sessionId });
        if (running.length >= maxSubagents) {
          throw new BackgroundLimitExceededError(
            'subagents',
            maxSubagents,
            `Превышен лимит фоновых саб-агентов для сессии ${sessionId} (${maxSubagents})`,
          );
        }
      }
    } else {
      const maxProcesses = this._limits.maxProcessesPerSession;
      if (maxProcesses > 0) {
        const running = await this._repository.list({ kind: 'process', status: 'running', sessionId });
        if (running.length >= maxProcesses) {
          throw new BackgroundLimitExceededError(
            'processes',
            maxProcesses,
            `Превышен лимит фоновых процессов для сессии ${sessionId} (${maxProcesses})`,
          );
        }
      }
    }
    const maxRuns = this._limits.maxRunsPerSession;
    if (maxRuns > 0) {
      const all = await this._repository.list({ sessionId });
      if (all.length >= maxRuns) {
        throw new BackgroundLimitExceededError(
          'runs',
          maxRuns,
          `Превышен лимит записей реестра фоновых прогонов для сессии ${sessionId} (${maxRuns})`,
        );
      }
    }
  }

  /** Стартовое событие прогона в канал владельца. */
  private _publishStarted(record: BackgroundRunRecord): void {
    if (record.kind !== 'process') return;
    this._eventBus.publish(record.sessionId, 'process.started', {
      process_id: record.processId ?? record.id,
      session_id: record.sessionId,
      command: record.command ?? '',
      cwd: record.cwd ?? '',
      pid: record.pid,
      background_run_id: record.id,
      log_path: record.logPath ?? '',
    });
  }

  /** Терминальное событие прогона в канал владельца. */
  private _publishTerminal(record: BackgroundRunRecord): void {
    const state = record.status as 'completed' | 'failed' | 'cancelled' | 'orphaned';
    if (record.kind === 'subagent') {
      const type: EventType =
        state === 'completed' ? 'child.completed'
          : state === 'failed' ? 'child.failed'
            : state === 'cancelled' ? 'child.cancelled'
              : 'child.cancelled';
      this._eventBus.publish(record.sessionId, type, {
        child_session_id: record.childSessionId,
        parent_session_id: record.sessionId,
        state,
        background_run_id: record.id,
        description: record.description ?? '',
      });
    } else {
      this._eventBus.publish(record.sessionId, 'process.exited', {
        process_id: record.processId ?? record.id,
        session_id: record.sessionId,
        state,
        exit_code: record.exitCode,
        signal: record.signal,
        background_run_id: record.id,
      });
    }
  }

  /**
   * Уведомление родителя о завершении фонового прогона.
   *
   * Сообщение — **роль USER** (видно модели), автор `Subagent`/`Process`, не
   * скрытое и не эфемерное: результат фоновой работы должен попасть в контекст
   * родителя. Колбэк точки сборки кладёт его в историю и ставит в очередь
   * (автоход).
   */
  private async _notifyParent(record: BackgroundRunRecord): Promise<void> {
    if (!this._onNotifyParent) return;
    if (record.kind === 'process') {
      const state = record.status === 'completed' ? 'completed'
        : record.status === 'failed' ? 'failed'
          : record.status === 'cancelled' ? 'cancelled'
            : 'failed';
      const message = buildProcessNotification(record, state);
      try {
        await this._onNotifyParent(record.sessionId, message);
      } catch (err) {
        this._logger.warn?.(
          `[BackgroundRunService] уведомление родителя о процессе ${record.id} не удалось: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    if (record.kind !== 'subagent') return;
    const state = record.status === 'completed' ? 'completed'
      : record.status === 'failed' ? 'failed'
        : record.status === 'cancelled' ? 'cancelled'
          : 'failed';
    const message = buildSubagentNotification(record, state);
    try {
      await this._onNotifyParent(record.sessionId, message);
    } catch (err) {
      this._logger.warn?.(
        `[BackgroundRunService] уведомление родителя о прогоне ${record.id} не удалось: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Сообщение-уведомление родителя о завершении фонового саб-агента.
 *
 * Формат — компактный XML-блок (его удобно прочитать и модели, и человеку):
 * `<subagent sessionID="…" state="…" description="…">\n<summary>\n</subagent>`.
 */
export function buildSubagentNotification(
  record: BackgroundRunRecord,
  state: 'completed' | 'failed' | 'cancelled',
): Message {
  const summary = record.summary ?? '';
  const content = [
    `<subagent sessionID="${record.childSessionId ?? ''}" state="${state}" description="${record.description ?? ''}">`,
    '<summary>',
    summary,
    '</subagent>',
  ].join('\n');
  return {
    id: generateMessageId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ephemeral: false,
    author: 'Subagent',
    metadata: {
      type: 'background_run_result',
      background_run_id: record.id,
      kind: record.kind,
      child_session_id: record.childSessionId,
      state,
      // ADR-111/ADR-113: описание прогона — для подписи системного блока в UI
      // (в чате показывается «Фоновый саб-агент · <описание>»). Формат
      // сообщения для модели не меняется — конверт остаётся в `content`.
      ...(record.description ? { description: record.description } : {}),
    },
  };
}

/**
 * Сообщение-уведомление родителя о завершении фонового шелл-процесса
 * (PROP-097).
 *
 * Формат — компактный XML-блок (его удобно прочитать и модели, и человеку):
 * `<process processID="…" state="exited|failed|killed" command="…">\n<хвост лога>\n</process>`.
 *
 * Тело — **хвост лога** (запись `summary`, ≤4000 символов). Лог — сырой вывод
 * процесса: обфускация (ADR-036) применяется к тому, что уходит в LLM-запрос
 * (Gateway), сам лог намеренно не обфусцируется — иначе его нельзя читать.
 */
export function buildProcessNotification(
  record: BackgroundRunRecord,
  state: 'completed' | 'failed' | 'cancelled',
): Message {
  const stateLabel = state === 'completed' ? 'exited'
    : state === 'failed' ? 'failed'
      : 'killed';
  const tail = record.summary ?? '';
  const content = [
    `<process processID="${escapeXmlAttr(record.processId ?? record.id)}" state="${stateLabel}" command="${escapeXmlAttr(record.command ?? '')}">`,
    tail,
    '</process>',
  ].join('\n');
  return {
    id: generateMessageId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ephemeral: false,
    author: 'Process',
    metadata: {
      type: 'background_run_result',
      background_run_id: record.id,
      kind: record.kind,
      process_id: record.processId ?? record.id,
      state,
      // ADR-111/ADR-113: команда прогона — для подписи системного блока в UI
      // (в чате показывается «Фоновый процесс · <команда>»). Формат сообщения
      // для модели не меняется — конверт остаётся в `content`.
      ...(record.command ? { command: record.command } : {}),
    },
  };
}

/** Экранирование значения XML-атрибута (кавычки и спецсимволы). */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');
}

/** Генератор id по умолчанию (uuid). */
function defaultGenerateId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/** Источник времени по умолчанию — ISO-8601. */
function defaultNow(): string {
  return new Date().toISOString();
}

/** Терминальные статусы реестра (для prune) — из shared-контракта. */
export const BACKGROUND_TERMINAL_STATUSES: readonly BackgroundRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'orphaned',
];
