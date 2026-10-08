import type { EventBinding, RouteDecision, SynthEvent } from '@itphx/synth-shared';
import type { EventBindingStore } from '../../storage/event-binding-store.js';
import type { EventJournalStore } from '../../storage/event-journal-store.js';
import type { HookBus } from '../hooks/hook-bus.js';
import type { EventRouterConfig, RouteRuleInput, RouteRuleProvider } from './types.js';

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
}

const FALLBACK_EPHEMERAL_TTL = '24h';

/**
 * AD-089: роутер внешних событий — чистое решение (без журналирования) плюс
 * запись результата в журнал. Порядок `decide` строго по AD-089:
 * 1. `allowedSources` — непустой список и источник не в нём → `drop`.
 * 2. `dedup` — `dedupKey` уже встречался → `drop duplicate`.
 * 3. Явный `Binding` по `threadKey` (приоритетнее) / `chatKey` → по `mode`.
 * 4. Rule providers — первый непустой результат.
 * 5. Фоллбек → `drop no_route`.
 *
 * Решение не пишется в журнал: `record` вызывается отдельно (после
 * материализации), поэтому ошибки материализации не теряются.
 */
export class EventRouter {
  private _bindingStore: EventBindingStore;
  private _journal: EventJournalStore;
  private _config: EventRouterConfig;
  private _ruleProviders: RouteRuleProvider[] = [];
  /** Ленивый dedup-кэш: инициализируется из журнала при первом decide/record. */
  private _dedup?: Set<string>;

  constructor(deps: EventRouterDeps) {
    this._bindingStore = deps.bindingStore;
    this._journal = deps.journal;
    this._config = {
      allowedSources: deps.config?.allowedSources,
      defaultEphemeralTtl: deps.config?.defaultEphemeralTtl ?? FALLBACK_EPHEMERAL_TTL,
    };
    if (deps.ruleProviders) this._ruleProviders.push(...deps.ruleProviders);
  }

  /** AD-089: регистрация правила маршрутизации (порядок = приоритет). */
  registerRuleProvider(provider: RouteRuleProvider): void {
    this._ruleProviders.push(provider);
  }

  /** Решение по событию БЕЗ записи в журнал и без побочных эффектов. */
  async decide(event: SynthEvent): Promise<RouteDecision> {
    // 1. Белый список источников.
    const allowed = this._config.allowedSources;
    if (allowed && allowed.length > 0 && !allowed.includes(event.source)) {
      return { kind: 'drop', reason: 'source_not_allowed', audited: true };
    }

    // 2. Дедуп по стабильному ключу.
    const seen = await this._ensureDedup();
    if (event.dedupKey && seen.has(event.dedupKey)) {
      return { kind: 'drop', reason: 'duplicate', audited: true };
    }

    // 3. Явный Binding (threadKey приоритетнее chatKey — в store).
    const binding = await this._bindingStore.findByKey({
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

    // 5. Фоллбек — дроп с аудитом (событие не теряется молча).
    return { kind: 'drop', reason: 'no_route', audited: true };
  }

  /**
   * Запись решения в журнал. `dedupKey` попадает в dedup-кэш — повторное
   * событие с тем же ключом будет отброшено как `duplicate` (AD-089).
   */
  async record(event: SynthEvent, decision: RouteDecision, error?: string): Promise<void> {
    const seen = await this._ensureDedup();
    await this._journal.record({
      ts: new Date().toISOString(),
      event,
      decision,
      ...(error ? { error } : {}),
    });
    if (event.dedupKey) seen.add(event.dedupKey);
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

  /** Ленивая инициализация dedup-кэша из журнала (только чтение). */
  private async _ensureDedup(): Promise<Set<string>> {
    if (this._dedup) return this._dedup;
    const set = new Set<string>();
    try {
      const entries = await this._journal.list();
      for (const entry of entries) {
        if (entry.event?.dedupKey) set.add(entry.event.dedupKey);
      }
    } catch (err) {
      console.warn(`[EventRouter] не удалось прочитать журнал для dedup: ${String(err)}`);
    }
    this._dedup = set;
    return set;
  }
}
