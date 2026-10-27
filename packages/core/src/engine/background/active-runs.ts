/**
 * Реестр активных (**блокирующих**) прогонов сессии — ADR-111 §«Перевод
 * идущего прогона в фон» (detach).
 *
 * Пока прогон идёт внутри хода модели, он блокирует родителя: тул `task`
 * (саб-агент) ждёт ребёнка, `execute_shell` — команду. Такой прогон
 * регистрирует здесь **хэндл перевода в фон**: `POST /api/v2/sessions/:id/background`
 * находит прогоны сессии и просит их продолжить работу уже как фоновые
 * (`ActiveRunHandle.detach()`).
 *
 * Инварианты:
 * 1. **Реестр — это только «живые» хэндлы**, записи о фоновой работе живут в
 *    `BackgroundRunRepository` (ADR-096). Хэндл существует ровно столько,
 *    сколько идёт блокирующий прогон: `unregister` вызывается при его
 *    завершении (в том числе после detach).
 * 2. **Одна неудача не мешает остальным**: `detachAll` собирает ошибки в
 *    `failed` и продолжает обход снимка.
 * 3. **Повторный detach — no-op**: второй запрос ничего не переводит и не
 *    отвечает ошибкой (идемпотентность контракта ADR-111 п. 3).
 *
 * Хранение — **в памяти процесса control plane**: хэндл detach непереносим
 * (это живой `AbortController` прогона), поэтому запись в репозиторий здесь
 * бессмысленна. Координация нескольких реплик — будущее
 * ([PROP-105](../../../../../docs/arch_decisions/prop-105-multi-replica-coordination.md)):
 * контракт предполагает, что ход и `POST /sessions/:id/background` приходят в
 * один процесс.
 */
import { BackgroundLimitExceededError } from './types.js';

/** Вид блокирующего прогона (совпадает с `BackgroundRunKind`). */
export type ActiveRunKind = 'subagent' | 'process';

/**
 * Хэндл активного (блокирующего) прогона.
 *
 * `id` — идентификатор, который увидит API в ответе: для саб-агента это
 * дочерняя сессия, для шелла — идентификатор процесса у порта исполнения.
 */
export interface ActiveRunHandle {
  /** Идентификатор прогона (саб-агент — `childSessionId`, шелл — `processId`). */
  id: string;
  /** Вид прогона. */
  kind: ActiveRunKind;
  /** Человекочитаемое имя (описание задачи / команда) — для UI. */
  title?: string;
  /**
   * Перевести прогон в фон. Реализация обязана быть идемпотентной и
   * пробрасывать ошибку, если перевести нельзя (лимит фоновых прогонов →
   * `BackgroundLimitExceededError`).
   */
  detach(): void | Promise<void>;
}

/** Сводка успешно переведённого прогона. */
export interface ActiveRunSummary {
  id: string;
  kind: ActiveRunKind;
  title?: string;
}

/** Прогон, который перевести не удалось (остальные при этом переводятся). */
export interface ActiveRunFailure {
  id: string;
  kind: ActiveRunKind;
  /** Машинный код отказа: `BACKGROUND_LIMIT` | `DETACH_FAILED`. */
  code: string;
  message?: string;
}

/** Фильтр `detachAll` — по виду прогона (UI переводит только по типу). */
export interface ActiveRunFilter {
  type?: ActiveRunKind;
}

/** Итог `detachAll`: что переведено и что не удалось. */
export interface ActiveRunDetachResult {
  detached: ActiveRunSummary[];
  failed: ActiveRunFailure[];
}

/** Код отказа «перевести нельзя по лимиту фоновых прогонов». */
export const ACTIVE_RUN_LIMIT_CODE = 'BACKGROUND_LIMIT';
/** Код прочих отказов перевода. */
export const ACTIVE_RUN_DETACH_FAILED_CODE = 'DETACH_FAILED';

/**
 * Реестр активных прогонов: `сессия → (id прогона → хэндл)`.
 *
 * Экземпляр — один на оркестратор (`ChatOrchestrator.activeRuns`), живёт в
 * процессе control plane.
 */
export class ActiveRunRegistry {
  private readonly _runs = new Map<string, Map<string, ActiveRunHandle>>();
  /**
   * Уже переведённые хэндлы: повторный `detachAll` их пропускает. `WeakSet` —
   * чтобы реестр не удерживал завершённые хэндлы в памяти.
   */
  private readonly _detached = new WeakSet<ActiveRunHandle>();

  /**
   * Зарегистрировать блокирующий прогон сессии.
   *
   * `sessionId` — сессия-владелец (реестр группирует прогоны по ней): прогон
   * виден только в её `/background`. Возвращает **идемпотентную** функцию
   * снятия регистрации (повторный вызов — no-op).
   */
  register(sessionId: string, run: ActiveRunHandle): () => void {
    let sessionRuns = this._runs.get(sessionId);
    if (!sessionRuns) {
      sessionRuns = new Map<string, ActiveRunHandle>();
      this._runs.set(sessionId, sessionRuns);
    }
    sessionRuns.set(run.id, run);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this._runs.get(sessionId);
      if (!current) return;
      // Снимаем только «свой» хэндл: тот же id мог перерегистрироваться
      // (новый прогон той же дочерней сессии).
      if (current.get(run.id) === run) current.delete(run.id);
      if (current.size === 0) this._runs.delete(sessionId);
    };
  }

  /** Снимок активных прогонов сессии (порядок регистрации). */
  list(sessionId: string): ActiveRunHandle[] {
    const sessionRuns = this._runs.get(sessionId);
    return sessionRuns ? [...sessionRuns.values()] : [];
  }

  /**
   * Перевести в фон все (или только указанного вида) блокирующие прогоны сессии.
   *
   * Список снимается **один раз** (снимок) — прогон, снятый с регистрации во
   * время обхода (например, завершившийся), обход не ломает. Ошибка одного
   * `detach` попадает в `failed` и не мешает остальным.
   */
  async detachAll(sessionId: string, filter: ActiveRunFilter = {}): Promise<ActiveRunDetachResult> {
    const runs = this.list(sessionId).filter((run) => !filter.type || run.kind === filter.type);
    const detached: ActiveRunSummary[] = [];
    const failed: ActiveRunFailure[] = [];

    for (const run of runs) {
      // Повторный detach того же прогона — no-op (идемпотентность контракта).
      if (this._detached.has(run)) continue;
      this._detached.add(run);
      try {
        await run.detach();
        detached.push({
          id: run.id,
          kind: run.kind,
          ...(run.title ? { title: run.title } : {}),
        });
      } catch (err) {
        // Отказ — не окончательный: лимит освободится, и повтор сработает.
        this._detached.delete(run);
        const message = err instanceof Error ? err.message : String(err);
        failed.push({
          id: run.id,
          kind: run.kind,
          code: err instanceof BackgroundLimitExceededError
            ? ACTIVE_RUN_LIMIT_CODE
            : ACTIVE_RUN_DETACH_FAILED_CODE,
          ...(message ? { message } : {}),
        });
      }
    }

    return { detached, failed };
  }
}
