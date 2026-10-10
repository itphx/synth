/**
 * DecisionRuleProvider — decision-классификация внешних событий (AD-084 × AD-089).
 *
 * Вызывается `EventRouter` после декларативных правил (`ProjectRuleProvider`) и
 * только при их промахе: decision-модель (System One: Clef/Jev/…) за один
 * forward-pass выбирает шаблон агента из списка enabled-агентов, и событие
 * направляется в ephemeral-сессию с этим агентом.
 *
 * Fail-safe (ключевой инвариант Router): любая ошибка, отключённый конфиг,
 * отсутствие провайдера/агентов, низкая уверенность или невалидный шаблон →
 * `null` — Router идёт к следующему правилу/фоллбеку (`defaultMode`).
 * Исключения наружу не пробрасываются.
 *
 * Провайдер **не создаёт сессий и не эмитит хуки** — это делает
 * `RequestSessionService` после выигрыша решения. Конфиги и список агентов
 * приходят геттерами, чтобы runtime-обновление (`/settings/events`, Ф5)
 * подхватывалось без пересоздания провайдера.
 */
import type { RouteDecision } from '@itphx/synth-shared';
import type {
  DecisionConfigLike,
  DecisionProviderResolver,
} from '../router/micro/models/decision-model.js';
import { decideChoiceCascade } from '../router/decision-cascade.js';
import { info } from '../../logger.js';
import { eventToMessageText } from './request-session.js';
import { decisionFromTarget } from './target-decision.js';
import type { RouteRuleInput, RouteRuleProvider } from './types.js';

/** Идентификатор decision-вопроса (ответ — id шаблона агента). */
export const DECISION_ROUTING_QUESTION_ID = 'agent';

/**
 * Минимум вариантов для `choice`-вопроса (System One-контракт: 2..26). При
 * одном enabled-агенте классифицировать нечего — fail-safe `null`.
 */
const MIN_ROUTING_CANDIDATES = 2;

/** Кандидат-шаблон агента для decision-вопроса. */
export interface DecisionAgentCandidate {
  /** id агента (он же — значение `agentTemplate` в решении). */
  id: string;
  /** Человекочитаемое имя (для criteria decision-вопроса). */
  displayName: string;
  /** Описание назначения агента (для criteria decision-вопроса). */
  description?: string;
}

/** Зависимости `DecisionRuleProvider` (все — живые геттеры). */
export interface DecisionRuleProviderDeps {
  /** Резолвер decision-провайдера (`ProviderPool.getDecisionProvider`, gateway-обвязка). */
  resolver: DecisionProviderResolver;
  /** Эффективный конфиг событий: флаг decision-маршрутизации и TTL ephemeral. */
  getEventsConfig: () => { decisionRouting: boolean; defaultEphemeralTtl: string };
  /** Эффективный конфиг decision-слоя (мастер-выключатель/провайдер/модель/порог). */
  getDecisionConfig: () => DecisionConfigLike | undefined;
  /** Enabled-шаблоны агентов для `criteria` decision-вопроса. */
  getAgentCandidates: () => DecisionAgentCandidate[];
}

export class DecisionRuleProvider implements RouteRuleProvider {
  readonly name = 'decision-rules';

  private readonly _resolver: DecisionProviderResolver;
  private readonly _getEventsConfig: DecisionRuleProviderDeps['getEventsConfig'];
  private readonly _getDecisionConfig: DecisionRuleProviderDeps['getDecisionConfig'];
  private readonly _getAgentCandidates: DecisionRuleProviderDeps['getAgentCandidates'];

  constructor(deps: DecisionRuleProviderDeps) {
    this._resolver = deps.resolver;
    this._getEventsConfig = deps.getEventsConfig;
    this._getDecisionConfig = deps.getDecisionConfig;
    this._getAgentCandidates = deps.getAgentCandidates;
  }

  async resolve({ event }: RouteRuleInput): Promise<RouteDecision | null> {
    // 1. Флаги: decision-маршрутизация событий (opt-in) и decision-слой.
    if (!this._getEventsConfig().decisionRouting) return null;
    const config = this._getDecisionConfig();
    if (!config || !config.enabled) return null;

    const providerName = config.provider;
    const modelName = config.model;
    if (!providerName || !modelName) return null;

    // 2. Кандидаты: без (минимум двух) enabled-агентов классифицировать нечего.
    const candidates = this._getAgentCandidates();
    if (candidates.length < MIN_ROUTING_CANDIDATES) return null;

    // 3. Единый каскад primary → escalation (AD-084); fail-safe внутри:
    //    отказ (в т.ч. нет провайдера/низкая уверенность/невалидный шаблон) → null.
    const state = buildEventState(event);
    const question = buildAgentQuestion(candidates);
    const outcome = await decideChoiceCascade({
      resolver: this._resolver,
      config,
      state,
      questions: { [DECISION_ROUTING_QUESTION_ID]: question },
      questionId: DECISION_ROUTING_QUESTION_ID,
      validate: (id) => candidates.some((c) => c.id === id),
      logLabel: 'маршрутизация события',
    });

    if (!outcome.accepted || !outcome.label) return null;

    const template = outcome.label;
    const confidence = outcome.confidence ?? 0;

    // Наблюдаемость успешного пути (AD-084 × AD-089): агент, уверенность,
    // порог, модель, тир и latency. Мета (confidence/signals) уезжает в
    // решение — далее в ответ `POST /events` и в журнал.
    info(
      'DECISION',
      `decision-маршрутизация: агент=${template} confidence=${confidence.toFixed(2)} (порог ${config.confidenceThreshold}) model=${outcome.providerName}/${outcome.modelName} tier=${outcome.tier} latency=${outcome.latencyMs}ms source=${event.source} type=${event.type}`,
    );

    const signals = [
      'decision-rules',
      `agent:${template}`,
      `model:${outcome.providerName}/${outcome.modelName}`,
      `latency:${outcome.latencyMs}ms`,
    ];
    if (outcome.tier === 'escalation') signals.push('decision_escalated');

    return decisionFromTarget(
      { mode: 'ephemeral', agentTemplate: template },
      this._getEventsConfig().defaultEphemeralTtl,
      {
        reason: 'decision-rules',
        confidence,
        signals,
      },
    );
  }
}

/**
 * Собирает компактный `state` события для decision-модели. Секреты не
 * добавляются намеренно — обфускация/guard применяются в `GatewayProvider`.
 */
function buildEventState(event: RouteRuleInput['event']): string {
  const text = eventToMessageText(event);
  const lines = [`source: ${event.source}`, `type: ${event.type}`];
  if (text) lines.push(`text: ${text}`);
  if (event.identity?.chatKey) lines.push(`chat: ${event.identity.chatKey}`);
  return lines.join('\n');
}

/** Строит `choice`-вопрос «какой шаблон агента?» по списку enabled-агентов. */
function buildAgentQuestion(candidates: DecisionAgentCandidate[]) {
  const criteria: Record<string, string | null> = {};
  for (const candidate of candidates) {
    const parts = [candidate.displayName, candidate.description].filter(
      (part): part is string => Boolean(part && part.trim()),
    );
    criteria[candidate.id] = parts.length > 0 ? parts.join(' — ') : null;
  }
  return {
    type: 'choice' as const,
    instructions:
      'Определи, какой шаблон агента лучше всего подходит для обработки этого внешнего события. Выбери ровно один id.',
    criteria,
  };
}
