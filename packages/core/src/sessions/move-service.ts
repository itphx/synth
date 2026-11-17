/**
 * PROP-141 (Часть D): единая модель переноса сессии между проектами.
 *
 * Перенос меняет «дом» сессии (ADR-040). Всё, что привязано к дому, при
 * переносе либо **завершается**, либо **переезжает осознанно** — молчаливого
 * наследования не бывает.
 *
 * Классы привязанного состояния (проверка и эффекты — здесь, в одном шве):
 *
 * | Класс | Признак | Без согласия | С `move_consent` |
 * |---|---|---|---|
 * | Активный ход | `isTurnActive` | **409** | — (согласие не помогает) |
 * | Фоновые процессы | `running` | **409** | `stop` |
 * | Саб-агенты | `running` | **409** | `stop`; всё поддерево сессий переезжает |
 * | Терминалы | `running`/`starting` | **409** | `close` |
 * | Автоматизации | таймер/будильник `active`; расписание `enabled` (цель `bound`/`queue`) | **409** | отмена/отключение |
 * | Worktree | `session.worktree` | снимается всегда | — |
 * | Завершённые прогоны/терминалы | терминальный статус | не блокируют | `projectId` переатрибутируется |
 *
 * Порядок эффектов детерминирован (PROP-141, Часть D):
 * stop processes → stop subagents → close terminals → cancel automations →
 * detach worktree → перенос поддерева сессий → смена `projectId` →
 * переатрибуция записей → событие + аудит.
 *
 * **Fail-closed:** любая неудача останова → перенос **не выполняется**
 * (остановленные ресурсы остаются остановленными, `projectId` не меняется).
 */
import type { Schedule, Timer } from '@itphx/synth-shared';
import { generateId, nowISO } from '@itphx/synth-shared';
import type { Session } from '@itphx/synth-shared';
import type { SessionManager } from './manager.js';
import type { EventBus } from '../events/bus.js';
import type { BackgroundRunRepository } from '../storage/ports/background-run-repository.js';
import type { TimerRepository } from '../storage/ports/timer-repository.js';
import type { SecurityAuditRepository } from '../storage/ports/security-audit-repository.js';
import type { BackgroundRunService } from '../engine/background/service.js';
import type { ProcessService } from '../engine/processes/service.js';
import type { TerminalService } from '../engine/terminal/service.js';
import type { TimerService } from '../engine/timers/service.js';

/**
 * Согласие человека на последствия переноса. Флаги явные: «согласиться на
 * всё» одним флагом нельзя (PROP-141, Часть D).
 */
export interface SessionMoveConsent {
  /** Остановить живые фоновые процессы/саб-агентов и закрыть терминалы. */
  stop_running?: boolean;
  /** Отменить таймеры/будильники и отключить расписания сессии. */
  cancel_automations?: boolean;
}

/** Класс привязанного состояния сессии. */
export type AttachedStateKind =
  | 'process'
  | 'subagent'
  | 'terminal'
  | 'timer'
  | 'alarm'
  | 'schedule'
  | 'worktree';

/** Компактная запись привязанного состояния (id + вид + имя). */
export interface AttachedStateEntry {
  id: string;
  kind: AttachedStateKind;
  name?: string;
}

/** Счётчик + компактный список по одному классу состояния. */
export interface AttachedStateGroup {
  count: number;
  items: AttachedStateEntry[];
}

/**
 * Снимок привязанного состояния сессии — источник истины для ответа 409 и
 * для агентского отказа «останови ресурсы и повтори».
 */
export interface AttachedState {
  /** Идёт ли ход (согласие не помогает — дождаться конца хода). */
  active_turn: boolean;
  processes: AttachedStateGroup;
  subagents: AttachedStateGroup;
  terminals: AttachedStateGroup;
  timers: AttachedStateGroup;
  alarms: AttachedStateGroup;
  schedules: AttachedStateGroup;
  worktree: AttachedStateGroup;
}

/** Вид эффекта переноса (в событии `session.moved` — `effects[]`). */
export type SessionMoveEffectKind =
  | 'process'
  | 'subagent'
  | 'terminal'
  | 'timer'
  | 'alarm'
  | 'schedule'
  | 'worktree'
  | 'session';

/** Действие эффекта переноса. */
export type SessionMoveEffectAction =
  | 'stopped'
  | 'closed'
  | 'cancelled'
  | 'disabled'
  | 'detached'
  | 'moved'
  | 'reattributed'
  /**
   * Запись осталась в старом проекте (осознанное отклонение): у терминалов
   * нет безопасного способа сменить проект (реестр в памяти процесса,
   * `TerminalService.update` меняет только заголовок/привязку к сессии).
   */
  | 'left_in_old_project';

/** Фактическое последствие переноса (одна запись на ресурс). */
export interface SessionMoveEffect {
  kind: SessionMoveEffectKind;
  action: SessionMoveEffectAction;
  id: string;
  name?: string;
}

/** Итог переноса: перенесённые сессии + фактические эффекты. */
export interface SessionMoveResult {
  /** id перенесённых сессий (корневая + поддерево). */
  moved: string[];
  /** Фактические последствия (в том же порядке, что и эффекты). */
  effects: SessionMoveEffect[];
}

/** Коды отказа переноса. */
export type SessionMoveErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_HAS_ATTACHED_STATE'
  | 'SESSION_MOVE_REMOTE_UNSUPPORTED'
  | 'SESSION_MOVE_STOP_FAILED';

/**
 * Типизированная ошибка переноса: HTTP-код + машинный код + детали
 * (counts + компактный список — по PROP-141, Часть D).
 */
export class SessionMoveError extends Error {
  readonly code: SessionMoveErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  /** Снимок привязанного состояния (для 409 и агентского отказа). */
  readonly state?: AttachedState;

  constructor(
    code: SessionMoveErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
    state?: AttachedState,
  ) {
    super(message);
    this.name = 'SessionMoveError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.state = state;
  }
}

/** Минимальный контракт реестра расписаний (нужны список и отключение). */
export interface SessionMoveScheduleStore {
  list(): Promise<Schedule[]>;
  update(id: string, patch: Partial<Schedule>): Promise<Schedule | null>;
}

/** Зависимости сервиса переноса (инъекция — тесты работают с фейками). */
export interface SessionMoveServiceDeps {
  /** Менеджер сессий (чтение/запись, `withLock` под перенос). */
  sessionManager: SessionManager;
  /** Реестр фоновых прогонов (порт): выборка + переатрибуция `projectId`. */
  backgroundRuns?: BackgroundRunRepository;
  /** Сервис фоновых прогонов: остановка живых прогонов (хэндлы отмены). */
  backgroundService?: BackgroundRunService;
  /** Сервис фоновых шелл-процессов: остановка процесса. */
  processService?: ProcessService;
  /** Сервис терминалов: закрытие живых терминалов (PTY гасится). */
  terminalService?: TerminalService;
  /** Движок таймеров: отмена таймеров/будильников сессии. */
  timerService?: TimerService;
  /** Реестр таймеров (порт): выборка активных записей. */
  timers?: TimerRepository;
  /** Реестр расписаний: отключение расписаний сессии. */
  scheduleStore?: SessionMoveScheduleStore;
  /** Идёт ли ход в сессии (блокер, который согласие не снимает). */
  isTurnActive?: (sessionId: string) => Promise<boolean>;
  /** Шина событий: публикация `session.moved` с `effects[]`. */
  eventBus?: EventBus;
  /** Аудит (best-effort): `scope:'session'`, `action:'move'`. */
  audit?: SecurityAuditRepository;
}

/** Вход переноса сессии. */
export interface SessionMoveRequest {
  /** id переносимой сессии. */
  sessionId: string;
  /**
   * id целевого проекта. `undefined` — снятие проекта у сессии («без
   * проекта»); правила блокеров и порядок эффектов — те же.
   */
  targetProjectId: string | undefined;
  /** Актор (человек) — для аудита. */
  actor?: string;
  /** Согласие на последствия (без него — 409 при блокерах). */
  consent?: SessionMoveConsent;
}

/** Предел глубины обхода поддерева сессий (защита от циклов). */
const MOVE_SUBTREE_MAX_DEPTH = 5;

/** Потолок выборки одного класса привязанного состояния. */
const ATTACHED_STATE_LIST_LIMIT = 200;

/** Группа состояния из списка записей. */
function toGroup(entries: AttachedStateEntry[]): AttachedStateGroup {
  return { count: entries.length, items: entries };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Единый шов переноса сессии между проектами (PROP-141, Часть D).
 *
 * Вызывают HTTP-роут `PATCH /api/v2/sessions/:id { project_id }`, агентские
 * `project_attach`/`project_create` и (в будущем) импорт/merge. Проверки в
 * обработчиках не дублируются (инвариант 16).
 */
export class SessionMoveService {
  private readonly _deps: SessionMoveServiceDeps;

  constructor(deps: SessionMoveServiceDeps) {
    this._deps = deps;
  }

  /**
   * Снимок привязанного состояния сессии (все классы + worktree).
   *
   * Не бросает на «нет блокеров» — вызывающий сам решает, что делать с
   * пустым снимком.
   */
  async preview(sessionId: string): Promise<AttachedState> {
    const session = await this._deps.sessionManager.getSession(sessionId);
    if (!session) {
      throw new SessionMoveError('SESSION_NOT_FOUND', 'Сессия не найдена', 404);
    }
    return this._collectState(session);
  }

  /**
   * Перенос сессии между проектами.
   *
   * Без согласия при блокерах — `SessionMoveError` с кодом
   * `SESSION_HAS_ATTACHED_STATE` и `details` (counts + компактный список).
   */
  async move(request: SessionMoveRequest): Promise<SessionMoveResult> {
    const { sessionId, targetProjectId } = request;
    if (sessionId.startsWith('remote:')) {
      throw new SessionMoveError(
        'SESSION_MOVE_REMOTE_UNSUPPORTED',
        'Сессия удалённого инстанса не переносится',
        409,
      );
    }

    const session = await this._deps.sessionManager.getSession(sessionId);
    if (!session) {
      throw new SessionMoveError('SESSION_NOT_FOUND', 'Сессия не найдена', 404);
    }

    const state = await this._collectState(session);
    this._assertNoBlockers(state, request.consent);

    const effects: SessionMoveEffect[] = [];
    const prevProjectId = session.projectId;

    // 1. Остановка фоновых процессов.
    await this._stopProcesses(sessionId, state, effects);
    // 2. Остановка фоновых саб-агентов.
    await this._stopSubagents(sessionId, state, effects);
    // 3. Закрытие терминалов.
    await this._closeTerminals(state, effects);
    // 4. Отмена таймеров/будильников и отключение расписаний.
    await this._cancelAutomations(sessionId, state, effects);

    // 5. Снятие worktree + перенос поддерева + смена projectId.
    const moved = await this._moveSessions(session, targetProjectId, effects);

    // 6. Переатрибуция завершённых записей (фоновые прогоны).
    await this._reattributeRuns(moved, prevProjectId, targetProjectId, effects);

    // 7. Событие (по одному на перенесённую сессию) + аудит.
    const worktreeDetached = effects.some(
      (effect) => effect.kind === 'worktree' && effect.action === 'detached',
    );
    for (const id of moved) {
      this._deps.eventBus?.publish(id, 'session.moved', {
        session_id: id,
        project_id: targetProjectId ?? null,
        prev_project_id: prevProjectId ?? null,
        // ADR-114 §3.4: привязка к worktree снята (worktree принадлежит
        // старому проекту) — факт снятия виден в событии.
        ...(worktreeDetached ? { worktree_detached: true } : {}),
        // PROP-141 (Часть D): фактические последствия переноса (аддитивно).
        effects: effects.map((effect) => ({ ...effect })),
      });
    }
    await this._audit(request, moved, prevProjectId, targetProjectId, effects);

    return { moved, effects };
  }

  // ── Внутреннее ───────────────────────────────────────────────────────────

  /** Снимок привязанного состояния по уже загруженной сессии. */
  private async _collectState(session: Session): Promise<AttachedState> {
    const sessionId = session.id;

    const activeTurn = this._deps.isTurnActive
      ? await this._deps.isTurnActive(sessionId).catch(() => false)
      : Boolean(session.status?.blocked);

    const processes: AttachedStateEntry[] = [];
    const subagents: AttachedStateEntry[] = [];
    if (this._deps.backgroundRuns) {
      const running = await this._deps.backgroundRuns
        .list({ sessionId, status: 'running', limit: ATTACHED_STATE_LIST_LIMIT })
        .catch(() => [] as Awaited<ReturnType<BackgroundRunRepository['list']>>);
      for (const record of running) {
        const entry: AttachedStateEntry = {
          id: record.id,
          kind: record.kind === 'subagent' ? 'subagent' : 'process',
          ...(record.description || record.command ? { name: record.description || record.command } : {}),
        };
        if (record.kind === 'subagent') subagents.push(entry);
        else processes.push(entry);
      }
    }

    const terminals: AttachedStateEntry[] = [];
    if (this._deps.terminalService) {
      const records = this._deps.terminalService.list({ sessionId });
      for (const record of records) {
        if (record.status !== 'running' && record.status !== 'starting') continue;
        terminals.push({
          id: record.id,
          kind: 'terminal',
          ...(record.title ? { name: record.title } : {}),
        });
      }
    }

    const timers: AttachedStateEntry[] = [];
    const alarms: AttachedStateEntry[] = [];
    if (this._deps.timers) {
      const active = await this._deps.timers
        .list({ sessionId, status: 'active', limit: ATTACHED_STATE_LIST_LIMIT })
        .catch(() => [] as Timer[]);
      for (const timer of active) {
        const entry: AttachedStateEntry = {
          id: timer.id,
          kind: timer.kind === 'alarm' ? 'alarm' : 'timer',
          ...(timer.name ? { name: timer.name } : {}),
        };
        if (timer.kind === 'alarm') alarms.push(entry);
        else timers.push(entry);
      }
    }

    const schedules: AttachedStateEntry[] = [];
    if (this._deps.scheduleStore) {
      const all = await this._deps.scheduleStore.list().catch(() => [] as Schedule[]);
      for (const schedule of all) {
        if (!schedule.enabled) continue;
        const target = schedule.target;
        if (target.mode !== 'bound' && target.mode !== 'queue') continue;
        if (target.sessionId !== sessionId) continue;
        schedules.push({ id: schedule.id, kind: 'schedule', name: schedule.name });
      }
    }

    const worktree: AttachedStateEntry[] = session.worktree
      ? [{ id: session.worktree.worktreeId, kind: 'worktree', name: session.worktree.branch }]
      : [];

    return {
      active_turn: activeTurn,
      processes: toGroup(processes),
      subagents: toGroup(subagents),
      terminals: toGroup(terminals),
      timers: toGroup(timers),
      alarms: toGroup(alarms),
      schedules: toGroup(schedules),
      worktree: toGroup(worktree),
    };
  }

  /**
   * Проверка блокеров: активный ход (согласие не помогает) и классы, для
   * которых нет явного согласия.
   */
  private _assertNoBlockers(state: AttachedState, consent?: SessionMoveConsent): void {
    if (state.active_turn) {
      throw new SessionMoveError(
        'SESSION_HAS_ATTACHED_STATE',
        'Сессия занята ходом — дождитесь его окончания и повторите',
        409,
        attachedStateDetails(state),
        state,
      );
    }

    const runningBlocked =
      state.processes.count > 0 || state.subagents.count > 0 || state.terminals.count > 0;
    const automationBlocked =
      state.timers.count > 0 || state.alarms.count > 0 || state.schedules.count > 0;

    if (runningBlocked && consent?.stop_running !== true) {
      throw new SessionMoveError(
        'SESSION_HAS_ATTACHED_STATE',
        'У сессии есть живые ресурсы — остановите их и повторите перенос',
        409,
        attachedStateDetails(state),
        state,
      );
    }
    if (automationBlocked && consent?.cancel_automations !== true) {
      throw new SessionMoveError(
        'SESSION_HAS_ATTACHED_STATE',
        'У сессии есть автоматизации — отмените их и повторите перенос',
        409,
        attachedStateDetails(state),
        state,
      );
    }
  }

  /** Остановка фоновых шелл-процессов (fail-closed: ошибка → перенос не выполняется). */
  private async _stopProcesses(
    sessionId: string,
    state: AttachedState,
    effects: SessionMoveEffect[],
  ): Promise<void> {
    if (state.processes.count === 0) return;
    const records = await this._listRunning(sessionId, 'process');
    for (const record of records) {
      try {
        if (this._deps.processService) {
          await this._deps.processService.stop(record.id, 'session_moved');
        } else if (this._deps.backgroundService) {
          await this._deps.backgroundService.stop(record.id, 'session_moved');
        }
      } catch (err) {
        throw new SessionMoveError(
          'SESSION_MOVE_STOP_FAILED',
          `Не удалось остановить фоновый процесс ${record.id}: ${errorMessage(err)}`,
          409,
          { failed: { kind: 'process', id: record.id } },
        );
      }
      effects.push({ kind: 'process', action: 'stopped', id: record.id });
    }
  }

  /** Остановка фоновых саб-агентов (fail-closed). */
  private async _stopSubagents(
    sessionId: string,
    state: AttachedState,
    effects: SessionMoveEffect[],
  ): Promise<void> {
    if (state.subagents.count === 0) return;
    const records = await this._listRunning(sessionId, 'subagent');
    for (const record of records) {
      try {
        if (this._deps.backgroundService) {
          await this._deps.backgroundService.stop(record.id, 'session_moved');
        }
      } catch (err) {
        throw new SessionMoveError(
          'SESSION_MOVE_STOP_FAILED',
          `Не удалось остановить фонового саб-агента ${record.id}: ${errorMessage(err)}`,
          409,
          { failed: { kind: 'subagent', id: record.id } },
        );
      }
      effects.push({
        kind: 'subagent',
        action: 'stopped',
        id: record.id,
        ...(record.childSessionId ? { name: record.childSessionId } : {}),
      });
    }
  }

  /** Закрытие живых терминалов сессии (fail-closed). */
  private async _closeTerminals(state: AttachedState, effects: SessionMoveEffect[]): Promise<void> {
    if (state.terminals.count === 0 || !this._deps.terminalService) return;
    for (const entry of state.terminals.items) {
      try {
        await this._deps.terminalService.close(entry.id);
      } catch (err) {
        // Терминал мог закрыться между снимком состояния и остановкой —
        // это не повод отменять перенос (он и так уже закрыт).
        if (!isTerminalMissingError(err)) {
          throw new SessionMoveError(
            'SESSION_MOVE_STOP_FAILED',
            `Не удалось закрыть терминал ${entry.id}: ${errorMessage(err)}`,
            409,
            { failed: { kind: 'terminal', id: entry.id } },
          );
        }
      }
      effects.push({ kind: 'terminal', action: 'closed', id: entry.id });
    }
  }

  /** Отмена таймеров/будильников и отключение расписаний сессии. */
  private async _cancelAutomations(
    sessionId: string,
    state: AttachedState,
    effects: SessionMoveEffect[],
  ): Promise<void> {
    try {
      await this._cancelAutomationsUnsafe(sessionId, state, effects);
    } catch (err) {
      // Не удалось отменить автоматизации — перенос не выполняется (fail-closed).
      throw new SessionMoveError(
        'SESSION_MOVE_STOP_FAILED',
        `Не удалось отменить автоматизации сессии: ${errorMessage(err)}`,
        409,
        { failed: { kind: 'automation', id: sessionId } },
      );
    }
  }

  /** Тело отмены автоматизаций (ошибки — оборачиваются вызывающим). */
  private async _cancelAutomationsUnsafe(
    sessionId: string,
    state: AttachedState,
    effects: SessionMoveEffect[],
  ): Promise<void> {
    if (state.timers.count > 0 || state.alarms.count > 0) {
      if (this._deps.timerService) {
        await this._deps.timerService.cancelForSessions([sessionId]);
      } else if (this._deps.timers) {
        for (const entry of [...state.timers.items, ...state.alarms.items]) {
          await this._deps.timers.remove(entry.id);
        }
      }
      for (const entry of state.timers.items) {
        effects.push({ kind: 'timer', action: 'cancelled', id: entry.id });
      }
      for (const entry of state.alarms.items) {
        effects.push({ kind: 'alarm', action: 'cancelled', id: entry.id });
      }
    }

    if (state.schedules.count > 0 && this._deps.scheduleStore) {
      for (const entry of state.schedules.items) {
        await this._deps.scheduleStore.update(entry.id, { enabled: false });
        effects.push({ kind: 'schedule', action: 'disabled', id: entry.id, name: entry.name });
      }
    }
  }

  /**
   * Снятие worktree + перенос поддерева сессий + смена `projectId` корневой
   * сессии. Возвращает id перенесённых сессий (корень + поддерево).
   */
  private async _moveSessions(
    session: Session,
    targetProjectId: string | undefined,
    effects: SessionMoveEffect[],
  ): Promise<string[]> {
    const prevProjectId = session.projectId;
    const subtree = await this._collectSubtree(session.id, prevProjectId);

    // Поддерево: смена проекта + снятие worktree (ADR-114 §3.4).
    for (const child of subtree) {
      await this._deps.sessionManager.withLock(child.id, async (s) => {
        if (s.projectId !== prevProjectId) return;
        s.projectId = targetProjectId;
        s.planApproved = false;
        if (s.worktree) {
          const worktreeId = s.worktree.worktreeId;
          s.worktree = undefined;
          effects.push({ kind: 'worktree', action: 'detached', id: worktreeId });
        }
        await this._deps.sessionManager.updateSession(s);
      });
    }

    // Корневая сессия: смена проекта + снятие worktree.
    await this._deps.sessionManager.withLock(session.id, async (s) => {
      s.projectId = targetProjectId;
      s.planApproved = false;
      if (s.worktree) {
        const worktreeId = s.worktree.worktreeId;
        s.worktree = undefined;
        effects.push({ kind: 'worktree', action: 'detached', id: worktreeId });
      }
      await this._deps.sessionManager.updateSession(s);
    });

    const moved = [session.id, ...subtree.map((child) => child.id)];
    for (const id of moved) {
      effects.push({ kind: 'session', action: 'moved', id });
    }
    return moved;
  }

  /**
   * Поддерево сессии: все потомки (включая завершённые), у которых
   * `projectId` совпадает со старым. Потомки, живущие в другом проекте, не
   * трогаются.
   */
  private async _collectSubtree(rootId: string, prevProjectId: string | undefined): Promise<Session[]> {
    const collected: Session[] = [];
    const seen = new Set<string>([rootId]);
    let frontier: string[] = [rootId];
    for (let depth = 0; depth < MOVE_SUBTREE_MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const parentId of frontier) {
        const children = await this._deps.sessionManager.getChildren(parentId, { light: true });
        for (const child of children) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          if (child.projectId === prevProjectId) {
            collected.push(child);
            next.push(child.id);
          }
        }
      }
      frontier = next;
    }
    return collected;
  }

  /**
   * Переатрибуция завершённых записей реестра фоновых прогонов: `projectId`
   * переносится на новый проект (история следует за сессией).
   *
   * У терминалов метода смены проекта нет (реестр в памяти процесса,
   * `TerminalService.update` меняет только заголовок/привязку к сессии) —
   * запись остаётся в старом проекте, отклонение отмечается в `effects`
   * (`left_in_old_project`).
   */
  private async _reattributeRuns(
    moved: string[],
    prevProjectId: string | undefined,
    targetProjectId: string | undefined,
    effects: SessionMoveEffect[],
  ): Promise<void> {
    if (this._deps.backgroundRuns) {
      for (const sessionId of moved) {
        const records = await this._deps.backgroundRuns
          .list({ sessionId, limit: ATTACHED_STATE_LIST_LIMIT })
          .catch(() => [] as Awaited<ReturnType<BackgroundRunRepository['list']>>);
        for (const record of records) {
          if (record.status === 'running') continue;
          if (record.projectId !== prevProjectId) continue;
          await this._deps.backgroundRuns.save({ ...record, projectId: targetProjectId });
          effects.push({ kind: 'session', action: 'reattributed', id: record.id });
        }
      }
    }

    // Терминалы: безопасного способа сменить проект нет — запись остаётся в
    // старом проекте, отклонение отмечается явно (осознанное ограничение).
    if (this._deps.terminalService) {
      for (const sessionId of moved) {
        const records = this._deps.terminalService.list({ sessionId, includeExited: true });
        for (const record of records) {
          if (record.status !== 'exited') continue;
          if (record.projectId !== prevProjectId) continue;
          effects.push({
            kind: 'terminal',
            action: 'left_in_old_project',
            id: record.id,
            ...(record.title ? { name: record.title } : {}),
          });
        }
      }
    }
  }

  /** Живые записи реестра прогонов нужного вида (для остановки). */
  private async _listRunning(
    sessionId: string,
    kind: 'process' | 'subagent',
  ): Promise<Awaited<ReturnType<BackgroundRunRepository['list']>>> {
    if (!this._deps.backgroundRuns) return [];
    return this._deps.backgroundRuns
      .list({ sessionId, status: 'running', kind, limit: ATTACHED_STATE_LIST_LIMIT })
      .catch(() => []);
  }

  /** Аудит переноса (best-effort): `scope:'session'`, `action:'move'`. */
  private async _audit(
    request: SessionMoveRequest,
    moved: string[],
    prevProjectId: string | undefined,
    targetProjectId: string | undefined,
    effects: SessionMoveEffect[],
  ): Promise<void> {
    const audit = this._deps.audit;
    if (!audit) return;
    try {
      await audit.append({
        id: `sa_${generateId()}`,
        ts: nowISO(),
        actor: request.actor ?? 'local',
        scope: 'session',
        action: 'move',
        source: 'runtime',
        before: { sessionId: request.sessionId, projectId: prevProjectId ?? null },
        after: {
          sessionId: request.sessionId,
          projectId: targetProjectId,
          moved,
          effects: effects.length,
        },
        version: 1,
      });
    } catch (err) {
      console.warn(`[session-move] аудит не записан: ${errorMessage(err)}`);
    }
  }
}

/**
 * Детали ответа 409: counts + компактный список `{id, kind, name}` по
 * каждому классу привязанного состояния (PROP-141, Часть D).
 */
export function attachedStateDetails(state: AttachedState): Record<string, unknown> {
  return {
    active_turn: state.active_turn,
    processes: state.processes,
    subagents: state.subagents,
    terminals: state.terminals,
    timers: state.timers,
    alarms: state.alarms,
    schedules: state.schedules,
    worktree: state.worktree,
  };
}

/**
 * Есть ли блокеры переноса (активный ход или живое привязанное состояние).
 *
 * Используется агентским путём: `project_attach`/`project_create` отказывают
 * **до** изменения записи, если блокеры есть (PROP-141, Часть D).
 */
export function hasAttachedStateBlockers(state: AttachedState): boolean {
  if (state.active_turn) return true;
  return (
    state.processes.count > 0
    || state.subagents.count > 0
    || state.terminals.count > 0
    || state.timers.count > 0
    || state.alarms.count > 0
    || state.schedules.count > 0
  );
}

/**
 * Компактная сводка привязанного состояния для агентского отказа: счётчики
 * по классам (без длинных списков — «останови ресурсы и повтори»).
 */
export function summarizeAttachedState(state: AttachedState): string {
  const parts: string[] = [];
  if (state.active_turn) parts.push('активный ход');
  if (state.processes.count) parts.push(`процессы: ${state.processes.count}`);
  if (state.subagents.count) parts.push(`саб-агенты: ${state.subagents.count}`);
  if (state.terminals.count) parts.push(`терминалы: ${state.terminals.count}`);
  if (state.timers.count) parts.push(`таймеры: ${state.timers.count}`);
  if (state.alarms.count) parts.push(`будильники: ${state.alarms.count}`);
  if (state.schedules.count) parts.push(`расписания: ${state.schedules.count}`);
  if (state.worktree.count) parts.push(`worktree: ${state.worktree.count}`);
  return parts.length > 0 ? parts.join(', ') : 'нет';
}

/** Терминал уже закрыт (не ошибка остановки). */
function isTerminalMissingError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  const code = (err as { code?: string } | null)?.code;
  return name === 'TerminalNotFoundError' || code === 'TERMINAL_NOT_FOUND';
}
