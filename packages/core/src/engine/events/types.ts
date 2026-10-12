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
  /**
   * Политика фоллбека (`decide`, шаг 5), если ни `EventBinding`, ни правила не
   * выбрали маршрут: `bound` — осознанный `drop no_route` с аудитом (default);
   * `ephemeral` — создать временную сессию (`agentTemplate: ''`, TTL
   * `defaultEphemeralTtl`) — агент по умолчанию решает `RequestSessionService`.
   */
  defaultMode?: 'bound' | 'ephemeral';
  /** TTL ephemeral-сессий по умолчанию (напр. `'24h'`). */
  defaultEphemeralTtl: string;
  /**
   * AD-089 (auto-bind): фоллбек Router — если у события есть `identity.chatKey`
   * или `identity.threadKey`, вернуть `{ kind: 'bind' }` (сессия + `EventBinding
   * mode='bound'` создаются `RequestSessionService`) вместо `defaultMode`.
   * По умолчанию выключено. Влияет **только** на фоллбек.
   */
  autoBind?: boolean;
  /** AD-089 (auto-bind): шаблон агента auto-bind-сессий (пусто — по умолчанию). */
  autoBindAgentTemplate?: string;
}

/**
 * AD-089 (этап 5): контекст внешнего отправителя, сопровождающий доставку
 * события. `roles` — эффективные роли (профиль ∩ `identity.roles`), `linked` —
 * сопознан ли отправитель с пользователем инстанса. Используется `deliver` для
 * переноса прав отправителя на ход (metadata сообщения); сам permission-слой
 * роль-осей пока не имеет (см. `identity-roles.ts`).
 */
export interface EventDeliveryContext {
  roles: string[];
  linked: boolean;
}

/**
 * AD-089: доставка сообщения события в сессию. `run` — запустить процессор
 * сейчас; `defer` — только положить в очередь владельца (без старта).
 *
 * AD-089 (этап 5): необязательный `context` несёт эффективные роли отправителя
 * (`resolveEffectiveRoles`). Не задан — прежнее поведение (обратная
 * совместимость; `deliver` сам решает, писать ли роли в metadata).
 */
export type EventDelivery = (
  sessionId: string,
  event: SynthEvent,
  mode: 'run' | 'defer',
  context?: EventDeliveryContext,
) => Promise<void>;
