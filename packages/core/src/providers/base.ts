import type { TokenUsage, LLMChunk, LLMResponse } from '@synth/shared';
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
  }

  abstract chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    tools?: Record<string, unknown>[],
    stream?: boolean,
    debugCollector?: DebugCollector,
  ): Promise<LLMResponse>;

  abstract chatAsync(
    messages: LLMMessage[],
    systemPrompt?: string,
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
