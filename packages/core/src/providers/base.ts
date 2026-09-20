import type { TokenUsage, LLMChunk, LLMResponse, ReasoningLevel } from '@itphx/synth-shared';
import type { DebugCollector } from '../debug.js';

export interface LLMMessage {
  id: string;
  role: string;
  content: string;
  usage: TokenUsage;
  debug?: Record<string, unknown>;
  model?: string;
  summaryOf?: number[];
  disabled: boolean;
  pinned: boolean;
  branchId: string;
  source?: string;
  status?: Record<string, unknown>;
  toolCallId?: string;
  toolUse?: Record<string, unknown>[];
  reasoning?: string;
  groupId?: string;
  agentRole?: string;
}

export interface CancellationToken {
  cancelled: boolean;
  cancel: () => void;
}

export interface ProviderConfig {
  type?: string;
  name?: string;
  url: string;
  apiKey: string;
  model: string;
  timeout?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  reasoningLevel?: ReasoningLevel;
  /** Лимит выходных токенов (max_tokens у OpenAI/Anthropic). */
  maxTokens?: number;
  /** Размер контекста модели (num_ctx у Ollama). */
  numCtx?: number;
}

/**
 * AD-070 §2.2: политика prompt-cache. `auto` — ставить маркеры кэша,
 * `none` — полностью отключить (для отладки/сравнений).
 */
export type CachePolicy = 'auto' | 'none';

/**
 * AD-070 §2.2: system prompt как payload для управления prompt-cache.
 * Провайдеры принимают как строку (обратная совместимость, в т.ч. саб-агенты),
 * так и этот объект.
 */
export interface SystemPromptPayload {
  /** Полный текст системного промпта. */
  text: string;
  /** Кэшируемый префикс (если задан — граница stable-префикса). */
  stablePrefix?: string;
  /** Ключ кэша (OpenAI prompt_cache_key) — стабильный id сессии. */
  cacheKey?: string;
  /** Политика кэша: auto (по умолчанию) | none. */
  cachePolicy?: CachePolicy;
  /**
   * AD-071 §2.1: число встроенных инструментов в начале `tools`-массива
   * (граница stable-слоя). Кэш-брейкпоинт ставится на последний встроенный
   * инструмент; MCP-инструменты после границы не кэшируются. Если не задан —
   * провайдер сохраняет прежнее поведение (брейкпоинт на последний инструмент).
   */
  stableToolCount?: number;
}

export type SystemPromptInput = string | SystemPromptPayload;

/**
 * Возвращает текст системного промпта из строки или payload'а.
 * `undefined`, если input не задан или текст пуст.
 */
export function resolveSystemPromptText(input: SystemPromptInput | undefined): string | undefined {
  if (input === undefined) return undefined;
  const text = typeof input === 'string' ? input : input.text;
  return text || undefined;
}

export abstract class BaseProvider {
  url: string;
  apiKey: string;
  model: string;
  timeout: number;
  temperature: number;
  topP?: number;
  topK?: number;
  name: string;
  type: string;
  reasoningLevel: ReasoningLevel;
  maxTokens?: number;
  numCtx?: number;

  constructor(params: {
    url: string;
    apiKey: string;
    model: string;
    timeout?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    name?: string;
    type?: string;
    reasoningLevel?: ReasoningLevel;
    maxTokens?: number;
    numCtx?: number;
  }) {
    this.url = params.url;
    this.apiKey = params.apiKey;
    this.model = params.model;
    this.timeout = params.timeout ?? 120;
    this.temperature = params.temperature ?? 0.7;
    this.topP = params.topP;
    this.topK = params.topK;
    this.name = params.name ?? 'unknown';
    this.type = params.type ?? 'generic';
    this.reasoningLevel = params.reasoningLevel ?? 'default';
    this.maxTokens = params.maxTokens;
    this.numCtx = params.numCtx;
  }

  abstract chat(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    stream?: boolean,
    debugCollector?: DebugCollector,
  ): Promise<LLMResponse>;

  abstract chatAsync(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    debugCollector?: DebugCollector,
    cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk>;

  abstract getProviderName(): string;

  async embed(_text: string): Promise<number[]> {
    throw new Error('Not implemented');
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  /**
   * Список моделей с известным контекстным окном (если провайдер его отдаёт).
   * Базовая реализация не знает окон — возвращает только идентификаторы.
   */
  async listModelsDetailed(): Promise<Array<{ id: string; contextWindow?: number }>> {
    const ids = await this.listModels();
    return ids.map((id) => ({ id }));
  }
}

export class ProviderFactory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static _providers = new Map<string, new (params: any) => BaseProvider>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static register(name: string, providerClass: new (params: any) => BaseProvider): void {
    this._providers.set(name.toLowerCase(), providerClass);
  }

  static create(
    name: string,
    config: ProviderConfig,
    temperature?: number,
    topP?: number,
    topK?: number,
  ): BaseProvider {
    let providerType = (config.type || name).toLowerCase();
    const url = config.url || '';
    const apiKey = config.apiKey || '';
    const model = config.model || '';
    const timeout = config.timeout ?? 120;

    if (!this._providers.has(providerType)) {
      providerType = this._detectProviderType(url, providerType);
    }

    if (!this._providers.has(providerType)) {
      throw new Error(`Неизвестный тип провайдера: ${providerType}`);
    }

    const ProviderClass = this._providers.get(providerType)!;
    const normalizedUrl = this._normalizeUrl(url, providerType);

    return new ProviderClass({
      url: normalizedUrl,
      apiKey,
      model,
      timeout,
      temperature: temperature ?? 0.7,
      topP,
      topK,
      name: config.name || name,
      type: providerType,
      reasoningLevel: config.reasoningLevel,
      maxTokens: config.maxTokens,
      numCtx: config.numCtx,
    });
  }

  static getRegistered(): string[] {
    return [...this._providers.keys()];
  }

  static _detectProviderType(url: string, providerType: string): string {
    const lower = url.toLowerCase();

    if (!providerType || providerType === 'generic') {
      if (lower.includes('anthropic.com') || lower.includes('minimaxi.com')) return 'anthropic';
      if (lower.includes('ollama.com') || lower.includes(':11434')) return 'ollama';
      if (lower.includes('openai.com') || lower.includes('azure.com')) return 'openai';
      return 'generic';
    }

    return providerType;
  }

  static _normalizeUrl(url: string, providerType: string): string {
    const trimmed = url.replace(/\/+$/, '');

    if (providerType === 'ollama' && !trimmed.endsWith('/api/chat')) {
      return `${trimmed}/api/chat`;
    }
    if (providerType === 'anthropic' && !trimmed.endsWith('/v1/messages')) {
      return `${trimmed}/v1/messages`;
    }
    if ((providerType === 'openai' || providerType === 'generic') && !trimmed.includes('/chat/completions')) {
      if (trimmed.includes('/v1')) return `${trimmed}/chat/completions`;
      return `${trimmed}/v1/chat/completions`;
    }

    return trimmed;
  }
}
