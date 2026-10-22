/**
 * GatewayProvider (ADR-036) — декоратор над BaseProvider.
 * Обфускация/блокировка секретов на входе, rate limit, аудит, output guard.
 * Если gateway выключен или что-то в обвязке падает — вызывает inner без изменений.
 */

import {
  isLlmFilterVerdictKind,
  nowISO,
  type LLMGatewayConfig,
  type LLMChunk,
  type LLMResponse,
  type TokenUsage,
  type DecisionQuestion,
  type DecisionResponse,
  type LlmFilterInput,
  type LlmFilterMessage,
  type LlmFilterPhase,
  type LlmFilterVerdict,
  type LlmFilterVerdictKind,
} from '@itphx/synth-shared';

import { BaseProvider, resolveSystemPromptText, type DetailedModelInfo, type LLMMessage, type SystemPromptInput, type CancellationToken } from '../../providers/base.js';
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
  canVetoLlmFilter,
  type LlmFilterRegistry,
  type RegisteredLlmFilter,
} from './llm-filter-registry.js';
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
  /**
   * PROP-090 §«Точка `llmFilters`»: мутабельный реестр фильтров LLM-вызовов.
   * Не задан или пуст — поведение прежнее (никаких дополнительных задержек:
   * реестр обходится только если в нём есть фильтры нужной фазы).
   *
   * Фильтры выполняются **только при включённом gateway** (`config.enabled`):
   * выключен gateway — нет и его слоёв (PROP-090 §«Семантика отказа»).
   */
  filters?: LlmFilterRegistry;
}

/**
 * PROP-090 §«Точка `llmFilters`»: коды решений хоста по фильтрам.
 *
 * Пишутся в аудит gateway (`type: 'plugin_filter'`, поле `filterCode`).
 * `plugin_filter.denied`/`plugin_filter.deny_downgraded`/`plugin_filter.unavailable`
 * — канонические коды журнала плагинов (`PLUGIN_AUDIT_REASONS`, shared);
 * остальные — коды хоста, живущие только в аудите gateway (в журнал плагинов
 * не идут: там закрытый перечень).
 */
const FILTER_CODES = {
  /** Вердикт `allow` — вызов пропущен. */
  allowed: 'plugin_filter.allowed',
  /** Блокировка вызова доверенным фильтром. */
  denied: 'plugin_filter.denied',
  /** Блокирующий вердикт понижен хостом (нет права вето у владельца). */
  downgraded: 'plugin_filter.deny_downgraded',
  /** Сбой/таймаут фильтра (что именно — `timeout`/`error`). */
  unavailable: 'plugin_filter.unavailable',
  /** Фильтр не уложился в бюджет времени. */
  timeout: 'plugin_filter.timeout',
  /** Фильтр бросил исключение или вернул неизвестный вердикт. */
  error: 'plugin_filter.error',
  /** `redact` в `pre_request` не поддерживается (требует переписывания запроса). */
  redactUnsupported: 'plugin_filter.redact_unsupported',
  /** `redact` в `post_response` не поддерживается (требует буферизации ответа). */
  bufferingRequired: 'plugin_filter.buffering_required',
  /** `redact` в `embedding` вернул массив неверной длины/типа — fail-closed. */
  redactInvalid: 'plugin_filter.redact_invalid',
} as const;

/** Коды, которые дублируются в журнал плагинов (`PluginAuditRepository`). */
const PLUGIN_JOURNAL_CODES: ReadonlySet<string> = new Set([
  FILTER_CODES.denied,
  FILTER_CODES.downgraded,
  FILTER_CODES.unavailable,
]);

/** Итог одного вызова фильтра: вердикт или сбой (таймаут/исключение). */
type FilterInspection =
  | { readonly verdict: LlmFilterVerdict }
  | { readonly failure: 'timeout' | 'error' };

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

  /**
   * PROP-090 §«Фаза `embedding`»: эмбеддинг проходит gateway-контур.
   *
   * До Ф3 `embed` был прямым вызовом `_inner.embed` мимо guard'ов, аудита и
   * метрик — дыра инварианта 3 («любой LLM-вызов — через `GatewayProvider`»).
   * Теперь: фильтры фазы `embedding` (блокировка/переписывание текстов) +
   * учёт вызова (`onCall`) + аудит решений фильтров. Обфускация и rate-limit
   * к эмбеддингам не применяются (нечего маскировать — корпус может быть
   * произвольным; лимит считается в chat-путях), но вызов больше не «невидим».
   *
   * Выключенный gateway — прежнее поведение (прямой вызов `_inner.embed`):
   * выключен gateway — нет и его слоёв (PROP-090 §«Семантика отказа»).
   */
  async embed(text: string): Promise<number[]> {
    if (!this._config.enabled) return this._inner.embed(text);

    const startedAt = performance.now();
    let outcome: LlmCallOutcome = 'ok';

    try {
      const prepared = await this._prepareEmbedding([text]);
      if (prepared.blocked) {
        outcome = 'blocked';
        throw new ProviderError(prepared.blocked.message, this.getProviderName());
      }
      return await this._inner.embed(prepared.texts[0] ?? text);
    } catch (e) {
      if (outcome === 'ok') outcome = 'error';
      throw e;
    } finally {
      this._reportCall(outcome, startedAt);
    }
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

    // PROP-090 §«Точка llmFilters», фаза `pre_request`: фильтры видят уже
    // обфусцированные сообщения/промпт/tools (после guard'а и сохранения карты).
    const filtered = await this._applyPreRequestFilters(guard.messages, guard.systemPrompt, guard.tools);
    if (filtered.blocked) {
      return {
        messages,
        systemPrompt,
        tools,
        secretsFound: guard.secretsFound,
        placeholders: [],
        blocked: filtered.blocked,
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

  /**
   * PROP-090 §«Точка `llmFilters`»: фильтры фазы в порядке регистрации.
   *
   * Пустой реестр (или выключенный gateway) → пустой список: поведение
   * побайтово прежнее, дополнительных `await` нет.
   */
  private _filtersFor(phase: LlmFilterPhase): RegisteredLlmFilter[] {
    const registry = this._opts.filters;
    if (!registry || registry.size === 0) return [];
    if (!this._config.enabled) return [];
    return registry.list(phase);
  }

  /** Базовый вход фильтра (общий для фаз): провайдер/модель/сессия. */
  private _filterInput(
    phase: LlmFilterPhase,
    extra: Pick<LlmFilterInput, 'messages' | 'systemPrompt' | 'tools' | 'content' | 'usage' | 'texts'>,
  ): LlmFilterInput {
    return {
      phase,
      provider: this.getProviderName(),
      model: this.model,
      ...(this._opts.sessionId ? { sessionId: this._opts.sessionId } : {}),
      ...extra,
    };
  }

  /**
   * Вызов одного фильтра с бюджетом времени (`timeoutMs`).
   *
   * Таймер `unref()`-нут — повисший фильтр не держит процесс. Сбой и таймаут
   * различаются кодом (`plugin_filter.timeout`/`plugin_filter.error`) — по ним
   * применяется `failMode` вызывающей стороны.
   */
  private async _inspectFilter(
    entry: RegisteredLlmFilter,
    input: LlmFilterInput,
  ): Promise<FilterInspection> {
    const timeoutMs = entry.filter.timeoutMs ?? entry.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        if (typeof timer === 'object') timer.unref();
      });
      const result = await Promise.race([
        Promise.resolve().then(() => entry.filter.inspect(input)),
        timeout,
      ]);
      if (result === 'timeout') return { failure: 'timeout' };
      if (!result || !isLlmFilterVerdictKind(result.verdict)) return { failure: 'error' };
      return { verdict: result };
    } catch {
      return { failure: 'error' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Запись решения фильтра: аудит gateway (`type: 'plugin_filter'`) плюс —
   * для канонических кодов — событие журнала плагинов (`action: 'filter'`)
   * через колбэк владельца. **Текст запроса/ответа/эмбеддингов не пишется.**
   */
  private async _recordFilterDecision(
    entry: RegisteredLlmFilter,
    input: LlmFilterInput,
    decision: {
      verdict?: LlmFilterVerdictKind;
      effective: LlmFilterVerdictKind | 'ignored';
      code: string;
      downgraded?: boolean;
      reason?: string;
    },
  ): Promise<void> {
    try {
      await this._opts.getAudit().append({
        ts: nowISO(),
        type: 'plugin_filter',
        sessionId: this._opts.sessionId,
        userId: this._opts.userId,
        provider: this.getProviderName(),
        model: this.model,
        ...(decision.reason ? { reason: decision.reason } : {}),
        filterId: entry.filter.id,
        filterPhase: input.phase,
        filterTrust: entry.trustLevel,
        ...(decision.verdict ? { filterVerdict: decision.verdict } : {}),
        filterEffectiveVerdict: decision.effective,
        ...(decision.downgraded ? { filterDowngraded: true } : {}),
        filterCode: decision.code,
        filterTimeoutMs: entry.timeoutMs,
      });
    } catch (e) {
      warning('GATEWAY', `Ошибка аудита фильтра: ${this._errorMessage(e)}`);
    }

    if (!entry.onAudit || !PLUGIN_JOURNAL_CODES.has(decision.code)) return;
    try {
      await entry.onAudit({
        filterId: entry.filter.id,
        ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
        ...(entry.pluginVersion ? { pluginVersion: entry.pluginVersion } : {}),
        phase: input.phase,
        verdict: decision.verdict ?? 'allow',
        ...(decision.effective !== 'ignored' ? { effectiveVerdict: decision.effective } : {}),
        ...(decision.downgraded ? { downgraded: true } : {}),
        code: decision.code,
        ...(decision.reason ? { reason: decision.reason } : {}),
        provider: this.getProviderName(),
        model: this.model,
        ...(this._opts.sessionId ? { sessionId: this._opts.sessionId } : {}),
      });
    } catch (e) {
      warning('GATEWAY', `Ошибка журнала плагинов (фильтр): ${this._errorMessage(e)}`);
    }
  }

  /**
   * Фаза `pre_request`: сообщения/промпт/tools уже обфусцированы.
   *
   * - `allow` → дальше;
   * - `deny` доверенного фильтра → вызов **не уходит** провайдеру;
   * - `deny`/`redact` фильтра без права вето → понижается до `allow`
   *   (`plugin_filter.deny_downgraded` — в аудит и журнал плагинов);
   * - `redact` в `pre_request` **не реализован** (нужно переписывать запрос) —
   *   вердикт отклоняется хостом (`plugin_filter.redact_unsupported`);
   * - сбой/таймаут → по `failMode` (`closed` — блокировка).
   */
  private async _applyPreRequestFilters(
    messages: LLMMessage[],
    systemPrompt: SystemPromptInput | undefined,
    tools: Record<string, unknown>[] | undefined,
  ): Promise<{ blocked?: { reason: string; message: string } }> {
    const entries = this._filtersFor('pre_request');
    if (entries.length === 0) return {};

    const systemText = resolveSystemPromptText(systemPrompt);
    const input = this._filterInput('pre_request', {
      messages: messages.map(
        (message): LlmFilterMessage => ({
          role: message.role,
          content: message.content,
          ...(message.toolUse ? { toolCalls: message.toolUse } : {}),
        }),
      ),
      ...(systemText ? { systemPrompt: systemText } : {}),
      ...(tools ? { tools } : {}),
    });

    for (const entry of entries) {
      const inspected = await this._inspectFilter(entry, input);

      if ('failure' in inspected) {
        const blocking = entry.failMode === 'closed';
        const code = inspected.failure === 'timeout' ? FILTER_CODES.timeout : FILTER_CODES.error;
        await this._recordFilterDecision(entry, input, {
          effective: blocking ? 'deny' : 'allow',
          code: FILTER_CODES.unavailable,
          reason: code,
        });
        if (blocking) {
          return {
            blocked: {
              reason: code,
              message: sm('gateway.filter_unavailable', { reason: code }),
            },
          };
        }
        continue;
      }

      const verdict = inspected.verdict;
      const reason = verdict.reason ?? verdict.code ?? entry.filter.id;

      if (verdict.verdict === 'allow') {
        await this._recordFilterDecision(entry, input, {
          verdict: 'allow',
          effective: 'allow',
          code: FILTER_CODES.allowed,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
        });
        continue;
      }

      if (verdict.verdict === 'redact') {
        // Переписывание запроса в первой волне не поддерживается.
        await this._recordFilterDecision(entry, input, {
          verdict: 'redact',
          effective: 'ignored',
          code: FILTER_CODES.redactUnsupported,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
        });
        continue;
      }

      // deny
      if (!canVetoLlmFilter(entry.trustLevel)) {
        await this._recordFilterDecision(entry, input, {
          verdict: 'deny',
          effective: 'allow',
          downgraded: true,
          code: FILTER_CODES.downgraded,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
        });
        continue;
      }

      await this._recordFilterDecision(entry, input, {
        verdict: 'deny',
        effective: 'deny',
        code: FILTER_CODES.denied,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      });
      return {
        blocked: {
          reason,
          message: sm('gateway.filter_denied', { reason }),
        },
      };
    }

    return {};
  }

  /**
   * Фаза `embedding` (до `_inner.embed`): `deny` — эмбеддинг не уходит;
   * `redact` — тексты заменяются на `redactedTexts` (несовпадение длины или
   * нестроковые элементы — `deny`, fail-closed). Право вето — как в
   * `pre_request`. Сбой/таймаут — по `failMode`.
   */
  private async _prepareEmbedding(
    texts: string[],
  ): Promise<{ texts: string[]; blocked?: { reason: string; message: string } }> {
    const entries = this._filtersFor('embedding');
    if (entries.length === 0) return { texts };

    let current = [...texts];

    for (const entry of entries) {
      const input = this._filterInput('embedding', { texts: current });
      const inspected = await this._inspectFilter(entry, input);

      if ('failure' in inspected) {
        const blocking = entry.failMode === 'closed';
        const code = inspected.failure === 'timeout' ? FILTER_CODES.timeout : FILTER_CODES.error;
        await this._recordFilterDecision(entry, input, {
          effective: blocking ? 'deny' : 'allow',
          code: FILTER_CODES.unavailable,
          reason: code,
        });
        if (blocking) {
          return {
            texts: current,
            blocked: { reason: code, message: sm('gateway.filter_unavailable', { reason: code }) },
          };
        }
        continue;
      }

      const verdict = inspected.verdict;
      const reason = verdict.reason ?? verdict.code ?? entry.filter.id;

      if (verdict.verdict === 'allow') {
        await this._recordFilterDecision(entry, input, {
          verdict: 'allow',
          effective: 'allow',
          code: FILTER_CODES.allowed,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
        });
        continue;
      }

      if (!canVetoLlmFilter(entry.trustLevel)) {
        await this._recordFilterDecision(entry, input, {
          verdict: verdict.verdict,
          effective: 'allow',
          downgraded: true,
          code: FILTER_CODES.downgraded,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
        });
        continue;
      }

      if (verdict.verdict === 'redact') {
        const redacted = verdict.redactedTexts;
        const valid =
          Array.isArray(redacted) &&
          redacted.length === current.length &&
          redacted.every((item) => typeof item === 'string');
        if (!valid) {
          await this._recordFilterDecision(entry, input, {
            verdict: 'redact',
            effective: 'deny',
            code: FILTER_CODES.redactInvalid,
            ...(verdict.reason ? { reason: verdict.reason } : {}),
          });
          return {
            texts: current,
            blocked: {
              reason: FILTER_CODES.redactInvalid,
              message: sm('gateway.filter_denied', { reason: FILTER_CODES.redactInvalid }),
            },
          };
        }
        current = [...(redacted as readonly string[])];
        await this._recordFilterDecision(entry, input, {
          verdict: 'redact',
          effective: 'redact',
          code: FILTER_CODES.allowed,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
        });
        continue;
      }

      // deny доверенного фильтра — эмбеддинг не уходит провайдеру.
      await this._recordFilterDecision(entry, input, {
        verdict: 'deny',
        effective: 'deny',
        code: FILTER_CODES.denied,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      });
      return {
        texts: current,
        blocked: { reason, message: sm('gateway.filter_denied', { reason }) },
      };
    }

    return { texts: current };
  }

  /**
   * Фаза `post_response`: **только наблюдение** (ADR-036 запрещает буферизацию
   * ответа). Блокировки и переписывания нет: `deny`/`redact` фиксируются в
   * аудите как отклонённые хостом (`plugin_filter.buffering_required`).
   * Сбой фильтра — по `failMode`, вызов уже не блокируется (ответ отдан).
   */
  private async _applyPostResponseFilters(content: string, usage: TokenUsage | undefined): Promise<void> {
    const entries = this._filtersFor('post_response');
    if (entries.length === 0) return;

    const input = this._filterInput('post_response', {
      content,
      ...(usage ? { usage } : {}),
    });

    for (const entry of entries) {
      const inspected = await this._inspectFilter(entry, input);

      if ('failure' in inspected) {
        const code = inspected.failure === 'timeout' ? FILTER_CODES.timeout : FILTER_CODES.error;
        await this._recordFilterDecision(entry, input, {
          effective: 'allow',
          code: FILTER_CODES.unavailable,
          reason: code,
        });
        continue;
      }

      const verdict = inspected.verdict;

      if (verdict.verdict === 'allow') {
        await this._recordFilterDecision(entry, input, {
          verdict: 'allow',
          effective: 'allow',
          code: FILTER_CODES.allowed,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
        });
        continue;
      }

      await this._recordFilterDecision(entry, input, {
        verdict: verdict.verdict,
        effective: 'ignored',
        code: FILTER_CODES.bufferingRequired,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
      });
    }
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

    // PROP-090 §«Точка llmFilters», фаза `post_response`: только наблюдение —
    // ответ уже отдан, блокировать/переписывать нельзя (ADR-036).
    try {
      await this._applyPostResponseFilters(content, usage);
    } catch (e) {
      warning('GATEWAY', `Ошибка фильтра ответа: ${this._errorMessage(e)}`);
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
