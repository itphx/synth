/**
 * GatewayProvider (AD-036) — декоратор над BaseProvider.
 * Обфускация/блокировка секретов на входе, rate limit, аудит, output guard.
 * Если gateway выключен или что-то в обвязке падает — вызывает inner без изменений.
 */

import { nowISO, type LLMGatewayConfig, type LLMChunk, type LLMResponse, type TokenUsage } from '@synth/shared';

import { BaseProvider, type LLMMessage, type CancellationToken } from '../../providers/base.js';
import type { DebugCollector } from '../../debug.js';
import { warning } from '../../logger.js';
import { runInputGuard } from './input-guard.js';
import { runOutputGuard } from './output-guard.js';
import { maskSecret } from './secret-detector.js';
import type { AuditLogger } from './audit-logger.js';
import type { RateLimiter } from './rate-limiter.js';

export interface GatewayProviderOptions {
  /** Загрузка карты обфускации сессии. */
  getMap: () => Promise<Record<string, string>>;
  /** Сохранение карты обфускации сессии. */
  saveMap: (map: Record<string, string>) => Promise<void>;
  getAudit: () => AuditLogger;
  getRateLimiter: () => RateLimiter;
  sessionId: string;
  userId: string;
}

interface PreparedCall {
  messages: LLMMessage[];
  systemPrompt?: string;
  tools?: Record<string, unknown>[];
  secretsFound: string[];
  placeholders: string[];
  blocked?: { reason: string; message: string };
  rateLimited?: boolean;
}

const RATE_LIMIT_WARNING = '⚠️ Rate limit exceeded. Повторите запрос позже.';

export class GatewayProvider extends BaseProvider {
  private readonly _inner: BaseProvider;
  private readonly _config: LLMGatewayConfig;
  private readonly _opts: GatewayProviderOptions;

  constructor(inner: BaseProvider, config: LLMGatewayConfig, opts: GatewayProviderOptions) {
    super({
      url: inner.url,
      apiKey: inner.apiKey,
      model: inner.model,
      timeout: inner.timeout,
      temperature: inner.temperature,
      topP: inner.topP,
      topK: inner.topK,
      name: inner.name,
      type: inner.type,
    });
    this._inner = inner;
    this._config = config;
    this._opts = opts;
  }

  getProviderName(): string {
    return this._inner.getProviderName();
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    tools?: Record<string, unknown>[],
    stream?: boolean,
    debugCollector?: DebugCollector,
  ): Promise<LLMResponse> {
    if (!this._config.enabled) {
      return this._inner.chat(messages, systemPrompt, tools, stream, debugCollector);
    }

    let prepared: PreparedCall | null = null;
    try {
      prepared = await this._prepare(messages, systemPrompt, tools);
    } catch (e) {
      warning('GATEWAY', `Ошибка обфускации, вызов inner напрямую: ${this._errorMessage(e)}`);
    }

    if (prepared?.rateLimited) return this._rateLimitedResponse();
    if (prepared?.blocked) return this._blockedResponse(prepared.blocked.message);

    const effective = prepared ?? { messages, systemPrompt, tools, secretsFound: [], placeholders: [] };
    const response = await this._inner.chat(
      effective.messages,
      effective.systemPrompt,
      effective.tools,
      stream,
      debugCollector,
    );

    await this._auditCompletion(response.content, response.usage, effective.secretsFound, effective.placeholders);
    return response;
  }

  async *chatAsync(
    messages: LLMMessage[],
    systemPrompt?: string,
    tools?: Record<string, unknown>[],
    debugCollector?: DebugCollector,
    cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    if (!this._config.enabled) {
      yield* this._inner.chatAsync(messages, systemPrompt, tools, debugCollector, cancellationToken);
      return;
    }

    let prepared: PreparedCall | null = null;
    try {
      prepared = await this._prepare(messages, systemPrompt, tools);
    } catch (e) {
      warning('GATEWAY', `Ошибка обфускации, стрим напрямую: ${this._errorMessage(e)}`);
    }

    if (prepared?.rateLimited) {
      yield* this._yieldWarning(RATE_LIMIT_WARNING);
      return;
    }
    if (prepared?.blocked) {
      yield* this._yieldWarning(prepared.blocked.message);
      return;
    }

    const effective = prepared ?? { messages, systemPrompt, tools, secretsFound: [], placeholders: [] };
    let accumulated = '';
    let finalUsage: TokenUsage | undefined;

    for await (const chunk of this._inner.chatAsync(
      effective.messages,
      effective.systemPrompt,
      effective.tools,
      debugCollector,
      cancellationToken,
    )) {
      accumulated += chunk.content;
      if (chunk.usage) finalUsage = chunk.usage;
      yield chunk;
    }

    await this._auditCompletion(accumulated, finalUsage, effective.secretsFound, effective.placeholders);
  }

  async embed(text: string): Promise<number[]> {
    return this._inner.embed(text);
  }

  async listModels(): Promise<string[]> {
    return this._inner.listModels();
  }

  private async _prepare(
    messages: LLMMessage[],
    systemPrompt: string | undefined,
    tools: Record<string, unknown>[] | undefined,
  ): Promise<PreparedCall> {
    const originalMap = await this._opts.getMap();
    const rateLimiter = this._opts.getRateLimiter();

    if (!rateLimiter.checkUser(this._opts.userId)) {
      await this._auditRateLimited();
      return { messages, systemPrompt, tools, secretsFound: [], placeholders: [], rateLimited: true };
    }
    if (!rateLimiter.checkProvider(this.getProviderName())) {
      await this._auditRateLimited();
      return { messages, systemPrompt, tools, secretsFound: [], placeholders: [], rateLimited: true };
    }

    const guard = await runInputGuard(
      this._config,
      messages,
      systemPrompt,
      tools,
      originalMap,
      this._opts.getAudit(),
      {
        sessionId: this._opts.sessionId,
        userId: this._opts.userId,
        provider: this.getProviderName(),
        model: this.model,
      },
    );

    await this._opts.saveMap(guard.map);

    const placeholders = Object.keys(guard.map).filter((key) => !(key in originalMap));

    if (!guard.ok && guard.blocked) {
      return {
        messages,
        systemPrompt,
        tools,
        secretsFound: guard.secretsFound,
        placeholders: [],
        blocked: guard.blocked,
      };
    }

    return {
      messages: guard.messages,
      systemPrompt: guard.systemPrompt,
      tools: guard.tools,
      secretsFound: guard.secretsFound,
      placeholders,
    };
  }

  private async _auditRateLimited(): Promise<void> {
    try {
      await this._opts.getAudit().append({
        ts: nowISO(),
        type: 'rate_limited',
        sessionId: this._opts.sessionId,
        userId: this._opts.userId,
        provider: this.getProviderName(),
        model: this.model,
        reason: RATE_LIMIT_WARNING,
      });
    } catch (e) {
      warning('GATEWAY', `Ошибка аудита rate limit: ${this._errorMessage(e)}`);
    }
  }

  private async _auditCompletion(
    content: string,
    usage: TokenUsage | undefined,
    secretsFound: string[],
    placeholders: string[],
  ): Promise<void> {
    try {
      const output = runOutputGuard(content);
      if (output.found.length > 0) {
        await this._opts.getAudit().append({
          ts: nowISO(),
          type: 'output_guard',
          sessionId: this._opts.sessionId,
          userId: this._opts.userId,
          provider: this.getProviderName(),
          model: this.model,
          secretsFound: output.found.map(maskSecret),
          reason: 'секреты в ответе модели',
        });
      }

      if (secretsFound.length > 0) {
        await this._opts.getAudit().append({
          ts: nowISO(),
          type: 'obfuscated',
          sessionId: this._opts.sessionId,
          userId: this._opts.userId,
          provider: this.getProviderName(),
          model: this.model,
          secretsFound: secretsFound.map(maskSecret),
          placeholders,
          tokensIn: usage?.inputTokens,
          tokensOut: usage?.outputTokens,
        });
      }
    } catch (e) {
      warning('GATEWAY', `Ошибка аудита завершения: ${this._errorMessage(e)}`);
    }
  }

  private _zeroUsage(): TokenUsage {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  private _rateLimitedResponse(): LLMResponse {
    return { content: RATE_LIMIT_WARNING, model: this.model, usage: this._zeroUsage() };
  }

  private _blockedResponse(message: string): LLMResponse {
    return { content: message, model: this.model, usage: this._zeroUsage() };
  }

  private async *_yieldWarning(message: string): AsyncGenerator<LLMChunk> {
    yield { content: message, isFinal: false, usage: this._zeroUsage() };
    yield { content: '', isFinal: true, usage: this._zeroUsage() };
  }

  private _errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
