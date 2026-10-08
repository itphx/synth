import type { EventBinding, RouteDecision, SynthEvent } from '@itphx/synth-shared';

/**
 * AD-089: внутреннее решение funnel `RequestSessionService`. `direct` — явное
 * создание сессии (UI/CLI/агент) без внешнего события; остальные варианты —
 * результат маршрутизации внешнего события (`RouteDecision`).
 */
export type SessionResolution = { kind: 'direct' } | RouteDecision;

/** AD-089: вход правила маршрутизации — событие + текущий реестр биндингов. */
export interface RouteRuleInput {
  event: SynthEvent;
  bindings: EventBinding[];
}

/**
 * AD-089: точка расширения правил маршрутизации (seam под будущие плагины,
 * AD-086). Провайдеры вызываются по порядку регистрации; первый непустой
 * результат выигрывает.
 */
export interface RouteRuleProvider {
  readonly name: string;
  resolve(input: RouteRuleInput): RouteDecision | null | Promise<RouteDecision | null>;
}

/** AD-089: конфигурация `EventRouter`. */
export interface EventRouterConfig {
  /** Белый список источников; пусто или не задано — разрешены все. */
  allowedSources?: string[];
  /** TTL ephemeral-сессий по умолчанию (напр. `'24h'`). */
  defaultEphemeralTtl: string;
}

/**
 * AD-089: доставка сообщения события в сессию. `run` — запустить процессор
 * сейчас; `defer` — только положить в очередь владельца (без старта).
 */
export type EventDelivery = (
  sessionId: string,
  event: SynthEvent,
  mode: 'run' | 'defer',
) => Promise<void>;
