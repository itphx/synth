import type { EventBinding, RouteDecision, SynthEvent } from '@itphx/synth-shared';
import type { EventBindingStore } from '../../storage/event-binding-store.js';
import type { EventJournalStore } from '../../storage/event-journal-store.js';
import type { HookBus } from '../hooks/hook-bus.js';
import { MemoryDedupStore } from './dedup-store.js';
import type { DedupStore } from './dedup-store.js';
import type { EventRouterConfig, RouteRuleInput, RouteRuleProvider } from './types.js';

/** AD-089: фоллбек `defaultMode` по умолчанию — осознанный drop с аудитом. */
const FALLBACK_DEFAULT_MODE = 'bound' as const;

/** AD-089: параметры `EventRouter`. */
export interface EventRouterDeps {
  bindingStore: EventBindingStore;
  journal: EventJournalStore;
  config?: Partial<EventRouterConfig>;
  ruleProviders?: RouteRuleProvider[];
  /**
   * AD-030/AD-089: шина хуков. Принята как точка расширения — сам `decide`
   * хуков не эмитит (это делает `RequestSessionService`), поэтому пока не
   * сохраняется в состоянии.
   */
  hooks?: HookBus;
  /**
   * AD-051/AD-089: источник дедупа. По умолчанию `MemoryDedupStore`
   * (single-process); `file` — межпроцессный атомарный claim на общем `dataDir`.
   */
  dedupStore?: DedupStore;
}

const FALLBACK_EPHEMERAL_TTL = '24h';

/**
 * AD-089: роутер внешних событий — чистое решение (без журналирования) плюс
 * запись результата в журнал. Порядок `decide` строго по AD-089:
 * 1. `allowedSources` — непустой список и источник не в нём → `drop`.
 * 2. `dedup` — атомарный claim `dedupKey` в `DedupStore`; ключ занят → `drop duplicate`.
 * 3. Явный `Binding` по `threadKey` (приоритетнее) / `chatKey` → по `mode`.
 * 4. Rule providers — первый непустой результат.
 * 5. Фоллбек → по `defaultMode`: `bound` (drop `no_route`) или `ephemeral`.
 *
 * Решение не пишется в журнал: `record` вызывается отдельно (после
 * материализации), поэтому ошибки материализации не теряются. Dedup-кэш
 * предзаполняется из журнала лениво (один раз) — ключи чужих процессов ловятся
 * и в `memory`-режиме.
 */
export class EventRouter {
  private _bindingStore: EventBindingStore;
  private _journal: EventJournalStore;
  private _config: EventRouterConfig;
  private _ruleProviders: RouteRuleProvider[] = [];
  private _dedupStore: DedupStore;
  /** Однократное предзаполнение dedup-кэша из журнала (общий промис). */
  private _seedPromise?: Promise<void>;

  constructor(deps: EventRouterDeps) {
    this._bindingStore = deps.bindingStore;
    this._journal = deps.journal;
    this._dedupStore = deps.dedupStore ?? new MemoryDedupStore();
    this._config = {
      allowedSources: deps.config?.allowedSources,
      defaultMode: deps.config?.defaultMode ?? FALLBACK_DEFAULT_MODE,
      defaultEphemeralTtl: deps.config?.defaultEphemeralTtl ?? FALLBACK_EPHEMERAL_TTL,
    };
    if (deps.ruleProviders) this._ruleProviders.push(...deps.ruleProviders);
  }

  /** AD-089: регистрация правила маршрутизации (порядок = приоритет). */
  registerRuleProvider(provider: RouteRuleProvider): void {
    this._ruleProviders.push(provider);
  }

  /**
   * AD-089: live-обновление конфигурации Router (runtime-настройки из админки).
   * Незаданные поля мержатся поверх текущих значений (`_config`).
   */
  updateConfig(partial: Partial<EventRouterConfig>): void {
    if (partial.allowedSources !== undefined) this._config.allowedSources = partial.allowedSources;
    if (partial.defaultMode !== undefined) this._config.defaultMode = partial.defaultMode;
    if (partial.defaultEphemeralTtl !== undefined) {
      this._config.defaultEphemeralTtl = partial.defaultEphemeralTtl;
    }
  }

  /**
   * Решение по событию БЕЗ записи в журнал и без побочных эффектов.
   *
   * AD-089: `forcedBinding` (аутентификация по API-ключу привязки) заменяет
   * поиск в `EventBindingStore` на шаге 3; шаги 1 (`allowedSources`) и 2 (dedup)
   * сохраняются.
   */
  async decide(event: SynthEvent, forcedBinding?: EventBinding): Promise<RouteDecision> {
    // 1. Белый список источников.
    const allowed = this._config.allowedSources;
    if (allowed && allowed.length > 0 && !allowed.includes(event.source)) {
      return { kind: 'drop', reason: 'source_not_allowed', audited: true };
    }

    // 2. Дедуп по стабильному ключу: атомарный claim (межпроцессный — при
    // `file`-store). Ключ, занятый другим обработчиком, — дубликат.
    await this._ensureDedup();
    if (event.dedupKey && !(await this._dedupStore.tryClaim(event.dedupKey))) {
      return { kind: 'drop', reason: 'duplicate', audited: true };
    }

    // 3. Явный Binding (threadKey приоритетнее chatKey — в store); при
    // `forcedBinding` (ключ привязки) поиск по ключу пропускается.
    const binding = forcedBinding ?? await this._bindingStore.findByKey({
      source: event.source,
      chatKey: event.identity?.chatKey,
      threadKey: event.identity?.threadKey,
    });
    if (binding) {
      const decision = this._decisionFromBinding(binding);
      if (decision) return decision;
    }

    // 4. Правила (первый непустой результат выигрывает).
    const bindings = await this._bindingStore.list();
    const input: RouteRuleInput = { event, bindings };
    for (const provider of this._ruleProviders) {
      try {
        const decision = await provider.resolve(input);
        if (decision) return decision;
      } catch (err) {
        console.warn(
          `[EventRouter] правило "${provider.name}" завершилось ошибкой: ${String(err)}`,
        );
      }
    }

    // 5. Фоллбек — политика `defaultMode` (AD-089): `ephemeral` создаёт
    // временную сессию (агент по умолчанию — резолвинг в `RequestSessionService`);
    // `bound` — осознанный дроп с аудитом (событие не теряется молча).
    if (this._config.defaultMode === 'ephemeral') {
      return {
        kind: 'ephemeral',
        agentTemplate: '',
        ttl: this._config.defaultEphemeralTtl,
      };
    }
    return { kind: 'drop', reason: 'no_route', audited: true };
  }

  /**
   * Запись решения в журнал. `dedupKey` дополнительно claim'ится — путь «hook
   * заблокировал до `decide`» вызывает только `record`, и ключ всё равно должен
   * быть занят (AD-089). В штатном пути ключ уже claim'нут в `decide`, поэтому
   * повторный claim — best-effort (результат игнорируется).
   *
   * AD-089/AD-052: `meta.keyId`/`meta.principalId` (аудит использования
   * API-ключа привязки) мержатся в запись журнала.
   */
  async record(
    event: SynthEvent,
    decision: RouteDecision,
    error?: string,
    meta?: { keyId?: string; principalId?: string },
  ): Promise<void> {
    await this._ensureDedup();
    await this._journal.record({
      ts: new Date().toISOString(),
      event,
      decision,
      ...(error ? { error } : {}),
      ...(meta?.keyId ? { keyId: meta.keyId } : {}),
      ...(meta?.principalId ? { principalId: meta.principalId } : {}),
    });
    if (event.dedupKey) {
      try {
        await this._dedupStore.tryClaim(event.dedupKey);
      } catch (err) {
        console.warn(`[EventRouter] не удалось claim'ить dedupKey при записи: ${String(err)}`);
      }
    }
  }

  private _decisionFromBinding(binding: EventBinding): RouteDecision | null {
    if (binding.mode === 'bound') {
      return binding.sessionId ? { kind: 'bound', sessionId: binding.sessionId } : null;
    }
    if (binding.mode === 'ephemeral') {
      return {
        kind: 'ephemeral',
        agentTemplate: binding.agentTemplate ?? '',
        ttl: this._config.defaultEphemeralTtl,
      };
    }
    if (binding.mode === 'queue') {
      return binding.sessionId
        ? { kind: 'queue', owner: binding.sessionId, reason: 'binding' }
        : null;
    }
    return null;
  }

  /** Ленивая (однократная) инициализация dedup-кэша из журнала (только чтение). */
  private _ensureDedup(): Promise<void> {
    if (!this._seedPromise) this._seedPromise = this._seedDedup();
    return this._seedPromise;
  }

  private async _seedDedup(): Promise<void> {
    const keys: string[] = [];
    try {
      const entries = await this._journal.list();
      for (const entry of entries) {
        if (entry.event?.dedupKey) keys.push(entry.event.dedupKey);
      }
    } catch (err) {
      console.warn(`[EventRouter] не удалось прочитать журнал для dedup: ${String(err)}`);
    }
    this._dedupStore.seed(keys);
  }
}
