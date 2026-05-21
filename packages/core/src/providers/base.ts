import type { LLMChunk, LLMResponse } from '@synth/shared';

export interface LLMMessage {
  id: string;
  role: string;
  content: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
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

export interface ProviderParams {
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
  abstract name: string;
  abstract type: string;

  constructor(params: ProviderParams) {
    this.url = params.url;
    this.apiKey = params.apiKey;
    this.model = params.model;
    this.timeout = params.timeout ?? 120;
    this.temperature = params.temperature ?? 0.7;
    this.topP = params.topP;
    this.topK = params.topK;
  }

  abstract chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    tools?: Record<string, unknown>[],
    stream?: boolean,
    debugCollector?: (data: Record<string, unknown>) => void,
  ): Promise<LLMResponse>;

  abstract chatAsync(
    messages: LLMMessage[],
    systemPrompt?: string,
    tools?: Record<string, unknown>[],
    debugCollector?: (data: Record<string, unknown>) => void,
    cancellationToken?: { cancelled: boolean },
  ): AsyncGenerator<LLMChunk>;

  abstract getProviderName(): string;

  async embed(_text: string): Promise<number[]> {
    throw new Error('Not implemented');
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}

/**
 * ProviderFactory — регистрирует и создаёт провайдеров.
 */
export class ProviderFactory {
  private static _providers = new Map<string, new (params: ProviderParams) => BaseProvider>();

  static register(name: string, providerClass: new (params: ProviderParams) => BaseProvider): void {
    this._providers.set(name, providerClass);
  }

  static create(
    name: string,
    params: ProviderParams,
    temperature?: number,
    topP?: number,
    topK?: number,
  ): BaseProvider {
    const ProviderClass = this._providers.get(name);
    if (!ProviderClass) {
      throw new Error(`Unknown provider: ${name}`);
    }
    const merged = { ...params };
    if (temperature !== undefined) merged.temperature = temperature;
    if (topP !== undefined) merged.topP = topP;
    if (topK !== undefined) merged.topK = topK;
    return new ProviderClass(merged);
  }

  static getRegistered(): string[] {
    return [...this._providers.keys()];
  }

  static detectProviderType(url: string): string {
    const lower = url.toLowerCase();
    if (lower.includes('openai.com')) return 'openai';
    if (lower.includes('anthropic.com')) return 'anthropic';
    if (lower.includes('api/chat') || lower.includes(':11434')) return 'ollama';
    return 'generic';
  }

  static normalizeUrl(url: string, type: string): string {
    if (type === 'openai' && !url.endsWith('/v1/chat/completions')) {
      return url.replace(/\/?$/, '/v1/chat/completions');
    }
    return url;
  }
}
