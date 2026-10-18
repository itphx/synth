/**
 * GatewayProvider (ADR-036) — декоратор над BaseProvider.
 * Обфускация/блокировка секретов на входе, rate limit, аудит, output guard.
 * Если gateway выключен или что-то в обвязке падает — вызывает inner без изменений.
 */

import { nowISO, type LLMGatewayConfig, type LLMChunk, type LLMResponse, type TokenUsage, type DecisionQuestion, type DecisionResponse } from '@itphx/synth-shared';

import { BaseProvider, type DetailedModelInfo, type LLMMessage, type SystemPromptInput, type CancellationToken } from '../../providers/base.js';
import { ProviderError, RateLimitError } from '../../providers/exceptions.js';
import type { DebugCollector } from '../../debug.js';
import { warning } from '../../logger.js';
import { t as sm } from '../system-messages.js';
import { runInputGuard } from './input-guard.js';
import { runOutputGuard } from './output-guard.js';
import { maskSecret } from './secret-detector.js';
import { writePayloadLog } from './payload-logger.js';
import type { AuditLogger } from './audit-logger.js';
import type { RateLimiter } from './rate-limiter.js';
import type { SecretPattern } from './secret-pattern-store.js';
import type { MetricsRegistry } from '../../metrics/registry.js';
import {
  createLlmCallRecorder,
  type LlmCallInfo,
  type LlmCallOutcome,
} from '../../metrics/collectors/llm.js';

/**
 * ADR-094: безопасный дефолт gateway-конфига, когда LLM Gateway выключен —
 * обёртка нужна только для метрик (`enabled: false` = прямой вызов inner).
 */
export const DISABLED_GATEWAY_CONFIG: LLMGatewayConfig = {
  enabled: false,
  inputMode: 'obfuscate',
  logPayloads: false,
  payloadLogPath: '',
  rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
  audit: { enabled: true, logPath: '' },
};

export interface GatewayProviderOptions {
  /** Загрузка карты обфускации сессии. */
  getMap: () => Promise<Record<string, string>>;
  /** Сохранение карты обфускации сессии. */
  saveMap: (map: Record<string, string>) => Promise<void>;
  getAudit: () => AuditLogger;
  getRateLimiter: () => RateLimiter;
  /** Актуальный список паттернов детекции (override ?? дефолт). Если не задан — дефолт детектора. */
  getPatterns?: () => SecretPattern[];
  /** Путь к JSONL полного лога запросов/ответов. Если не задан или logPayloads=false — лог не пишется. */
  payloadLogPath?: string;
  sessionId: string;
  userId: string;
  /**
   * ADR-094: колбэк на каждый LLM-вызов (ok/error/cancelled/rate_limited/
   * blocked + длительность/usage). Ошибка колбэка не влияет на вызов.
   */
  onCall?: (info: LlmCallInfo) => void;
  /**
   * ADR-094: реестр метрик — если `onCall` не задан, колбэк создаётся из него
   * (`synth_llm_requests_total`/`..._duration_seconds`/`..._tokens_total`).
   */
  metrics?: MetricsRegistry;
}

interface PreparedCall {
  messages: LLMMessage[];
  systemPrompt?: SystemPromptInput;
  tools?: Record<string, unknown>[];
  secretsFound: string[];
  placeholders: string[];
  blocked?: { reason: string; message: string };
  rateLimited?: boolean;
  patterns?: SecretPattern[];
}

const RATE_LIMIT_WARNING = sm('gateway.rate_limit_warning');

export class GatewayProvider extends BaseProvider {
  private readonly _inner: BaseProvider;
  private readonly _config: LLMGatewayConfig;
  private readonly _opts: GatewayProviderOptions;
  private readonly _onCall?: (info: LlmCallInfo) => void;

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
      reasoningLevel: inner.reasoningLevel,
    });
    this._inner = inner;
    this._config = config;
    this._opts = opts;
    this._onCall = opts.onCall ?? (opts.metrics ? createLlmCallRecorder(opts.metrics) : undefined);
  }

  /** ADR-094: best-effort отчёт о вызове — метрики не должны ломать LLM-поток. */
  private _reportCall(
    outcome: LlmCallOutcome,
    startedAt: number,
    usage?: TokenUsage,
  ): void {
    if (!this._onCall) return;
    try {
      this._onCall({
        provider: this.getProviderName(),
        model: this.model,
        outcome,
        durationMs: performance.now() - startedAt,
        ...(usage ? { usage } : {}),
      });
    } catch {
      // ignore
    }
  }

  getProviderName(): string {
    return this._inner.getProviderName();
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    stream?: boolean,
    debugCollector?: DebugCollector,
  ): Promise<LLMResponse> {
    const startedAt = performance.now();
    let outcome: LlmCallOutcome = 'ok';
    let usage: TokenUsage | undefined;

    try {
      if (!this._config.enabled) {
        const response = await this._inner.chat(messages, systemPrompt, tools, stream, debugCollector);
        usage = response.usage;
        return response;
      }

      let prepared: PreparedCall | null = null;
      try {
        prepared = await this._prepare(messages, systemPrompt, tools);
      } catch (e) {
        warning('GATEWAY', `Ошибка обфускации, вызов inner напрямую: ${this._errorMessage(e)}`);
      }

      if (prepared?.rateLimited) {
        outcome = 'rate_limited';
        return this._rateLimitedResponse();
      }
      if (prepared?.blocked) {
        outcome = 'blocked';
        return this._blockedResponse(prepared.blocked.message);
      }

      const effective = prepared ?? { messages, systemPrompt, tools, secretsFound: [], placeholders: [] };
      const response = await this._inner.chat(
        effective.messages,
        effective.systemPrompt,
        effective.tools,
        stream,
        debugCollector,
      );
      usage = response.usage;

      await this._auditCompletion(
        response.content,
        response.usage,
        effective.secretsFound,
        effective.placeholders,
        effective.patterns,
      );
      await this._logPayload(effective.messages, effective.systemPrompt, response.content, response.usage);
      return response;
    } catch (e) {
      outcome = 'error';
      throw e;
    } finally {
      this._reportCall(outcome, startedAt, usage);
    }
  }

  async *chatAsync(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    debugCollector?: DebugCollector,
    cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    const startedAt = performance.now();
    let outcome: LlmCallOutcome = 'ok';
    let usage: TokenUsage | undefined;

    try {
      if (!this._config.enabled) {
        for await (const chunk of this._inner.chatAsync(
          messages,
          systemPrompt,
          tools,
          debugCollector,
          cancellationToken,
        )) {
          if (chunk.usage) usage = chunk.usage;
          yield chunk;
        }
        return;
      }

      let prepared: PreparedCall | null = null;
      try {
        prepared = await this._prepare(messages, systemPrompt, tools);
      } catch (e) {
        warning('GATEWAY', `Ошибка обфускации, стрим напрямую: ${this._errorMessage(e)}`);
      }

      if (prepared?.rateLimited) {
        outcome = 'rate_limited';
        yield* this._yieldWarning(RATE_LIMIT_WARNING);
        return;
      }
      if (prepared?.blocked) {
        outcome = 'blocked';
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
        // Финальный чанк несёт полный накопленный контент — заменяем, а не складываем
        // (иначе контент удваивается: delta-чанки + финальный полный).
        accumulated = chunk.isFinal && chunk.content ? chunk.content : accumulated + chunk.content;
        if (chunk.usage) finalUsage = chunk.usage;
        yield chunk;
      }
      usage = finalUsage;

      await this._auditCompletion(
        accumulated,
        finalUsage,
        effective.secretsFound,
        effective.placeholders,
        effective.patterns,
      );
      await this._logPayload(effective.messages, effective.systemPrompt, accumulated, finalUsage);
    } catch (e) {
      outcome = 'error';
      throw e;
    } finally {
      if (outcome === 'ok' && cancellationToken?.cancelled) outcome = 'cancelled';
      this._reportCall(outcome, startedAt, usage);
    }
  }

  async embed(text: string): Promise<number[]> {
    return this._inner.embed(text);
  }

  /**
   * ADR-084: decision-запрос через gateway-обвязку. В отличие от `chat`/`chatAsync`
   * guard прогоняется всегда (обфускация `state` обязательна): `runInputGuard`
   * сам безопасно no-op'ит при `config.enabled=false`. При rate limit/блокировке
   * бросаем `RateLimitError`/`ProviderError` — вызывающий слой делает fail-safe
   * откат к текущему поведению.
   */
  async decide(
    state: unknown,
    questions: Record<string, DecisionQuestion>,
    opts?: { model?: string },
  ): Promise<DecisionResponse> {
    const startedAt = performance.now();
    let outcome: LlmCallOutcome = 'ok';
    let usage: TokenUsage | undefined;

    try {
      const stateText = this._serializeState(state);
      const synthetic: LLMMessage = {
        id: 'decision-state',
        role: 'user',
        content: stateText,
        usage: this._zeroUsage(),
        disabled: false,
        pinned: false,
        branchId: 'decision',
      };

      let prepared: PreparedCall | null = null;
      try {
        prepared = await this._prepare([synthetic], undefined, undefined);
      } catch (e) {
        warning('GATEWAY', `Ошибка обфускации decision-state, вызов inner напрямую: ${this._errorMessage(e)}`);
      }

      if (prepared?.rateLimited) {
        outcome = 'rate_limited';
        throw new RateLimitError();
      }
      if (prepared?.blocked) {
        outcome = 'blocked';
        throw new ProviderError(prepared.blocked.message, this.getProviderName());
      }

      const guardedText = prepared?.messages[0]?.content ?? stateText;
      const effectiveState = this._restoreState(state, guardedText);

      const response = await this._inner.decide(effectiveState, questions, opts);

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
      const answersJson = JSON.stringify(response.answers);

      await this._auditCompletion(
        answersJson,
        usage,
        prepared?.secretsFound ?? [],
        prepared?.placeholders ?? [],
        prepared?.patterns,
      );
      await this._logPayload(
        prepared?.messages ?? [synthetic],
        undefined,
        answersJson,
        usage,
      );

      return response;
    } catch (e) {
      if (outcome === 'ok') outcome = 'error';
      throw e;
    } finally {
      this._reportCall(outcome, startedAt, usage);
    }
  }

  /** Сериализация `state` в текст для guard'а (строка — как есть, иначе JSON). */
  private _serializeState(state: unknown): string {
    return typeof state === 'string' ? state : JSON.stringify(state ?? null);
  }

  /** Возврат `state` к исходному виду после обфускации (объект → JSON.parse). */
  private _restoreState(original: unknown, guardedText: string): unknown {
    if (typeof original === 'string') return guardedText;
    try {
      return JSON.parse(guardedText);
    } catch {
      return guardedText;
    }
  }

  async listModels(): Promise<string[]> {
    return this._inner.listModels();
  }

  async listModelsDetailed(): Promise<DetailedModelInfo[]> {
    return this._inner.listModelsDetailed();
  }

  private async _prepare(
    messages: LLMMessage[],
    systemPrompt: SystemPromptInput | undefined,
    tools: Record<string, unknown>[] | undefined,
  ): Promise<PreparedCall> {
    const originalMap = await this._opts.getMap();
    const rateLimiter = this._opts.getRateLimiter();
    const patterns = this._opts.getPatterns?.();

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
      patterns,
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
        patterns,
      };
    }

    return {
      messages: guard.messages,
      systemPrompt: guard.systemPrompt,
      tools: guard.tools,
      secretsFound: guard.secretsFound,
      placeholders,
      patterns,
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
    patterns?: SecretPattern[],
  ): Promise<void> {
    try {
      const output = runOutputGuard(content, patterns);
      if (output.found.length > 0) {
        await this._opts.getAudit().append({
          ts: nowISO(),
          type: 'output_guard',
          sessionId: this._opts.sessionId,
          userId: this._opts.userId,
          provider: this.getProviderName(),
          model: this.model,
          secretsFound: output.found.map(maskSecret),
          reason: sm('gateway.output_secrets_reason'),
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

  private async _logPayload(
    messages: LLMMessage[],
    systemPrompt: SystemPromptInput | undefined,
    content: string,
    usage: TokenUsage | undefined,
  ): Promise<void> {
    if (!this._config.logPayloads || !this._opts.payloadLogPath) return;
    try {
      await writePayloadLog(this._opts.payloadLogPath, {
        ts: nowISO(),
        sessionId: this._opts.sessionId,
        userId: this._opts.userId,
        provider: this.getProviderName(),
        model: this.model,
        request: { messages, systemPrompt },
        response: { content, usage },
      });
    } catch (e) {
      warning('GATEWAY', `Ошибка полного лога: ${this._errorMessage(e)}`);
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
