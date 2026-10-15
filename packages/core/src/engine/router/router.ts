/**
 * ModelRouter — главный класс, оркеструющий стратегии роутинга (ADR-034).
 * Поддерживает стратегии: content, cost, content+cost, auto.
 */

import type { SessionSettings, ReasoningLevel } from '@itphx/synth-shared';
import type { RouterConfig } from '@itphx/synth-shared';
import type { ContentClassifier } from './content-classifier.js';
import type { DecisionContentClassifier } from './decision-content-classifier.js';
import type { ProviderPool } from './provider-pool.js';
import type { QualityChecker, QualityCheckResult } from './quality-checker.js';
import type { BaseProvider } from '../../providers/base.js';
import { warning } from '../../logger.js';

export interface RoutingRequest {
  sessionSettings: SessionSettings;
  userMessage: string;
  systemPrompt?: string;
  toolCalls?: string[];
}

export interface RoutingDecision {
  providerName: string;
  modelName: string;
  reason: string;
  strategy: string;
  /** ADR-084: категория decision-классификации (только при `strategy='decision'`). */
  category?: string;
  /** ADR-084: уверенность decision-классификации (только при `strategy='decision'`). */
  confidence?: number;
  /** ADR-084: сигналы decision-классификации, напр. `decision:coding`. */
  signals?: string[];
}

export class ModelRouter {
  private readonly _classifier: ContentClassifier;
  private readonly _pool: ProviderPool;
  private readonly _qualityChecker: QualityChecker;
  private readonly _routerConfig: RouterConfig;
  /** ADR-084: decision-классификатор категории (опционально). */
  private readonly _decisionClassifier: DecisionContentClassifier | null;

  constructor(
    classifier: ContentClassifier,
    pool: ProviderPool,
    qualityChecker: QualityChecker,
    routerConfig: RouterConfig,
    decisionClassifier?: DecisionContentClassifier,
  ) {
    this._classifier = classifier;
    this._pool = pool;
    this._qualityChecker = qualityChecker;
    this._routerConfig = routerConfig;
    this._decisionClassifier = decisionClassifier ?? null;
  }

  async route(request: RoutingRequest): Promise<RoutingDecision> {
    const { sessionSettings, userMessage, toolCalls } = request;
    const defaultProvider = sessionSettings.provider || '';
    const defaultModel = sessionSettings.model || '';

    // Если роутинг выключен — возвращаем модель сессии
    if (sessionSettings.routingEnabled === false) {
      return {
        providerName: defaultProvider,
        modelName: defaultModel,
        reason: 'Роутинг выключен (routingEnabled=false)',
        strategy: 'default',
      };
    }

    // Приоритет: keyword > модель (classify_conversation) > default
    // Сначала пробуем keyword-классификатор
    const strategy = sessionSettings.routingStrategy || this._routerConfig.strategy;

    switch (strategy) {
      case 'content':
        return this._routeByContent(sessionSettings, userMessage, toolCalls, defaultProvider, defaultModel);

      case 'cost':
        return this._routeByCost(sessionSettings, userMessage, toolCalls, defaultProvider, defaultModel);

      case 'content+cost':
        return this._routeByContentAndCost(sessionSettings, userMessage, toolCalls, defaultProvider, defaultModel);

      case 'auto':
      default:
        return this._routeByContent(sessionSettings, userMessage, toolCalls, defaultProvider, defaultModel);
    }
  }

  getProvider(
    decision: RoutingDecision,
    temperature?: number,
    reasoningLevel?: ReasoningLevel,
    maxTokens?: number,
    numCtx?: number,
  ): BaseProvider | null {
    return this._pool.getProvider(decision.providerName, decision.modelName, temperature, reasoningLevel, maxTokens, numCtx);
  }

  async checkQuality(content: string, decision: RoutingDecision, sessionSettings?: SessionSettings): Promise<QualityCheckResult> {
    // Приоритет: настройки сессии > глобальный конфиг роутера (ADR-034)
    const sessionEscalation = sessionSettings?.routingEscalation;
    const globalEscalation = this._routerConfig.escalation;
    const escalation = {
      enabled: sessionEscalation?.enabled ?? globalEscalation.enabled,
      checks: sessionEscalation?.checks ?? globalEscalation.checks,
      minLength: sessionEscalation?.minLength ?? globalEscalation.minLength,
    };
    const provider = this._pool.getProvider(decision.providerName, decision.modelName, undefined, sessionSettings?.reasoningLevel);

    return this._qualityChecker.check({
      content,
      checks: escalation.checks,
      minLength: escalation.minLength,
      provider: provider ?? undefined,
    });
  }

  getEscalationConfig() {
    return this._routerConfig.escalation;
  }

  // --- Private route methods ---

  private async _routeByContent(
    settings: SessionSettings,
    userMessage: string,
    toolCalls: string[] | undefined,
    defaultProvider: string,
    defaultModel: string,
  ): Promise<RoutingDecision> {
    const classifyResult = this._classifier.classify({
      userMessage,
      toolCalls,
    });

    // Если keyword уверен (confidence >= 0.5) — используем keyword
    if (classifyResult.confidence >= 0.5) {
      return this._routeByCategory(classifyResult.category, settings, defaultProvider, defaultModel, 'content', classifyResult.signals);
    }

    // Иначе проверяем modelCategory (из classify_conversation)
    const modelCategory = settings.routingCategory;
    if (modelCategory) {
      return this._routeByCategory(modelCategory, settings, defaultProvider, defaultModel, 'model', [`fallback_from_model:${classifyResult.category}`]);
    }

    // ADR-084: decision-классификатор включается только когда keyword неуверен
    // (confidence < 0.5) и явная `routingCategory` отсутствует — приоритеты
    // keyword и classify_conversation не меняются. Fail-safe: `null` → keyword.
    if (this._decisionClassifier) {
      const decided = await this._decisionClassifier.classify({ userMessage, toolCalls });
      if (decided) {
        const decision = this._routeByCategory(decided.category, settings, defaultProvider, defaultModel, 'decision', decided.signals);
        // ADR-084: публикуем метаданные decision-классификации для метрик (debug).
        return {
          ...decision,
          category: decided.category,
          confidence: decided.confidence,
          signals: decided.signals,
        };
      }
    }

    // Fallback: keyword-категория даже с низкой уверенностью
    return this._routeByCategory(classifyResult.category, settings, defaultProvider, defaultModel, 'content', classifyResult.signals);
  }

  /** Роутинг по явно заданной категории (из classify_conversation или keyword-классификатора). */
  private _routeByCategory(
    category: string,
    settings: SessionSettings,
    defaultProvider: string,
    defaultModel: string,
    strategy: string,
    signals?: string[],
  ): RoutingDecision {
    const sessionContent = settings.routingContent;
    const configContent = this._routerConfig.content;
    const mapping = this._resolveContentMapping(category, sessionContent, configContent);

    if (mapping && mapping.provider && mapping.model) {
      const provider = this._pool.getProvider(mapping.provider, mapping.model);
      if (provider) {
        const signalInfo = signals?.length ? ` (сигналы: ${signals.join(', ')})` : ' (модель)';
        return {
          providerName: mapping.provider,
          modelName: mapping.model,
          reason: `${strategy}: категория "${category}" → ${mapping.provider}/${mapping.model}${signalInfo}`,
          strategy,
        };
      }
      warning('ROUTER', `Провайдер/модель не найдены: ${mapping.provider}/${mapping.model}, fallback на default`);
    }

    return {
      providerName: defaultProvider,
      modelName: defaultModel,
      reason: `${strategy}: категория "${category}" — провайдер не настроен, fallback на default`,
      strategy: 'default',
    };
  }

  private _routeByCost(
    settings: SessionSettings,
    userMessage: string,
    toolCalls: string[] | undefined,
    defaultProvider: string,
    defaultModel: string,
  ): RoutingDecision {
    const cost = settings.routingCost;
    if (!cost.enabled) {
      return {
        providerName: defaultProvider,
        modelName: defaultModel,
        reason: 'Cost-based роутинг выключен в сессии',
        strategy: 'default',
      };
    }

    const complexity = this._estimateComplexity(userMessage, toolCalls);

    if (complexity === 'cheap' && cost.cheapProvider && cost.cheapModel) {
      const provider = this._pool.getProvider(cost.cheapProvider, cost.cheapModel);
      if (provider) {
        return {
          providerName: cost.cheapProvider,
          modelName: cost.cheapModel,
          reason: `Cost-based: низкая сложность → cheap ${cost.cheapProvider}/${cost.cheapModel}`,
          strategy: 'cost',
        };
      }
    }

    // Fallback: дорогая модель или default
    const targetProvider = complexity === 'expensive'
      ? (this._routerConfig.cost.expensiveProvider || defaultProvider)
      : defaultProvider;
    const targetModel = complexity === 'expensive'
      ? (this._routerConfig.cost.expensiveModel || defaultModel)
      : defaultModel;

    return {
      providerName: targetProvider || defaultProvider,
      modelName: targetModel || defaultModel,
      reason: `Cost-based: сложность "${complexity}" → ${targetProvider}/${targetModel}`,
      strategy: 'cost',
    };
  }

  private async _routeByContentAndCost(
    settings: SessionSettings,
    userMessage: string,
    toolCalls: string[] | undefined,
    defaultProvider: string,
    defaultModel: string,
  ): Promise<RoutingDecision> {
    // Сначала content-based
    const classifyResult = this._classifier.classify({ userMessage, toolCalls });
    const cost = settings.routingCost;

    // Если категория = chat и сообщение короткое и cost включён → cheap
    if (
      classifyResult.category === 'chat'
      && cost.enabled
      && cost.cheapProvider
      && cost.cheapModel
      && userMessage.length <= cost.maxCheapTokens
    ) {
      const provider = this._pool.getProvider(cost.cheapProvider, cost.cheapModel);
      if (provider) {
        return {
          providerName: cost.cheapProvider,
          modelName: cost.cheapModel,
          reason: `Content+Cost: категория "chat", короткое сообщение (${userMessage.length} символов) → cheap ${cost.cheapProvider}/${cost.cheapModel}`,
          strategy: 'content+cost',
        };
      }
    }

    // Иначе content-based
    return this._routeByContent(settings, userMessage, toolCalls, defaultProvider, defaultModel);
  }

  private _resolveContentMapping(
    category: string,
    sessionContent: SessionSettings['routingContent'],
    configContent: RouterConfig['content'],
  ): { provider: string; model: string } | null {
    // Приоритет: сессия > routerConfig.content
    // sessionContent может отсутствовать у сессий со старым/незаполненным
    // форматом настроек — обращение [category] к undefined падало с
    // «Cannot read properties of undefined (reading 'chat')».
    const sessionMapping = (sessionContent as Record<string, { provider: string; model: string } | undefined> | undefined)?.[category];
    if (sessionMapping?.provider && sessionMapping?.model) {
      return sessionMapping;
    }

    const configMapping = (configContent as Record<string, { provider: string; model: string }> | undefined)?.[category];
    if (configMapping?.provider && configMapping?.model) {
      return configMapping;
    }

    return null;
  }

  private _estimateComplexity(
    userMessage: string,
    toolCalls: string[] | undefined,
  ): 'cheap' | 'expensive' {
    const toolCount = toolCalls?.length ?? 0;
    const msgLength = userMessage.length;

    // Простые запросы: короткий текст + 0 tool calls
    if (msgLength < 50 && toolCount === 0) return 'cheap';
    // Сложные: много тулов или длинный текст
    if (toolCount >= 2 || msgLength > 200) return 'expensive';

    // Средняя сложность — по длине сообщения
    return msgLength > 100 ? 'expensive' : 'cheap';
  }
}
