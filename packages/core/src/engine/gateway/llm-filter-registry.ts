/**
 * PROP-090 §«Точка `llmFilters`»: реестр фильтров LLM-вызовов.
 *
 * Реестр живёт рядом с `GatewayProvider` (`engine/gateway/gateway-provider.ts`):
 * gateway обходит его в нужной фазе (`pre_request`/`post_response`/`embedding`)
 * и применяет вердикты. Реестр **мутабельный**: плагины подключаются и
 * отключаются во время работы инстанса (активация/деактивация плагина).
 *
 * **Правила регистрации (fail-closed).**
 * - идентификатор непустой и уникален в инстансе (`plugin:<plugin>:<filter>`);
 * - фаза — из известного перечня;
 * - доверие владельца не задано → `community` (вeto нет, режим отказа — `open`).
 *
 * **Право вето — только у доверенных** (PROP-090 §«Кто вправе блокировать»):
 * фильтр с trust ниже `trusted` не может заблокировать или переписать вызов —
 * хост понижает его вердикт до `allow` и пишет событие в журнал плагинов.
 *
 * Реестр не знает про плагины: он работает с фильтрами как с абстракцией.
 * Владелец (имя плагина, его версия, уровень доверия) задаётся при
 * регистрации — вызывающей стороной (фасад плагина,
 * `engine/plugins/activation.ts`).
 */
import type {
  CatalogTrustLevel,
  LlmCallFilter,
  LlmFilterFailMode,
  LlmFilterPhase,
  LlmFilterVerdictKind,
} from '@itphx/synth-shared';
import {
  DEFAULT_LLM_FILTER_TIMEOUT_MS,
  isLlmFilterPhase,
  phaseCanBlock,
} from '@itphx/synth-shared';
import { trustLevelRank } from '@itphx/synth-shared';

/** Ошибка регистрации фильтра (понятная причина — не тихий отказ). */
export class LlmFilterRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmFilterRegistrationError';
  }
}

/**
 * Событие журнала плагинов о решении фильтра (действие `filter`).
 *
 * Пишет владелец фильтра (плагин) через колбэк `onAudit` — журнал плагинов
 * остаётся отдельным от аудита gateway (ADR-096, PROP-090 §9).
 */
export interface LlmFilterAuditEvent {
  /** Идентификатор фильтра. */
  filterId: string;
  /** Имя плагина-владельца. */
  pluginName?: string;
  /** Версия плагина-владельца. */
  pluginVersion?: string;
  /** Фаза, в которой сработал фильтр. */
  phase: LlmFilterPhase;
  /** Вердикт фильтра (исходный, до понижения). */
  verdict: LlmFilterVerdictKind;
  /** Вердикт после понижения хостом (`allow`, если понижен). */
  effectiveVerdict?: LlmFilterVerdictKind;
  /** Понижен ли вердикт хостом (нет права вето у владельца). */
  downgraded?: boolean;
  /** Код причины (`plugin_filter.deny_downgraded` и т. п.). */
  code?: string;
  /** Человекочитаемая причина. */
  reason?: string;
  /** Провайдер. */
  provider: string;
  /** Модель. */
  model: string;
  /** Сессия (пусто — вызов вне сессии). */
  sessionId?: string;
}

/** Параметры регистрации фильтра. */
export interface LlmFilterRegistrationOptions {
  /**
   * Уровень доверия владельца (плагина). Не задан — `community`
   * (fail-closed: права вето нет).
   */
  trustLevel?: CatalogTrustLevel;
  /** Имя плагина-владельца (для журнала плагинов). */
  pluginName?: string;
  /** Версия плагина-владельца (для журнала плагинов). */
  pluginVersion?: string;
  /** Колбэк журнала плагинов (событие действия `filter`). */
  onAudit?: (event: LlmFilterAuditEvent) => void | Promise<void>;
  /** Переопределение режима отказа (хост-политика). */
  failMode?: LlmFilterFailMode;
  /** Переопределение бюджета времени, мс (хост-политика). */
  timeoutMs?: number;
}

/** Зарегистрированный фильтр вместе с метаданными регистрации. */
export interface RegisteredLlmFilter {
  /** Собственно фильтр. */
  filter: LlmCallFilter;
  /** Уровень доверия владельца. */
  trustLevel: CatalogTrustLevel;
  /** Имя плагина-владельца. */
  pluginName?: string;
  /** Версия плагина-владельца. */
  pluginVersion?: string;
  /** Разрешённый режим отказа (с учётом класса фильтра и доверия). */
  failMode: LlmFilterFailMode;
  /** Разрешённый бюджет времени, мс. */
  timeoutMs: number;
  /** Колбэк журнала плагинов. */
  onAudit?: (event: LlmFilterAuditEvent) => void | Promise<void>;
}

/** Опции реестра. */
export interface LlmFilterRegistryOptions {
  /**
   * Бюджет времени на вызов фильтра по умолчанию, мс
   * (`plugins.llmFilterTimeoutMs`).
   */
  defaultTimeoutMs?: number;
}

/**
 * Порог доверия для права вето: блокировать/переписывать вызов могут только
 * плагины с trust не ниже `trusted` (PROP-090 §«Кто вправе блокировать»).
 */
export const LLM_FILTER_VETO_TRUST_LEVEL: CatalogTrustLevel = 'trusted';

/**
 * Есть ли у владельца право вето (блокировать/переписывать вызов).
 *
 * `trustLevelRank`: меньше — довереннее (`builtin` = 0). Право вето есть у
 * `builtin`/`verified`/`trusted`.
 */
export function canVetoLlmFilter(trustLevel: CatalogTrustLevel | undefined): boolean {
  const level: CatalogTrustLevel = trustLevel ?? 'community';
  return trustLevelRank(level) <= trustLevelRank(LLM_FILTER_VETO_TRUST_LEVEL);
}

/**
 * Режим отказа фильтра по умолчанию — **по классу фильтра**:
 * - блокирующий (`pre_request`/`embedding` + доверие, дающее право вето) —
 *   `closed` (сбой/таймаут → вызов не уходит провайдеру);
 * - наблюдательный (`post_response`, либо владелец без права вето) — `open`
 *   (сбой не влияет на вызов, факт — в аудите).
 */
export function defaultLlmFilterFailMode(
  phase: LlmFilterPhase,
  trustLevel: CatalogTrustLevel | undefined,
): LlmFilterFailMode {
  if (!phaseCanBlock(phase)) return 'open';
  if (!canVetoLlmFilter(trustLevel)) return 'open';
  return 'closed';
}

/**
 * Реестр фильтров LLM-вызовов.
 *
 * Порядок обхода — порядок регистрации; `unregister`/disposer удаляет фильтр
 * (следующий вызов его уже не видит).
 */
export class LlmFilterRegistry {
  private readonly _filters = new Map<string, RegisteredLlmFilter>();
  /**
   * Бюджет времени по умолчанию для **новых** регистраций, мс.
   *
   * Мутабельный (`setDefaultTimeoutMs`) — политика инстанса
   * (`plugins.llmFilterTimeoutMs`) может меняться в runtime. Уже
   * зарегистрированные фильтры сохраняют бюджет, выбранный при регистрации
   * (иначе смена политики задним числом меняла бы поведение активных плагинов).
   */
  private _defaultTimeoutMs: number;

  constructor(options: LlmFilterRegistryOptions = {}) {
    this._defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_LLM_FILTER_TIMEOUT_MS;
  }

  /** Текущий бюджет времени по умолчанию, мс. */
  get defaultTimeoutMs(): number {
    return this._defaultTimeoutMs;
  }

  /**
   * Сменить бюджет времени по умолчанию, мс (политика инстанса).
   *
   * Действует на **последующие** регистрации: у уже зарегистрированных
   * фильтров бюджет зафиксирован при регистрации (поле `timeoutMs` записи),
   * поэтому смена политики не переписывает поведение активных плагинов.
   *
   * @throws {RangeError} — не положительное конечное число.
   */
  setDefaultTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new RangeError(
        `Бюджет времени фильтра LLM-вызовов должен быть положительным числом (получено: ${String(ms)}).`,
      );
    }
    this._defaultTimeoutMs = ms;
  }

  /**
   * Зарегистрировать фильтр.
   *
   * @returns disposer — снимает фильтр (идемпотентен).
   * @throws {LlmFilterRegistrationError} — пустой/занятый идентификатор или
   *   неизвестная фаза.
   */
  register(
    filter: LlmCallFilter,
    opts: LlmFilterRegistrationOptions = {},
  ): () => void {
    const id = filter?.id?.trim() ?? '';
    if (!id) {
      throw new LlmFilterRegistrationError(
        'Фильтр LLM-вызовов не задан (пустой id) — фильтр не зарегистрирован.',
      );
    }
    if (!isLlmFilterPhase(filter.phase)) {
      throw new LlmFilterRegistrationError(
        `Фильтр LLM-вызовов «${id}» заявил неизвестную фазу «${String(filter.phase)}» — ` +
        'фильтр не зарегистрирован.',
      );
    }
    if (this._filters.has(id)) {
      throw new LlmFilterRegistrationError(
        `Фильтр LLM-вызовов «${id}» уже зарегистрирован: ` +
        'идентификатор фильтра должен быть уникален в инстансе.',
      );
    }

    const trustLevel: CatalogTrustLevel = opts.trustLevel ?? 'community';
    const failMode: LlmFilterFailMode =
      opts.failMode
      ?? filter.failMode
      ?? defaultLlmFilterFailMode(filter.phase, trustLevel);
    const timeoutMs =
      opts.timeoutMs
      ?? filter.timeoutMs
      ?? this._defaultTimeoutMs;

    this._filters.set(id, {
      filter,
      trustLevel,
      ...(opts.pluginName ? { pluginName: opts.pluginName } : {}),
      ...(opts.pluginVersion ? { pluginVersion: opts.pluginVersion } : {}),
      failMode,
      timeoutMs,
      ...(opts.onAudit ? { onAudit: opts.onAudit } : {}),
    });

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this._filters.delete(id);
    };
  }

  /** Снять фильтр по идентификатору (`false` — фильтра не было). */
  unregister(id: string): boolean {
    return this._filters.delete(id);
  }

  /** Запись по идентификатору (`undefined` — не зарегистрирован). */
  get(id: string): RegisteredLlmFilter | undefined {
    return this._filters.get(id);
  }

  /** Фильтры фазы в порядке регистрации (пусто — все фазы). */
  list(phase?: LlmFilterPhase): RegisteredLlmFilter[] {
    const all = [...this._filters.values()];
    return phase ? all.filter((entry) => entry.filter.phase === phase) : all;
  }

  /** Число зарегистрированных фильтров. */
  get size(): number {
    return this._filters.size;
  }

  /** Снять все фильтры (служебно — тесты/сброс). */
  clear(): void {
    this._filters.clear();
  }
}
