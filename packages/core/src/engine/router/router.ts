/**
 * ModelRouter — главный класс, оркеструющий стратегии роутинга (AD-034).
 * Поддерживает стратегии: content, cost, content+cost, auto.
 */

import type { SessionSettings } from '@synth/shared';
import type { RouterConfig } from '@synth/shared';
import type { ContentClassifier } from './content-classifier.js';
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
}

export class ModelRouter {
  private readonly _classifier: ContentClassifier;
  private readonly _pool: ProviderPool;
  private readonly _qualityChecker: QualityChecker;
  private readonly _routerConfig: RouterConfig;

  constructor(
    classifier: ContentClassifier,
    pool: ProviderPool,
    qualityChecker: QualityChecker,
    routerConfig: RouterConfig,
  ) {
    this._classifier = classifier;
    this._pool = pool;
    this._qualityChecker = qualityChecker;
    this._routerConfig = routerConfig;
  }

  route(request: RoutingRequest): RoutingDecision {
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

  getProvider(decision: RoutingDecision, temperature?: number): BaseProvider | null {
    return this._pool.getProvider(decision.providerName, decision.modelName, temperature);
  }

  async checkQuality(content: string, decision: RoutingDecision): Promise<QualityCheckResult> {
    const escalation = this._routerConfig.escalation;
    const provider = this._pool.getProvider(decision.providerName, decision.modelName);

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

  private _routeByContent(
    settings: SessionSettings,
    userMessage: string,
    toolCalls: string[] | undefined,
    defaultProvider: string,
    defaultModel: string,
  ): RoutingDecision {
    const classifyResult = this._classifier.classify({
      userMessage,
      toolCalls,
    });
    const category = classifyResult.category;

    // Ищем mapping в сессии, если пусто — из routerConfig
    const sessionContent = settings.routingContent;
    const configContent = this._routerConfig.content;

    const mapping = this._resolveContentMapping(category, sessionContent, configContent);

    if (mapping && mapping.provider && mapping.model) {
      // Проверяем доступность в пуле
      const provider = this._pool.getProvider(mapping.provider, mapping.model);
      if (provider) {
        return {
          providerName: mapping.provider,
          modelName: mapping.model,
          reason: `Content-based: категория "${category}" → ${mapping.provider}/${mapping.model} (сигналы: ${classifyResult.signals.join(', ')})`,
          strategy: 'content',
        };
      }
      warning('ROUTER', `Провайдер/модель из routing content не найдены в пуле: ${mapping.provider}/${mapping.model}, fallback на default`);
    }

    // Fallback на default модели сессии
    return {
      providerName: defaultProvider,
      modelName: defaultModel,
      reason: `Content-based: категория "${category}" — провайдер не настроен, fallback на default`,
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

  private _routeByContentAndCost(
    settings: SessionSettings,
    userMessage: string,
    toolCalls: string[] | undefined,
    defaultProvider: string,
    defaultModel: string,
  ): RoutingDecision {
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
    const sessionMapping = (sessionContent as Record<string, { provider: string; model: string } | undefined>)[category];
    if (sessionMapping?.provider && sessionMapping?.model) {
      return sessionMapping;
    }

    const configMapping = (configContent as Record<string, { provider: string; model: string }>)[category];
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
