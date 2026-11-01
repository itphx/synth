/**
 * ADR-095 (шаг 6a): выбор провайдера/модели и gateway-обвязка оркестратора.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегации `_getProvider`, `_getEffectiveModel`,
 * `_resolveModelContextWindow`, `_wrapWithGateway`, `_routeProvider`.
 */
import type { Message, ProviderConfig as SharedProviderConfig, Session, ReasoningLevel, LLMGatewayConfig, ModelCompatibility } from '@itphx/synth-shared';
import { lookupContextWindow, mergeModelCompatibility } from '@itphx/synth-shared';
import { ProviderFactory, resolveProviderCompatibility } from '../../providers/base.js';
import type { ProviderConfig as CoreProviderConfig, BaseProvider } from '../../providers/base.js';
import { GatewayProvider, DISABLED_GATEWAY_CONFIG } from '../gateway/index.js';
import type { ObfuscationMapStore, AuditLogger, RateLimiter, LlmFilterRegistry } from '../gateway/index.js';
import type { SecretPatternRepository } from '../../storage/ports/secret-pattern-repository.js';
import type { MetricsRegistry } from '../../metrics/registry.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import type { ModelRouter, RoutingDecision } from '../router/router.js';
import { warning } from '../../logger.js';
import { resolveMaxOutputTokens } from './max-output.js';

/**
 * Конфиг инстанса → конфиг ядра (ADR-084).
 *
 * `compatibility`: `provider.compatibility` (JSON провайдера) + модель
 * (резолвер по каталогу), модель перекрывает провайдера; недостающее —
 * эвристика в провайдере.
 */
export function toCoreProviderConfig(
  shared: SharedProviderConfig,
  model: string,
  reasoningLevel?: ReasoningLevel,
  compatibility?: ModelCompatibility,
): CoreProviderConfig {
  const merged = mergeModelCompatibility(shared.compatibility, compatibility);
  return {
    name: shared.name,
    type: shared.type,
    url: shared.baseUrl || '',
    apiKey: shared.apiKey || '',
    model,
    timeout: shared.timeout,
    reasoningLevel,
    ...(Object.keys(merged).length > 0 ? { compatibility: merged } : {}),
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
  /**
   * ADR-090: реестр фильтров LLM-вызовов. Не задан/пуст —
   * прежнее поведение (фильтры не выполняются).
   */
  filters?: LlmFilterRegistry;
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
    filters: deps.filters,
  });
}

/**
 * Переопределения выборки провайдера/модели и сэмплинга от агента
 * (`AgentDefinition.provider`/`model`/`temperature`/`topP`/`topK`).
 *
 * Приоритет полей (`provider`/`model`): агент → сообщение → настройка сессии.
 * У `topP`/`topK` значение `0` означает «не задано» (как и `undefined`):
 * фильтрует вызывающий, в провайдер уходят только положительные значения.
 */
export interface ProviderOverrides {
  provider?: string;
  model?: string;
  /** Температура агента (undefined — `session.settings.temperature`, затем дефолт модели). */
  temperature?: number;
  topP?: number;
  topK?: number;
}

/** Зависимости создания провайдера сессии. */
export interface GetProviderDeps {
  providerLoader: (name: string) => SharedProviderConfig | null;
  optimizer: ContextOptimizer | null;
  gateway: GatewayWrapDeps;
  /**
   * Совместимость из каталога: слияние `provider.compatibility` (JSON
   * провайдера) и `model.compatibility` (каталог моделей, включая shorthand
   * `requiresReasoning`). `undefined` — явных значений нет, работают
   * эвристики провайдера.
   */
  resolveModelCompatibility?: (providerName: string, modelName: string) => ModelCompatibility | undefined;
  /**
   * Лимит вывода модели из каталога (`ModelConfig.maxOutputTokens`).
   * `undefined`/`0` — лимит неизвестен: резолв идёт по сессии/конфигу.
   */
  resolveModelMaxOutputTokens?: (providerName: string, modelName: string) => number | undefined;
  /** `llm.maxTokens` — лимит вывода по умолчанию (`0`/`undefined` — дефолт ядра). */
  defaultMaxOutputTokens?: number;
}

/**
 * Лимит вывода вызова: сессия → каталог (он же кап) → конфиг → дефолт, плюс
 * пол для моделей с обязательным reasoning (adaptive thinking в том же
 * `max_tokens` иначе съедает ответ).
 */
function callMaxOutputTokens(
  session: Session,
  providerName: string,
  modelName: string,
  deps: GetProviderDeps,
  sharedConfig?: SharedProviderConfig | null,
  resolvedCompatibility?: ModelCompatibility,
): number {
  const compatibility = resolvedCompatibility
    ?? deps.resolveModelCompatibility?.(providerName, modelName);
  return resolveMaxOutputTokens({
    sessionMax: session.settings.maxTokens,
    modelMax: deps.resolveModelMaxOutputTokens?.(providerName, modelName),
    configMax: deps.defaultMaxOutputTokens,
    requireReasoning: resolveProviderCompatibility({
      type: sharedConfig?.type,
      name: providerName,
      url: sharedConfig?.baseUrl,
      model: modelName,
      compatibility,
    }).requireReasoning,
  });
}

/** Создаёт провайдера для сессии (без роутера) или `null` при ошибке/отсутствии. */
export function getProvider(
  providerName: string,
  session: Session,
  reasoningLevel: ReasoningLevel | undefined,
  deps: GetProviderDeps,
  overrides: ProviderOverrides = {},
): BaseProvider | null {
  // Модель: агент → настройка сессии → defaultModel провайдера (ниже).
  const modelName = overrides.model || session.settings.model || '';
  const sharedConfig = deps.providerLoader(providerName);
  if (!sharedConfig) return null;

  try {
    const effectiveModel = modelName || sharedConfig.defaultModel || '';
    const contextWindow = resolveModelContextWindow(effectiveModel, deps.optimizer);
    const compatibility = deps.resolveModelCompatibility?.(providerName, effectiveModel);
    const provider = ProviderFactory.create(
      providerName,
      {
        ...toCoreProviderConfig(
          sharedConfig,
          effectiveModel,
          reasoningLevel ?? session.settings.reasoningLevel,
          compatibility,
        ),
        maxTokens: callMaxOutputTokens(session, providerName, effectiveModel, deps, sharedConfig, compatibility),
        // Приоритет: явный provider.numCtx > ModelConfig.contextWindow.
        numCtx: sharedConfig.numCtx ?? (contextWindow > 0 ? contextWindow : undefined),
      },
      // Температура: агент → настройка сессии → дефолт модели (undefined не отправляем).
      overrides.temperature ?? session.settings.temperature,
      // top-p/top-k: только от агента (провайдерский дефолт — не задаём поле).
      overrides.topP,
      overrides.topK,
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
 *
 * `overrides` — явный выбор агента (`AgentDefinition.provider`/`model`) и его
 * сэмплинг (`temperature`/`topP`/`topK`). Задан `provider` или `model` — роутер
 * не вызывается вовсе (агент перекрывает эвристики), недостающее поле берётся
 * из сообщения/сессии. Иначе — прежний путь через роутер; `topP`/`topK`
 * прокидываются в пул провайдеров (у роутера модель своя, сэмплинг — агента).
 */
export async function routeProvider(
  session: Session,
  message: Message,
  reasoningLevel: ReasoningLevel | undefined,
  debugCollector: import('../../debug.js').DebugCollector | undefined,
  deps: RouteProviderDeps,
  overrides: ProviderOverrides = {},
): Promise<{ provider: BaseProvider; providerName: string; modelName: string; decision?: RoutingDecision } | null> {
  // Приоритет: агент → сессия → дефолт модели (undefined — не отправляем поле).
  const effectiveTemperature = overrides.temperature ?? session.settings.temperature;

  // Агент задал провайдера и/или модель — явный выбор важнее эвристик роутера
  // (роутер подбирал бы категорию по тексту сообщения и перебил бы агента).
  // Недостающее поле берётся из сообщения/сессии: агент мог задать только одно.
  if (overrides.provider || overrides.model) {
    const providerName = overrides.provider || (message.provider as string) || session.settings.provider || '';
    const modelName = overrides.model || (message.model as string) || session.settings.model;
    const provider = getProvider(providerName, session, reasoningLevel, deps, {
      ...overrides,
      provider: providerName,
      ...(modelName ? { model: modelName } : {}),
    });
    if (!provider) return null;
    return { provider, providerName, modelName: provider.model };
  }

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
      effectiveTemperature,
      reasoningLevel ?? session.settings.reasoningLevel,
      callMaxOutputTokens(
        session, decision.providerName, decision.modelName, deps,
        deps.providerLoader(decision.providerName),
      ),
      routedWindow > 0 ? routedWindow : undefined,
      // top-p/top-k агента: модель выбрал роутер, сэмплинг — агента.
      overrides.topP,
      overrides.topK,
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
    provider = getProvider(fallbackName, session, reasoningLevel, deps, overrides);
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
  const provider = getProvider(providerName, session, reasoningLevel, deps, overrides);
  if (!provider) return null;

  return {
    provider,
    providerName,
    modelName: provider.model,
  };
}
