/**
 * ADR-095 (шаг 6a): выбор провайдера/модели и gateway-обвязка оркестратора.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегации `_getProvider`, `_getEffectiveModel`,
 * `_resolveModelContextWindow`, `_wrapWithGateway`, `_routeProvider`.
 */
import type { Message, ProviderConfig as SharedProviderConfig, Session, ReasoningLevel, LLMGatewayConfig } from '@itphx/synth-shared';
import { lookupContextWindow } from '@itphx/synth-shared';
import { ProviderFactory } from '../../providers/base.js';
import type { ProviderConfig as CoreProviderConfig, BaseProvider } from '../../providers/base.js';
import { GatewayProvider, DISABLED_GATEWAY_CONFIG } from '../gateway/index.js';
import type { ObfuscationMapStore, AuditLogger, RateLimiter } from '../gateway/index.js';
import type { SecretPatternRepository } from '../../storage/ports/secret-pattern-repository.js';
import type { MetricsRegistry } from '../../metrics/registry.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import type { ModelRouter, RoutingDecision } from '../router/router.js';
import { warning } from '../../logger.js';

/** ADR-084: безопасный дефолт gateway-конфига для decision-провайдеров. */
export function toCoreProviderConfig(shared: SharedProviderConfig, model: string, reasoningLevel?: ReasoningLevel): CoreProviderConfig {
  return {
    name: shared.name,
    type: shared.type,
    url: shared.baseUrl || '',
    apiKey: shared.apiKey || '',
    model,
    timeout: shared.timeout,
    reasoningLevel,
    numCtx: shared.numCtx,
  };
}

/**
 * Размер контекстного окна модели: приоритет у сохранённого значения
 * (ModelConfig.contextWindow через оптимизатор), иначе справочник.
 */
export function resolveModelContextWindow(modelName: string, optimizer: ContextOptimizer | null): number {
  const window = optimizer?.getContextWindow(modelName);
  if (window && window > 0) return window;
  return lookupContextWindow(modelName).window;
}

/** Эффективная модель сессии/провайдера (fallback-цепочка). */
export function getEffectiveModel(
  session: Session,
  providerName: string,
  providerLoader: (name: string) => SharedProviderConfig | null,
): string {
  return session.settings.model || providerLoader(providerName)?.defaultModel || '';
}

/** Зависимости gateway-обвязки провайдера (ADR-036). */
export interface GatewayWrapDeps {
  gatewayConfig: LLMGatewayConfig | null;
  gatewayPatternStore: SecretPatternRepository | null;
  obfMapStore: ObfuscationMapStore | null;
  gatewayAudit: AuditLogger | null;
  gatewayRateLimiter: RateLimiter | null;
  gatewayPayloadLogPath: string | undefined;
  /** ADR-094: реестр метрик — обёртка ставится и при выключенном gateway. */
  metrics?: MetricsRegistry;
}

/**
 * ADR-036: оборачивает провайдер в GatewayProvider с привязкой к сессии.
 * Если gateway выключен — возвращает провайдер как есть (обратная совместимость),
 * но при заданном реестре метрик обёртка остаётся (только учёт вызовов, ADR-094).
 */
export function wrapWithGateway(provider: BaseProvider, session: Session, deps: GatewayWrapDeps): BaseProvider {
  if (!deps.gatewayConfig && !deps.metrics) return provider;
  const patternStore = deps.gatewayPatternStore;
  return new GatewayProvider(provider, deps.gatewayConfig ?? DISABLED_GATEWAY_CONFIG, {
    getMap: () => deps.obfMapStore!.get(session.id),
    saveMap: (map) => deps.obfMapStore!.set(session.id, map),
    getAudit: () => deps.gatewayAudit!,
    getRateLimiter: () => deps.gatewayRateLimiter!,
    getPatterns: patternStore ? () => patternStore.getPatterns() : undefined,
    payloadLogPath: deps.gatewayPayloadLogPath,
    sessionId: session.id,
    userId: session.userId ?? '',
    metrics: deps.metrics,
  });
}

/** Зависимости создания провайдера сессии. */
export interface GetProviderDeps {
  providerLoader: (name: string) => SharedProviderConfig | null;
  optimizer: ContextOptimizer | null;
  gateway: GatewayWrapDeps;
}

/** Создаёт провайдера для сессии (без роутера) или `null` при ошибке/отсутствии. */
export function getProvider(
  providerName: string,
  session: Session,
  reasoningLevel: ReasoningLevel | undefined,
  deps: GetProviderDeps,
): BaseProvider | null {
  const modelName = session.settings.model || '';
  const sharedConfig = deps.providerLoader(providerName);
  if (!sharedConfig) return null;

  try {
    const effectiveModel = modelName || sharedConfig.defaultModel || '';
    const contextWindow = resolveModelContextWindow(effectiveModel, deps.optimizer);
    const provider = ProviderFactory.create(
      providerName,
      {
        ...toCoreProviderConfig(sharedConfig, effectiveModel, reasoningLevel ?? session.settings.reasoningLevel),
        maxTokens: session.settings.maxTokens,
        // Приоритет: явный provider.numCtx > ModelConfig.contextWindow.
        numCtx: sharedConfig.numCtx ?? (contextWindow > 0 ? contextWindow : undefined),
      },
      session.settings.temperature,
    );
    return wrapWithGateway(provider, session, deps.gateway);
  } catch (e) {
    warning('ORCHESTRATOR', `Failed to create provider ${providerName}: ${e}`);
    return null;
  }
}

/** Зависимости выбора провайдера/модели через роутер (ADR-034). */
export interface RouteProviderDeps extends GetProviderDeps {
  router: ModelRouter | null;
}

/**
 * Выбор провайдера и модели через роутер (ADR-034).
 * Если роутер недоступен — fallback на getProvider().
 */
export async function routeProvider(
  session: Session,
  message: Message,
  reasoningLevel: ReasoningLevel | undefined,
  debugCollector: import('../../debug.js').DebugCollector | undefined,
  deps: RouteProviderDeps,
): Promise<{ provider: BaseProvider; providerName: string; modelName: string; decision?: RoutingDecision } | null> {
  if (deps.router && session.settings.routingEnabled !== false) {
    const toolCallNames = message.toolCalls?.map((tc) => {
      const func = tc.function as { name: string } | undefined;
      return func?.name || '';
    }).filter(Boolean);

    const decision = await deps.router.route({
      sessionSettings: session.settings,
      userMessage: message.content,
      toolCalls: toolCallNames,
    });

    // ADR-084: метрики decision-классификации категории (ADR-034). Сигнал
    // публикуется только когда категорию определила decision-модель
    // (`strategy='decision'`), а не словарный классификатор.
    if (debugCollector && decision.strategy === 'decision') {
      debugCollector.addContext('decision_routing', {
        category: decision.category,
        confidence: decision.confidence,
        signals: decision.signals,
      });
    }

    const routedWindow = resolveModelContextWindow(decision.modelName, deps.optimizer);
    let provider = deps.router.getProvider(
      decision,
      undefined,
      reasoningLevel ?? session.settings.reasoningLevel,
      session.settings.maxTokens,
      routedWindow > 0 ? routedWindow : undefined,
    );
    if (provider) {
      // ADR-036: ProviderPool уже оборачивает провайдера через gatewayFactory.
      // Повторная обёртка дублировала бы guard/аудит/rate-limit — пропускаем.
      if (!(provider instanceof GatewayProvider)) {
        provider = wrapWithGateway(provider, session, deps.gateway);
      }
      return {
        provider,
        providerName: decision.providerName,
        modelName: decision.modelName,
        decision,
      };
    }

    // Fallback: если decision не содержит валидного провайдера/модели
    // (например, категория не имеет маппинга в routingContent),
    // используем стандартный getProvider() для провайдера сессии
    const fallbackName = session.settings.provider || '';
    provider = getProvider(fallbackName, session, reasoningLevel, deps);
    if (provider) {
      return {
        provider,
        providerName: fallbackName,
        modelName: getEffectiveModel(session, fallbackName, deps.providerLoader),
        decision,
      };
    }
  }

  // Fallback: старый метод (если роутер недоступен или все пути выше не сработали)
  const providerName = (message.provider as string) || session.settings.provider || '';
  const provider = getProvider(providerName, session, reasoningLevel, deps);
  if (!provider) return null;

  return {
    provider,
    providerName,
    modelName: provider.model,
  };
}
