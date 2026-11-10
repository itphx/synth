import { createHash } from 'node:crypto';

import {
  authorityPrincipalSchema,
  type AuthorityPrincipal,
  type AuthorityTarget,
  type PermissionPreview,
} from '@itphx/synth-shared';

import type { EventBus } from '../../events/bus.js';
import { computeAuthorityApprovalDigest } from '../authority/resolve.js';

export interface ApprovalRequest {
  approvalId: string;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  /**
   * ADR-106 Ф0: принципал хода, которому адресован запрос (аддитивно).
   * Не задан — поле не публикуется (старые потребители не ломаются).
   */
  principal?: AuthorityPrincipal;
  /**
   * ADR-106 Ф0: идентификатор хода (аддитивно). В проводе события — `turn_id`.
   */
  turnId?: string;
  /**
   * ADR-106 Ф0: отпечаток запроса (аддитивно) — связывает подтверждение с
   * конкретным `(ход, действие, цель)`.
   */
  digest?: string;
  /**
   * ADR-106 Ф3: действие Authority-слоя (`read`/`write`/…). Задано вместе с
   * `target` — тогда запрос **привязан** к паре «действие × цель» и ответ
   * принимается только у носителя покрывающего гранта.
   */
  action?: string;
  /**
   * ADR-106 Ф3: цель Authority-слоя (типизированный ресурс). Вместе с
   * `action` образует привязку подтверждения.
   */
  target?: AuthorityTarget;
  /**
   * ADR-029 (аддитивно): превью изменений, которые тул собирается внести
   * (unified diff по файлам). Пользователь подтверждает запись — он должен
   * видеть, ЧТО изменится, а не только сырые аргументы.
   *
   * Поле необязательное: превью считается «по возможности» — посчитать не
   * удалось → поля нет, поведение прежнее.
   */
  preview?: PermissionPreview;
  /**
   * Shell-одобрение паттернами (аддитивно): набор командных паттернов, которые
   * будут разрешены сессии кнопкой «Разрешить в сессии».
   */
  save?: string[];
  /**
   * Структурная причина ask'а: id security-сообщения + параметры.
   *
   * «Виновник» в машиночитаемом виде — UI может показать, ЧТО именно
   * вызвало вопрос, и подсветить токен в тексте команды/аргументах.
   *
   * Аддитивно: старый UI новых полей не видит, новый UI умеет работать без них
   * (пустой `trigger`/`undefined` — причина показывается прежним текстом).
   */
  trigger?: {
    /** id security-сообщения (например `ask-protected-path`). */
    messageId?: string;
    /** Параметры подстановки (например `{ path }`/`{ command }`/`{ code }`). */
    params?: Record<string, string>;
    /** Ключ правила, которое сработало. */
    matchedRule?: string;
    /** Вид ask'а от shell-guard: dynamic/protected/mutation/cwd. */
    askKind?: 'dynamic' | 'protected' | 'mutation' | 'cwd';
  };
}

export interface ApprovalDecision {
  approved: boolean;
  /** true — истекло время ожидания ответа пользователя */
  timeout?: boolean;
  /** true — у сессии не было подписчиков, спрашивать было некому */
  noSubscribers?: boolean;
  /**
   * true — ожидание снято отменой хода («Стоп», `AbortSignal`), а не ответом
   * пользователя: не отказ и не таймаут, решения по запросу нет.
   */
  cancelled?: boolean;
  /** Решение пользователя в новом формате WS permission_reply: allow | deny. */
  action?: 'allow' | 'deny';
  /** true — разрешить только один раз (не добавлять allow-правило в сессию). */
  once?: boolean;
  /**
   * PROP-127 (этап T5): true — решение принято **каскадом**: пользователь
   * отказал по другому подтверждению той же сессии, и это ожидание погашено
   * вместе с ним (паритет с opencode). Ответ пользователя по этому запросу
   * уже не принимается.
   */
  cascaded?: boolean;
}

/**
 * PROP-127 (этап T5): ожидание подтверждения прав.
 *
 * Ожидание — **отдельный объект**, а не «промис из `waitForDecision`»: шаг
 * может подготовить несколько подтверждений и опубликовать их **разом** —
 * несколько `ask` одного шага висят одновременно, а решение по каждому
 * приходит независимо.
 */
export interface ApprovalWaiter {
  /** Идентификатор запроса подтверждения (`approval_<callId>`). */
  readonly approvalId: string;
  /** Решение по запросу: ответ пользователя, таймаут, отмена хода, каскад. */
  readonly decision: Promise<ApprovalDecision>;
  /** true — ожидание завершено (ответ/таймаут/отмена/каскад). */
  readonly settled: boolean;
  /**
   * Разрешить ожидание из кода — без ответа пользователя.
   *
   * Нужно для переоценки соседних запросов после гранта «Разрешить в сессии»
   * (паритет с opencode, ветка `always`): новое allow-правило разрешает
   * соседний запрос — он одобряется без нового вопроса пользователю.
   */
  resolve(decision: ApprovalDecision): void;
}

/**
 * Pending-запрос подтверждения: опубликован (`permission.asked`) и ждёт ответа.
 *
 * Снимок запроса на момент публикации — по нему UI восстанавливает полосу
 * подтверждения после перезагрузки страницы (ADR-029): карточка должна быть
 * та же, что была до перезагрузки (тул, аргументы, превью, причина).
 */
export interface PendingApproval {
  /** Сессия, которой адресован запрос. */
  sessionId: string;
  /** Запрос подтверждения (аргументы тула, причина, превью, shell-паттерны). */
  request: ApprovalRequest;
  /** Таймаут ожидания ответа (мс); `0` — без авто-отклонения. */
  timeoutMs: number;
  /** Момент публикации запроса (ISO-8601) — от него считается остаток таймера. */
  askedAt: string;
  /**
   * true — пользователь нажал «Остановить таймер» (`permission.hold`):
   * авто-отклонение снято, запрос живёт до ответа. Восстановленная карточка
   * не должна ставить свой таймер.
   */
  held: boolean;
}

/**
 * Внутреннее состояние ожидания (не часть публичного контракта).
 */
interface WaiterState {
  settled: boolean;
  /** «Остановить таймер» (`permission.hold`) — авто-отклонение снято. */
  held: boolean;
  /** Запрос опубликован (`permission.asked`) — пользователь его видит. */
  published: boolean;
  timer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  unsubscribe: () => void;
}

/** Внутреннее ожидание: публичный контракт + состояние. */
interface InternalWaiter extends ApprovalWaiter {
  readonly sessionId: string;
  readonly request: ApprovalRequest;
  readonly timeoutMs: number;
  readonly state: WaiterState;
  /** Завершить ожидание (идемпотентно). */
  finish(decision: ApprovalDecision): void;
}

/**
 * Отказ **пользователя** (а не отклонённый сервером ответ).
 *
 * Ответ, который сервер не принял (нет гранта, повторный ответ, чужой ход),
 * публикуется с полем `reason` — это не отказ пользователя, и каскадить его
 * нельзя: пользователь отказывать не собирался.
 */
function isUserDenyReply(data: Record<string, unknown>): boolean {
  if (data.reason !== undefined) return false;
  if (data.action === 'deny') return true;
  // Старый формат `{ approved: false }` — тоже отказ.
  return data.action === undefined && data.approved === false;
}

/**
 * Отпечаток запроса подтверждения (ADR-106 Ф0): sha256 от канонического
 * представления `(сессия, ход, тул, аргументы)`.
 *
 * Секретов в отпечатке нет: в аргументы тула попадают уже обфусцированные
 * значения (ADR-036), а сам отпечаток — необратимый хэш.
 */
export function computePermissionDigest(input: {
  sessionId: string;
  turnId?: string;
  toolName: string;
  args: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify({
    sessionId: input.sessionId,
    turnId: input.turnId ?? '',
    tool: input.toolName,
    args: sortKeys(input.args),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Рекурсивная сортировка ключей — стабильный JSON для хэша. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) out[key] = sortKeys(item);
    return out;
  }
  return value;
}

/**
 * Разбор принципала из недоверенного источника (WS-сообщение).
 *
 * ADR-106 Ф0: принципал в `permission.replied` — **аддитивное** поле; пришло
 * что-то невалидное — поле просто не публикуется (поведение прежнее). Схема
 * строгая: неизвестное поле/вид → `undefined`.
 */
export function parsePermissionPrincipal(value: unknown): AuthorityPrincipal | undefined {
  const parsed = authorityPrincipalSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * ADR-029: минимальный механизм подтверждения для действия `ask`.
 *
 * Публикует событие `permission.asked` в EventBus (UI/пользователь может ответить),
 * затем ожидает `permission.replied` с совпадающим approval_id до таймаута.
 * Если у сессии нет **пользовательских** подписчиков (per-session либо
 * user-facing глобальных, напр. watch-all клиент UI) — спрашивать некому,
 * возвращает отказ; машинные глобальные подписки не считаются.
 *
 * ADR-106 Ф0: событие `permission.asked` **аддитивно** получает `principal`,
 * `turn_id` и `digest` (принципал/ход/отпечаток запроса). Поля опциональны —
 * старые потребители (UI, backend) продолжают читать прежний набор.
 *
 * ADR-106 Ф3: если задан `registry` (реестр подтверждений) и запрос привязан к
 * паре «действие × цель», запрос **регистрируется** в реестре: ответ принимает
 * только носитель покрывающего гранта, повторный ответ — отказ. Реестр не
 * задан — поведение прежнее (слой Authority выключен или работает в shadow).
 *
 * PROP-127 (этап T5): несколько `ask` одного шага висят **одновременно**, а
 * отказ по любому из них гасит остальные ожидания той же сессии (каскад,
 * паритет с opencode). Механика: `prepareWaiters` готовит пакет ожиданий,
 * `publishWaiters` публикует все `permission.asked` разом, а решение по
 * каждому приходит независимо (свой `approval_id`).
 */
export class PermissionApprovalManager {
  /**
   * Реестр ожидающих ответа запросов подтверждения (ADR-029).
   *
   * Ключ — `approvalId`, значение — снимок запроса (`PendingApproval`).
   * Нужен для восстановления полосы подтверждения после перезагрузки
   * страницы: HTTP-роут `GET /api/v2/sessions/:id/permissions` отдаёт список
   * ожиданий сессии.
   *
   * Состояние — **в памяти процесса**: после рестарта инстанса ожидания
   * теряются (осознанное ограничение; персистентность — отдельное решение
   * владельца: ADR + миграции).
   */
  private readonly _pending = new Map<string, PendingApproval>();

  constructor(
    private readonly _eventBus: EventBus,
    private readonly _options: { registry?: ApprovalRegistry } = {},
  ) {}

  /**
   * Подготовить ожидания подтверждений.
   *
   * Запросы **не публикуются** — публикация отдельным шагом
   * (`publishWaiters`): так несколько `ask` одного шага висят **одновременно**
   * (PROP-127 T5), а решение по каждому приходит независимо. Порядок
   * публикации — порядок вызовов модели.
   *
   * Крайние случаи (без публикации запроса):
   * - ход отменён («Стоп») — `cancelled`;
   * - у сессии нет пользовательских подписчиков — `noSubscribers`.
   */
  prepareWaiters(
    sessionId: string,
    requests: ApprovalRequest[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): ApprovalWaiter[] {
    if (requests.length === 0) return [];
    // «Стоп» до подготовки: не публикуем `permission.asked` — спрашивать
    // уже некого и незачем (запрос отменён вместе с ходом).
    if (signal?.aborted) {
      return requests.map((request) => this._closedWaiter(sessionId, request, timeoutMs, signal, {
        approved: false,
        cancelled: true,
      }));
    }
    // Некому подтверждать — отказ без публикации запроса (спрашивать некому).
    // Проверка ДО подписки: собственная подписка ожидания не должна считаться
    // «пользовательским подписчиком».
    if (!this._eventBus.hasApprovalListeners(sessionId)) {
      return requests.map((request) => this._closedWaiter(sessionId, request, timeoutMs, signal, {
        approved: false,
        noSubscribers: true,
      }));
    }
    return requests.map((request) => this._createWaiter(sessionId, request, timeoutMs, signal));
  }

  /**
   * Подготовить **одно** ожидание подтверждения (см. `prepareWaiters`).
   */
  prepareWaiter(
    sessionId: string,
    request: ApprovalRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): ApprovalWaiter {
    return this.prepareWaiters(sessionId, [request], timeoutMs, signal)[0]!;
  }

  /**
   * Опубликовать подготовленные запросы: все `permission.asked` — **разом**.
   *
   * Публикация синхронная: после вызова все запросы пакета висят в шине
   * одновременно, и пользователь отвечает на любой из них (остальные
   * погашаются каскадом отказа, PROP-127 T5).
   */
  publishWaiters(waiters: readonly ApprovalWaiter[]): void {
    for (const waiter of waiters) this._publishWaiter(waiter as InternalWaiter);
  }

  /**
   * Запросить подтверждение и дождаться ответа (прежний контракт: один
   * запрос — подготовить, опубликовать, дождаться).
   *
   * `signal` — отмена хода («Стоп», ADR-005): уже отменённый сигнал даёт
   * `cancelled:true` без публикации `permission.asked`; отмена во время
   * ожидания снимает таймер/подписку и резолвит тем же `cancelled:true`.
   */
  async waitForDecision(
    sessionId: string,
    request: ApprovalRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    const [waiter] = this.prepareWaiters(sessionId, [request], timeoutMs, signal);
    if (!waiter) return { approved: false, noSubscribers: true };
    this.publishWaiters([waiter]);
    return waiter.decision;
  }

  /**
   * Ожидающие ответа подтверждения сессии (ADR-029).
   *
   * Источник истины для восстановления полосы подтверждения после
   * перезагрузки страницы: HTTP-роут `GET /api/v2/sessions/:id/permissions`.
   * Ответ/таймаут/отмена хода/каскадный отказ убирают запись — в списке её
   * уже нет.
   */
  listPending(sessionId: string): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const item of this._pending.values()) {
      if (item.sessionId === sessionId) out.push(item);
    }
    return out;
  }

  /** Ожидание подтверждения по `approvalId` (любая сессия). */
  get(approvalId: string): PendingApproval | undefined {
    return this._pending.get(approvalId);
  }

  /** Ожидание, закрытое сразу (без публикации запроса). */
  private _closedWaiter(
    sessionId: string,
    request: ApprovalRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    decision: ApprovalDecision,
  ): InternalWaiter {
    const waiter = this._createWaiter(sessionId, request, timeoutMs, signal);
    waiter.finish(decision);
    return waiter;
  }

  /** Создать ожидание: подписка на ответ, таймер, отмена хода. */
  private _createWaiter(
    sessionId: string,
    request: ApprovalRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): InternalWaiter {
    const state: WaiterState = {
      settled: false,
      held: false,
      published: false,
      unsubscribe: () => {},
    };
    let resolveDecision!: (decision: ApprovalDecision) => void;
    const decision = new Promise<ApprovalDecision>((resolve) => { resolveDecision = resolve; });

    const finish = (d: ApprovalDecision): void => {
      if (state.settled) return;
      state.settled = true;
      if (state.timer) clearTimeout(state.timer);
      state.unsubscribe();
      if (signal && state.abortListener) signal.removeEventListener('abort', state.abortListener);
      this._options.registry?.close(request.approvalId);
      // Запрос больше не ожидает ответа — в списке pending его быть не должно
      // (ответ/таймаут/отмена хода/каскадный отказ — любой путь через `finish`).
      this._pending.delete(request.approvalId);
      resolveDecision(d);
    };

    const waiter: InternalWaiter = {
      approvalId: request.approvalId,
      decision,
      get settled() { return state.settled; },
      resolve: (d: ApprovalDecision) => {
        // Разрешение из кода (переоценка соседей после гранта «в сессии»):
        // подтверждение списывается — поздний ответ пользователя на него не
        // должен его одобрить (`already_consumed`, ADR-106 Ф3).
        this._options.registry?.consume(request.approvalId);
        finish(d);
      },
      sessionId,
      request,
      timeoutMs,
      state,
      finish,
    };

    const onEvent = (event: { type: string; data: Record<string, unknown> }): void => {
      if (state.settled) return;
      const data = event.data as Record<string, unknown>;

      // «Остановить таймер» (permission.hold): снимаем авто-отклонение по
      // таймауту. Запрос остаётся на паузе до тех пор, пока не придёт
      // permission.replied. Чужой hold не трогает это ожидание.
      if (event.type === 'permission.hold') {
        if (data.approval_id !== request.approvalId) return;
        if (!state.held) {
          state.held = true;
          if (state.timer) clearTimeout(state.timer);
          // Восстановленная карточка не должна ставить свой таймер — запрос
          // живёт до ответа (метка `held` уезжает в DTO восстановления).
          const pending = this._pending.get(request.approvalId);
          if (pending) pending.held = true;
        }
        return;
      }

      if (event.type !== 'permission.replied') return;

      if (data.approval_id !== request.approvalId) {
        // PROP-127 (этап T5): каскад отказа. Отказ по одному подтверждению
        // гасит остальные ожидания той же сессии (паритет с opencode) — иначе
        // ход ждал бы ответов на вопросы, на которые пользователь уже
        // отказал, и шаг «зависал» бы до ask-таймаута.
        if (!isUserDenyReply(data)) return;
        this._cascadeDeny(waiter);
        return;
      }

      const action = data.action === 'allow' || data.action === 'deny' ? data.action : undefined;
      const d: ApprovalDecision = {
        approved: action !== undefined ? action === 'allow' : data.approved === true,
      };
      if (action) d.action = action;
      if (typeof data.once === 'boolean') d.once = data.once;
      finish(d);
    };

    // Подписка ДО публикации: EventBus.publish синхронный, иначе ответ
    // мгновенного подписчика (имитация UI) был бы потерян.
    state.unsubscribe = this._eventBus.subscribe(sessionId, onEvent);

    // «Стоп» посреди ожидания: снимаем таймер/подписку и сразу отдаём
    // `cancelled` — иначе инструмент висел бы до ask-таймаута.
    if (signal) {
      state.abortListener = (): void => finish({ approved: false, cancelled: true });
      signal.addEventListener('abort', state.abortListener, { once: true });
    }

    return waiter;
  }

  /** Опубликовать запрос подтверждения (`permission.asked`) и включить таймер. */
  private _publishWaiter(waiter: InternalWaiter): void {
    if (waiter.state.settled || waiter.state.published) return;
    waiter.state.published = true;
    const { request, timeoutMs, sessionId } = waiter;

    // ADR-029: askTimeoutMs <= 0 (0 = «таймаут выключен») — таймер не ставим,
    // ждём permission.replied бесконечно (без авто-отклонения).
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      waiter.state.timer = setTimeout(() => {
        waiter.finish({ approved: false, timeout: true });
      }, timeoutMs);
    }

    // ADR-106 Ф0/Ф3: привязка подтверждения регистрируется ДО публикации —
    // ответ мгновенного подписчика должен найти привязку.
    this._registerBinding(waiter);

    // Реестр ожиданий: запрос появился в списке pending ДО публикации —
    // восстановление после перезагрузки не должно его потерять.
    this._pending.set(request.approvalId, {
      sessionId,
      request,
      timeoutMs,
      askedAt: new Date().toISOString(),
      held: false,
    });

    this._eventBus.publish(sessionId, 'permission.asked', {
      approval_id: request.approvalId,
      session_id: sessionId,
      call_id: request.callId,
      tool: request.toolName,
      arguments: request.arguments,
      reason: request.reason,
      ask_timeout_ms: timeoutMs,
      // ADR-106 Ф0: аддитивные поля (принципал/ход/отпечаток).
      ...(request.principal ? { principal: request.principal } : {}),
      ...(request.turnId ? { turn_id: request.turnId } : {}),
      digest: this._digestOf(request, sessionId),
      // ADR-029: аддитивное превью изменений (дифф по файлам).
      ...(request.preview ? { preview: request.preview } : {}),
      // Shell-грант: какие паттерны будут разрешены в сессии.
      ...(request.save ? { save: request.save } : {}),
      // Структурная причина ask'а («виновник») — machine-readable.
      ...(request.trigger ? { trigger: request.trigger } : {}),
    });
  }

  /**
   * Каскад отказа: погасить ожидание как отказанное и сообщить UI.
   *
   * Публикуем `permission.replied` — карточка подтверждения убирается из
   * очереди (пользователь не отвечал на неё — снять её должен сервер).
   */
  private _cascadeDeny(waiter: InternalWaiter): void {
    if (waiter.state.settled) return;
    // ADR-106 Ф3: каскадное подтверждение списывается — поздний/опоздавший
    // ответ на него не должен его одобрить (`already_consumed`).
    this._options.registry?.consume(waiter.request.approvalId);
    waiter.finish({ approved: false, action: 'deny', cascaded: true });
    this._eventBus.publish(waiter.sessionId, 'permission.replied', {
      approval_id: waiter.request.approvalId,
      session_id: waiter.sessionId,
      approved: false,
      action: 'deny',
      cascaded: true,
    });
  }

  /**
   * ADR-106 Ф0/Ф3: отпечаток запроса — из запроса; для привязанного
   * (Authority) запроса — отпечаток привязки «ход + действие + цель».
   */
  private _digestOf(request: ApprovalRequest, sessionId: string): string {
    const { action: boundAction, target: boundTarget, turnId: boundTurnId } = request;
    const bound =
      boundAction !== undefined && boundTarget !== undefined && boundTurnId !== undefined;
    if (bound) {
      return computeAuthorityApprovalDigest({
        turnId: boundTurnId,
        action: boundAction,
        target: boundTarget,
      });
    }
    return request.digest
      ?? computePermissionDigest({
        sessionId,
        turnId: request.turnId,
        toolName: request.toolName,
        args: request.arguments,
      });
  }

  /**
   * ADR-106 Ф3: регистрируем привязку подтверждения — ответ принимает только
   * носитель покрывающего гранта, повторный ответ — отказ.
   */
  private _registerBinding(waiter: InternalWaiter): void {
    const { request } = waiter;
    const { action: boundAction, target: boundTarget, turnId: boundTurnId } = request;
    if (boundAction === undefined || boundTarget === undefined || boundTurnId === undefined) return;
    this._options.registry?.open(request.approvalId, {
      principal: request.principal ?? { kind: 'user', id: 'local', roles: [] },
      turnId: boundTurnId,
      action: boundAction,
      target: boundTarget,
      digest: this._digestOf(request, waiter.sessionId),
    });
  }
}

// --- ADR-106 Ф3: реестр подтверждений ---

/**
 * Привязка подтверждения (ADR-106 Ф3): `(принципал, ход, действие, цель,
 * отпечаток)`. Подтверждение выдаётся на конкретное действие конкретного хода
 * и **одноразово**.
 */
export interface ApprovalBinding {
  /** Принципал хода, которому адресован запрос. */
  principal: AuthorityPrincipal;
  /** Ход (`turn_id`), которому принадлежит запрос. */
  turnId: string;
  /** Действие Authority-слоя. */
  action: string;
  /** Цель Authority-слоя. */
  target: AuthorityTarget;
  /** Отпечаток привязки (ход + действие + цель). */
  digest: string;
}

/** Причины отказа в подтверждении (ADR-106 Ф3). */
export type ApprovalClaimReason =
  | 'ok'
  | 'unknown_approval'
  | 'already_consumed'
  | 'turn_mismatch'
  | 'digest_mismatch'
  | 'no_grant';

/** Итог попытки подтвердить запрос. */
export interface ApprovalClaimResult {
  /** true — ответ принят (подтверждение списано). */
  ok: boolean;
  /** Причина (при `ok: false` — почему отказано). */
  reason: ApprovalClaimReason;
  /** Привязка подтверждения (если запрос известен). */
  binding?: ApprovalBinding;
}

/**
 * Проверка права подтверждать: носитель **покрывающего гранта**
 * (ADR-106 §«Резолвинг и решение», п. 2 `approve`).
 *
 * Резолвер не доверяет клиенту: он получает **аутентифицированного** принципала
 * и проверяет его гранты (роли инстанса, роль в проекте, гранты политики).
 */
export type ApprovalCoverageResolver = (
  sessionId: string,
  responder: AuthorityPrincipal,
  binding: ApprovalBinding,
) => boolean | Promise<boolean>;

/** Опции реестра подтверждений. */
export interface ApprovalRegistryOptions {
  /**
   * Резолвер покрытия (носитель покрывающего гранта). Не задан — **fail-closed**:
   * ни одно подтверждение не принимается (защищённый режим).
   */
  coverage?: ApprovalCoverageResolver;
}

/**
 * Реестр подтверждений (ADR-106 Ф3) — **единственное** место, где решается,
 * можно ли принять ответ на запрос подтверждения.
 *
 * Инварианты:
 * 1. **одноразовость**: принятое подтверждение списывается; повторный ответ —
 *    отказ (`already_consumed`);
 * 2. **привязка к ходу**: ответ с чужим `turn_id`/`digest` — отказ;
 * 3. **носитель покрывающего гранта**: ответ без гранта — отказ (`no_grant`).
 *
 * Реестр живёт на инстанс (в процессе), состояние — в памяти (ADR-099 п. 24).
 */
export class ApprovalRegistry {
  private readonly _pending = new Map<string, ApprovalBinding>();
  private readonly _consumed = new Set<string>();

  constructor(private readonly _options: ApprovalRegistryOptions = {}) {}

  /** Зарегистрировать привязку запроса подтверждения. */
  open(approvalId: string, binding: ApprovalBinding): void {
    this._pending.set(approvalId, binding);
    this._consumed.delete(approvalId);
  }

  /** Снять привязку (ответ получен или истёк таймаут). */
  close(approvalId: string): void {
    this._pending.delete(approvalId);
  }

  /**
   * Списать подтверждение **без ответа пользователя** (PROP-127 T5: каскад
   * отказа по пакету ожидающих).
   *
   * Подтверждение становится «использованным»: поздний/опоздавший ответ на
   * него — отказ (`already_consumed`), одобрение уже невозможно. Инвариант
   * одноразовости (ADR-106 Ф3) сохраняется.
   */
  consume(approvalId: string): void {
    if (!this._pending.has(approvalId)) return;
    this._consumed.add(approvalId);
    this._pending.delete(approvalId);
  }

  /** Привязка запроса (без списания). */
  get(approvalId: string): ApprovalBinding | undefined {
    return this._pending.get(approvalId);
  }

  /**
   * Попытка принять ответ на запрос подтверждения.
   *
   * `opts.turnId`/`opts.digest` — то, что прислал клиент (необязательно): при
   * расхождении с привязкой — отказ. Клиенту доверять нельзя, поэтому
   * привязка всегда берётся из реестра.
   */
  async claim(
    approvalId: string,
    sessionId: string,
    responder: AuthorityPrincipal,
    opts: { turnId?: string; digest?: string } = {},
  ): Promise<ApprovalClaimResult> {
    const binding = this._pending.get(approvalId);
    if (!binding) {
      return {
        ok: false,
        reason: this._consumed.has(approvalId) ? 'already_consumed' : 'unknown_approval',
      };
    }
    if (this._consumed.has(approvalId)) {
      return { ok: false, reason: 'already_consumed', binding };
    }
    if (opts.turnId !== undefined && opts.turnId !== binding.turnId) {
      return { ok: false, reason: 'turn_mismatch', binding };
    }
    if (opts.digest !== undefined && opts.digest !== binding.digest) {
      return { ok: false, reason: 'digest_mismatch', binding };
    }

    // Носитель покрывающего гранта. Резолвер не задан — fail-closed.
    const covered = this._options.coverage
      ? await this._options.coverage(sessionId, responder, binding)
      : false;
    if (!covered) {
      return { ok: false, reason: 'no_grant', binding };
    }

    this._consumed.add(approvalId);
    this._pending.delete(approvalId);
    return { ok: true, reason: 'ok', binding };
  }
}
