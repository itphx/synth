import type { EffortLevel, LLMChunk, LLMReasoningBlock, LLMResponse, LlmFinishReason, TokenUsage } from '@itphx/synth-shared';
import { effortForReasoningLevel } from '@itphx/synth-shared';
import {
  BaseProvider,
  fetchModelsCatalog,
  parseArchitectureModalities,
  redactAttachmentPayloadForDebug,
  resolveProviderCompatibility,
  resolveSystemPromptText,
  parseTokenPricing,
  supportsNativeAudio,
  toNonNegativeNumber,
  type DetailedModelInfo,
  type LLMAttachment,
  type LLMMessage,
  type SystemPromptInput,
  type CachePolicy,
  type CancellationToken,
  type ChatOptions,
} from './base.js';
import { info, warning } from '../logger.js';
import type { DebugCollector } from '../debug.js';
import { ProviderError, ContextLengthExceededError, RateLimitError } from './exceptions.js';
// ADR-099: запросы провайдера — через единый транспорт доверия TLS/CA.
import { egressFetch } from '../security/tls.js';

const ANTHROPIC_API_VERSION = '2023-06-01';

/** ADR-070 §2.2: бюджет cache_control breakpoint'ов на запрос. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Лимит вывода по умолчанию, если его не задали ни провайдер, ни сессия.
 * Дефолт сессии — тот же (`SessionManager.createSession`), поэтому бюджет
 * thinking считается от **фактического** `max_tokens` запроса.
 */
const DEFAULT_MAX_TOKENS = 4096;

/** Запрошенный бюджет thinking (`reasoningLevel: 'high'`), как у opencode. */
const REQUESTED_THINKING_BUDGET = 8192;

/** Минимальный бюджет thinking, который принимает Anthropic. */
const MIN_THINKING_BUDGET = 1024;

/**
 * Бюджет thinking под фактический `max_tokens` (паритет с opencode,
 * `fitThinkingBudget`): бюджет не больше половины лимита вывода (thinking
 * считается в тот же `max_tokens` — иначе ответу/вызову тула не остаётся
 * места) и строго меньше `max_tokens` (Anthropic: `budget_tokens` должен быть
 * меньше `max_tokens`). Если половина лимита ниже минимума, бюджет поднимается
 * до `MIN_THINKING_BUDGET` (место под минимум ещё есть); если места нет вовсе
 * (`max_tokens` ≤ минимума) — `null`: thinking не включается, запрос уходит
 * обычным (400 «max_tokens must be greater than thinking.budget_tokens»
 * не возникает).
 */
export function resolveThinkingBudget(requested: number, maxTokens: number): number | null {
  if (!Number.isFinite(maxTokens) || maxTokens <= MIN_THINKING_BUDGET) return null;
  const budget = Math.min(requested, Math.max(Math.floor(maxTokens / 2), MIN_THINKING_BUDGET));
  return budget < maxTokens ? budget : null;
}

/**
 * План thinking для запроса: включать ли блоки в истории и что отправить в
 * `body.thinking`.
 *  - `high` — thinking включён (бюджет подрезан под `max_tokens`);
 *  - `none` — явный `{type:'disabled'}`;
 *  - прочие уровни — поле не отправляется (дефолт модели), thinking **не**
 *    включается, и thinking-блоки из истории не реплеятся (Anthropic не
 *    примет их, если thinking в этом запросе выключен).
 */
interface ThinkingPlan {
  enabled: boolean;
  field?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
}

/**
 * Причина завершения ответа Anthropic (`stop_reason`) → общий словарь.
 * Незнакомое значение → `unknown` (причина есть, но не распознана);
 * отсутствие значения → `undefined` (провайдер не сообщил).
 */
const ANTHROPIC_FINISH_REASONS: Record<string, LlmFinishReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
};

export function normalizeAnthropicFinishReason(raw: unknown): LlmFinishReason | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return ANTHROPIC_FINISH_REASONS[raw] ?? 'unknown';
}

/** Число из поля usage (`0` для отсутствующего/невалидного значения). */
function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * ADR-071 §2.1: индекс инструмента для tools-брейкпоинта.
 *  - `stableToolCount` не задан → последний инструмент (обратная совместимость);
 *  - `stableToolCount <= 0` → -1 (встроенных нет, MCP не кэшируем);
 *  - иначе → последний встроенный (`min(count, length) - 1`).
 */
function resolveToolsBreakpointIndex(
  tools: Array<Record<string, unknown>> | undefined,
  stableToolCount: number | undefined,
): number {
  if (!tools || tools.length === 0) return -1;
  if (stableToolCount === undefined) return tools.length - 1;
  if (stableToolCount <= 0) return -1;
  return Math.min(stableToolCount, tools.length) - 1;
}

export class AnthropicProvider extends BaseProvider {
  getProviderName(): string {
    return this.name;
  }

  async listModels(): Promise<string[]> {
    const models = await fetchModelsCatalog(this._modelsUrl(), this._getHeaders());
    return models
      .map((m) => (typeof m.id === 'string' ? m.id : String(m.id ?? '')))
      .filter(Boolean);
  }

  /**
   * Список моделей с метаданными.
   *  - Официальный Anthropic `GET /v1/models`: `max_input_tokens` → contextWindow,
   *    `max_tokens` → maxOutputTokens, `display_name` → name (поля nullable).
   *  - RouterAI с типом anthropic отдаёт OpenRouter-каталог на том же пути:
   *    `context_length` → contextWindow, `pricing`/`pricing_units` → цены за 1M
   *    токенов (только токенные тарифы), `architecture` → модальности входа.
   */
  async listModelsDetailed(): Promise<DetailedModelInfo[]> {
    const models = await fetchModelsCatalog(this._modelsUrl(), this._getHeaders());
    return models.map((m) => this._parseModel(m)).filter((m) => m.id);
  }

  private _modelsUrl(): string {
    const baseUrl = this.url.replace(/\/v1\/messages\/?$/, '').replace(/\/+$/, '');
    return `${baseUrl}/v1/models`;
  }

  private _parseModel(raw: Record<string, unknown>): DetailedModelInfo {
    const id = typeof raw.id === 'string' ? raw.id : String(raw.id ?? '');
    const result: DetailedModelInfo = { id };
    if (!id) return result;

    if (typeof raw.display_name === 'string' && raw.display_name) result.name = raw.display_name;
    else if (typeof raw.name === 'string' && raw.name) result.name = raw.name;

    // Официальный Anthropic (nullable-поля).
    const maxInputTokens = toNonNegativeNumber(raw.max_input_tokens);
    if (maxInputTokens !== undefined && maxInputTokens > 0) result.contextWindow = maxInputTokens;

    const maxTokens = toNonNegativeNumber(raw.max_tokens);
    if (maxTokens !== undefined && maxTokens > 0) result.maxOutputTokens = maxTokens;

    // RouterAI / OpenRouter-совместимый каталог (обратная совместимость).
    const contextLength = toNonNegativeNumber(raw.context_length);
    if (contextLength !== undefined && contextLength > 0 && result.contextWindow === undefined) {
      result.contextWindow = contextLength;
    }

    // ADR-115: модальности входа из каталога провайдера (`architecture` у
    // RouterAI/OpenRouter; общий парсер с OpenAI-провайдером). Без этого поля
    // модель считалась текстовой и вложения отбрасывались гидратацией.
    const modalities = parseArchitectureModalities(
      raw.architecture as Record<string, unknown> | undefined,
    );
    if (modalities) result.modalities = modalities;

    const parsed = parseTokenPricing(
      raw.pricing as Record<string, unknown> | undefined,
      raw.pricing_units as Record<string, unknown> | undefined,
    );
    if (parsed) Object.assign(result, parsed);

    return result;
  }

  /**
   * План thinking для запроса (см. `ThinkingPlan`). Бюджет считается от
   * фактического `max_tokens` — иначе при дефолтном лимите сессии (4096) API
   * отвергал запрос «max_tokens must be greater than thinking.budget_tokens».
   */
  private _resolveThinking(maxTokens: number): ThinkingPlan {
    if (this.reasoningLevel === 'none') {
      // ADR-117: модель с **обязательным** reasoning всё равно думает, а явный
      // `thinking:{type:'disabled'}` она отвергает (400, code 2013). Поэтому
      // поле не отправляем вовсе — «выключить» размышления у такой модели
      // нельзя, и притворяться, что мы это сделали, нельзя тем более.
      if (this._requiresReasoning()) {
        warning(
          'ANTHROPIC',
          'reasoningLevel=none: модель требует reasoning — поле thinking не отправляется (API отвергает disabled)',
        );
        return { enabled: false };
      }
      return { enabled: false, field: { type: 'disabled' } };
    }
    if (this.reasoningLevel !== 'high') return { enabled: false };
    const budget = resolveThinkingBudget(REQUESTED_THINKING_BUDGET, maxTokens);
    if (budget === null) {
      // Места под thinking нет — ход продолжается обычным запросом (без падения).
      warning(
        'ANTHROPIC',
        `thinking не включён: max_tokens=${maxTokens} не вмещает бюджет ${MIN_THINKING_BUDGET} (минимум)`,
      );
      return { enabled: false };
    }
    return { enabled: true, field: { type: 'enabled', budget_tokens: budget } };
  }

  /** ADR-117: модель требует reasoning (`compatibility.requireReasoning`/shorthand). */
  private _requiresReasoning(): boolean {
    return resolveProviderCompatibility({
      type: this.type,
      name: this.name,
      url: this.url,
      model: this.model,
      compatibility: this.compatibility,
      requiresReasoning: this.requiresReasoning,
    }).requireReasoning;
  }

  /**
   * ADR-117: поддержан ли effort-режим у этой пары провайдер/модель.
   * Только явное `compatibility.supportsEffortUpdates: true` — без эвристик
   * (поле меняет тело запроса, угадывание ломало бы шлюзы без поддержки).
   */
  private _supportsEffortUpdates(): boolean {
    return resolveProviderCompatibility({
      type: this.type,
      name: this.name,
      url: this.url,
      model: this.model,
      compatibility: this.compatibility,
      requiresReasoning: this.requiresReasoning,
    }).supportsEffortUpdates;
  }

  /**
   * ADR-117: `output_config.effort` запроса.
   *
   * Приоритет: явный `options.effort` → `reasoningLevel` (`low|medium|high`);
   * `none`/`default` → `undefined` (поле не отправляется — «выключить
   * размышления» effort-тиром не выразить). Считается **на каждый вызов**:
   * провайдеры кэшируются, поэтому effort живёт в опциях, а не в экземпляре.
   */
  private _resolveEffort(options: ChatOptions | undefined, supported = this._supportsEffortUpdates()): EffortLevel | undefined {
    if (!supported) return undefined;
    return options?.effort ?? effortForReasoningLevel(this.reasoningLevel);
  }

  /**
   * План thinking: в effort-режиме `thinking` **не отправляется вообще**
   * (ни `enabled`, ни `disabled`) — у effort-моделей это другой режим, и
   * смешивать их нельзя. Блоки thinking из истории в effort-режиме тоже не
   * реплеятся (`thinkingEnabled = false`).
   */
  private _thinkingPlan(maxTokens: number, effortMode: boolean): ThinkingPlan {
    if (effortMode) return { enabled: false };
    return this._resolveThinking(maxTokens);
  }

  /**
   * Anthropic требует `temperature: 1` при включённом thinking — значение
   * сессии/агента принудительно перекрывается (иначе 400). Значение не
   * мутируется на экземпляре (провайдеры кэшируются и разделяются).
   */
  private _forceThinkingTemperature(body: Record<string, unknown>): void {
    if (this.temperature !== 1) {
      info(
        'ANTHROPIC',
        `thinking включён: temperature ${this.temperature ?? 'default'} → 1 (требование API)`,
      );
    }
    body.temperature = 1;
  }

  /**
   * `tool_choice` при включённом thinking: Anthropic запрещает принудительный
   * вызов инструмента (`any`/`tool`), поэтому `required` коэрсится в `auto`;
   * `none` разрешён (шаг-лимит).
   */
  private _applyToolChoice(
    body: Record<string, unknown>,
    toolChoice: ChatOptions['toolChoice'],
    thinkingEnabled: boolean,
  ): void {
    if (!toolChoice) return;
    let choice = toolChoice;
    if (thinkingEnabled && choice === 'required') {
      warning('ANTHROPIC', "thinking включён: tool_choice 'required' → 'auto' (API запрещает принудительный вызов)");
      choice = 'auto';
    }
    body.tool_choice = { type: choice };
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    stream?: boolean,
    debugCollector?: DebugCollector,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const maxTokens = this.maxTokens ?? DEFAULT_MAX_TOKENS;
    const effortMode = this._supportsEffortUpdates();
    const effort = this._resolveEffort(options, effortMode);
    const thinking = this._thinkingPlan(maxTokens, effortMode);
    const formattedMessages = this._formatMessages(messages, thinking.enabled);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      max_tokens: maxTokens,
    };
    this._applyTemperature(body);
    if (thinking.enabled) this._forceThinkingTemperature(body);
    if (thinking.field) body.thinking = thinking.field;
    if (effort) body.output_config = { effort };
    if (this.topP !== undefined) body.top_p = this.topP;
    const systemBlocks = this._buildSystemBlocks(systemPrompt);
    if (systemBlocks.length) body.system = systemBlocks;
    if (tools?.length) {
      body.tools = this._formatTools(tools);
      // Anthropic: `tool_choice` — объект `{type}`; без инструментов поле не
      // отправляем (валидация API отвергнет запрос).
      this._applyToolChoice(body, options?.toolChoice, thinking.enabled);
    }
    if (stream) body.stream = true;
    this._applyCacheControl(body, systemPrompt);

    const headers = this._getHeaders();
    if (debugCollector?.enabled) {
      debugCollector.captureApiRequest(this.url, 'POST', headers, redactAttachmentPayloadForDebug(body));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);

    try {
      const resp = await egressFetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        this._handleErrors(resp.status, errorText);
        throw new Error(`Anthropic API error ${resp.status}: ${errorText}`);
      }

      const data = await resp.json() as Record<string, unknown>;
      debugCollector?.captureApiResponse(data);
      debugCollector?.captureRawModelResponse(JSON.stringify(data));

      const errorPayload = this._extractErrorPayload(data);
      if (errorPayload) {
        throw new ProviderError(`Anthropic API error: ${errorPayload}`, this.name);
      }

      return this._parseResponse(data, debugCollector);
    } finally {
      clearTimeout(timer);
    }
  }

  async *chatAsync(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    debugCollector?: DebugCollector,
    cancellationToken?: CancellationToken,
    options?: ChatOptions,
  ): AsyncGenerator<LLMChunk> {
    const maxTokens = this.maxTokens ?? DEFAULT_MAX_TOKENS;
    const effortMode = this._supportsEffortUpdates();
    const effort = this._resolveEffort(options, effortMode);
    const thinking = this._thinkingPlan(maxTokens, effortMode);
    const formattedMessages = this._formatMessages(messages, thinking.enabled);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      max_tokens: maxTokens,
      stream: true,
    };
    this._applyTemperature(body);
    if (thinking.enabled) this._forceThinkingTemperature(body);
    if (thinking.field) body.thinking = thinking.field;
    if (effort) body.output_config = { effort };
    if (this.topP !== undefined) body.top_p = this.topP;
    const systemBlocks = this._buildSystemBlocks(systemPrompt);
    if (systemBlocks.length) body.system = systemBlocks;
    if (tools?.length) {
      body.tools = this._formatTools(tools);
      // Anthropic: `tool_choice` — объект `{type}`; `none` поддерживается.
      // Без инструментов поле не отправляем (валидация API отвергнет запрос).
      this._applyToolChoice(body, options?.toolChoice, thinking.enabled);
    }
    this._applyCacheControl(body, systemPrompt);

    const headers = this._getHeaders();
    if (debugCollector?.enabled) {
      debugCollector.captureApiRequest(this.url, 'POST', headers, redactAttachmentPayloadForDebug(body));
    }

    info('ANTHROPIC', `чатAsync: url=${this.url}, model=${this.model}`);

    let accumulatedReasoning = '';
    let accumulatedSignature: string | undefined;
    const accumulatedRedacted: string[] = [];
    /**
     * Anthropic может вернуть несколько thinking-блоков в одном ответе; подпись
     * у каждого своя, поэтому блоки собираются по отдельности (порядок ответа).
     * `redacted_thinking` — отдельные элементы без текста.
     */
    const accumulatedReasoningBlocks: LLMReasoningBlock[] = [];
    let currentThinking: { text: string; signature?: string } | null = null;
    const flushThinkingBlock = (): void => {
      if (!currentThinking) return;
      accumulatedReasoningBlocks.push({
        text: currentThinking.text,
        ...(currentThinking.signature !== undefined ? { signature: currentThinking.signature } : {}),
      });
      currentThinking = null;
    };
    let accumulatedContent = '';
    let accumulatedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    /**
     * Причина завершения ответа: Anthropic отдаёт её в `message_delta`
     * (`delta.stop_reason`), а не в `message_stop`. Без этого «срезано
     * лимитом» (пустой `content` при `max_tokens`) неотличимо от пустого
     * ответа модели.
     */
    let accumulatedFinishReason: LlmFinishReason | undefined;
    const accumulatedToolCalls: Record<string, unknown>[] = [];
    const toolCallByBlockIndex = new Map<number, number>();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);

    // Таймаут — только на ожидание первого чанка. Как только стрим пошёл,
    // таймер снимается, дальше стрим длится сколько нужно.
    let firstChunkReceived = false;

    // ADR-104 (этап 2): прерывание генерации без отмены хода — обрыв сетевого
    // запроса (как «Стоп»), но токен НЕ помечается отменённым: ход
    // продолжается (оркестратор применяет инъекцию на границе шага).
    if (cancellationToken) {
      const originalInterrupt = cancellationToken.interrupt?.bind(cancellationToken);
      cancellationToken.interrupt = () => {
        originalInterrupt?.();
        controller.abort();
      };
    }

    try {
      const resp = await egressFetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        this._handleErrors(resp.status, errorText);
        throw new Error(`Anthropic API error ${resp.status}: ${errorText}`);
      }

      if (!resp.body) throw new Error('Нет тела ответа');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEventType = '';

      try {
        while (true) {
          if (cancellationToken?.cancelled || cancellationToken?.interrupted) {
            info('ANTHROPIC', 'Стрим отменён по токену');
            reader.cancel();
            return;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('event:')) {
              currentEventType = trimmed.slice(6).trim();
              continue;
            }

            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') break;

            try {
              const chunkData = JSON.parse(dataStr) as Record<string, unknown>;
              debugCollector?.captureRawModelResponse(dataStr);

              const eventType = (chunkData.type as string) || currentEventType;

              const errorPayload = this._extractErrorPayload(chunkData);
              if (errorPayload) {
                throw new ProviderError(`Anthropic API error: ${errorPayload}`, this.name);
              }

              if (eventType === 'content_block_start') {
                const block = chunkData.content_block as Record<string, unknown> | undefined;
                // Старт thinking/tool_use блока — стрим пошёл, таймер больше не нужен.
                if (
                  block?.type === 'thinking'
                  || block?.type === 'redacted_thinking'
                  || block?.type === 'tool_use'
                ) {
                  if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    clearTimeout(timer);
                  }
                }
                // Новый блок закрывает предыдущий thinking — блоки не склеиваем.
                flushThinkingBlock();
                if (block?.type === 'thinking') {
                  accumulatedReasoning = '';
                  // RouterAI отдаёт подпись прямо в старте блока, нередко пустой
                  // строкой (`"signature": ""`) — пустая подпись валидна.
                  accumulatedSignature = typeof block.signature === 'string'
                    ? block.signature
                    : undefined;
                  currentThinking = {
                    text: typeof block.thinking === 'string' ? block.thinking : '',
                    ...(accumulatedSignature !== undefined ? { signature: accumulatedSignature } : {}),
                  };
                } else if (block?.type === 'redacted_thinking') {
                  // Opaque-блок: реплеится в историю verbatim (`data`).
                  if (typeof block.data === 'string' && block.data) {
                    accumulatedRedacted.push(block.data);
                    accumulatedReasoningBlocks.push({ text: '', redactedData: block.data });
                  }
                } else if (block?.type === 'tool_use') {
                  const blockIndex = chunkData.index as number;
                  const tcIdx = accumulatedToolCalls.length;
                  toolCallByBlockIndex.set(blockIndex, tcIdx);
                  accumulatedToolCalls.push({
                    id: block.id,
                    type: 'function',
                    function: {
                      name: block.name,
                      arguments: '',
                    },
                  });
                }
                continue;
              }

              if (eventType === 'content_block_delta') {
                const delta = chunkData.delta as Record<string, unknown> | undefined;
                const deltaType = delta?.type as string | undefined;

                if (deltaType === 'thinking_delta') {
                  const thinking = String(delta?.thinking ?? '');
                  if (thinking) {
                    if (!firstChunkReceived) {
                      firstChunkReceived = true;
                      clearTimeout(timer);
                    }
                    accumulatedReasoning += thinking;
                    if (currentThinking) currentThinking.text += thinking;
                    yield {
                      content: '',
                      isFinal: false,
                      usage: accumulatedUsage,
                      reasoning: accumulatedReasoning,
                    };
                  }
                } else if (deltaType === 'signature_delta') {
                  // Подпись thinking-блока приходит отдельной дельтой (и, как
                  // правило, целиком) — она авторитетнее значения из старта
                  // блока. Пустая строка тоже валидна (RouterAI).
                  const signature = delta?.signature;
                  if (typeof signature === 'string') {
                    accumulatedSignature = signature;
                    if (currentThinking) currentThinking.signature = signature;
                  }
                } else if (deltaType === 'text_delta') {
                  const text = String(delta?.text ?? '');
                  if (text) {
                    if (!firstChunkReceived) {
                      firstChunkReceived = true;
                      clearTimeout(timer);
                    }
                    accumulatedContent += text;
                    yield {
                      content: text,
                      isFinal: false,
                      usage: accumulatedUsage,
                      reasoning: accumulatedReasoning || undefined,
                    };
                  }
                } else if (deltaType === 'input_json_delta') {
                  const blockIndex = chunkData.index as number;
                  const tcIdx = toolCallByBlockIndex.get(blockIndex);
                  if (tcIdx !== undefined) {
                    const tc = accumulatedToolCalls[tcIdx];
                    if (tc) {
                      const func = tc.function as Record<string, unknown>;
                      func.arguments = String(func.arguments || '') + String(delta?.partial_json ?? '');
                    }
                  }
                }
              }

              if (eventType === 'message_start') {
                // Anthropic отдаёт input/cache-токены в message_start, а не в
                // message_delta — без этого в стриме inputTokens остаётся 0.
                const message = chunkData.message as Record<string, unknown> | undefined;
                const usage = message?.usage as Record<string, unknown> | undefined;
                if (usage) accumulatedUsage = this._normalizeUsage(usage);
              }

              if (eventType === 'message_delta') {
                // Причина завершения: `delta.stop_reason` (`end_turn`,
                // `max_tokens`, `tool_use`, `stop_sequence`).
                const delta = chunkData.delta as Record<string, unknown> | undefined;
                const stopReason = normalizeAnthropicFinishReason(delta?.stop_reason);
                if (stopReason) accumulatedFinishReason = stopReason;

                const usage = chunkData.usage as Record<string, unknown> | undefined;
                if (usage) {
                  // message_delta обычно несёт только cumulative output_tokens:
                  // сохраняем input/cache из message_start.
                  const prevNonCached = Math.max(
                    0,
                    (accumulatedUsage.inputTokens || 0)
                      - (accumulatedUsage.cacheReadTokens || 0)
                      - (accumulatedUsage.cacheWriteTokens || 0),
                  );
                  accumulatedUsage = this._normalizeUsage({
                    input_tokens: usage.input_tokens ?? prevNonCached,
                    output_tokens: usage.output_tokens ?? accumulatedUsage.outputTokens,
                    cache_read_input_tokens:
                      usage.cache_read_input_tokens ?? accumulatedUsage.cacheReadTokens ?? 0,
                    cache_creation_input_tokens:
                      usage.cache_creation_input_tokens ?? accumulatedUsage.cacheWriteTokens ?? 0,
                    // thinking-токены приходят кумулятивно именно здесь.
                    output_tokens_details: usage.output_tokens_details,
                  });
                }
              }

              if (eventType === 'message_stop') break;
            } catch (e) {
              // Ошибка API, пришедшая data-чанком ({code,message} / type:error),
              // должна дойти до оркестратора, а не превратиться в пустой ответ
              // (ADR-041). Невалидный JSON по-прежнему пропускаем.
              if (e instanceof ProviderError) throw e;
              continue;
            }
          }
        }
      } catch (e) {
        // Ошибка API (ProviderError) должна дойти до оркестратора и не
        // превратиться в пустой ответ (ADR-041); прочие обрывы стрима логируем.
        if (e instanceof ProviderError) throw e;
        info('ANTHROPIC', `Стрим прерван: ${e}`);
      } finally {
        reader.releaseLock();
      }

      if (!cancellationToken?.cancelled && !cancellationToken?.interrupted) {
        flushThinkingBlock();
        debugCollector?.captureApiResponse({
          usage: accumulatedUsage,
          model: this.model,
          stop_reason: accumulatedFinishReason,
          tool_calls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
        });

        yield {
          content: accumulatedContent,
          isFinal: true,
          usage: accumulatedUsage,
          toolCalls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
          reasoning: accumulatedReasoning || undefined,
          reasoningBlocks: accumulatedReasoningBlocks.length ? accumulatedReasoningBlocks : undefined,
          reasoningSignature: accumulatedSignature,
          reasoningRedacted: accumulatedRedacted.length ? accumulatedRedacted : undefined,
          model: this.model,
          finishReason: accumulatedFinishReason,
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * История → `body.messages`.
   *
   * `thinkingEnabled` — thinking включён в **этом** запросе (см. `ThinkingPlan`).
   * Если выключен, thinking-блоки из истории **не реплеятся**: Anthropic не
   * принимает `thinking` в истории без включённого thinking (игнорирует
   * `redacted_thinking` при выключенном — тоже лишний риск 400), а прежняя
   * история с reasoning-сообщениями должна оставаться отправляемой.
   *
   * Порядок блоков assistant-сообщения — как у Anthropic (и opencode):
   * `redacted_thinking` → `thinking` → `text` → `tool_use`.
   */
  private _formatMessages(
    messages: LLMMessage[],
    thinkingEnabled = this.reasoningLevel === 'high',
  ): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];
    // Дедуп — только для уже выданных tool_result (по tool_call_id). id'ы
    // assistant.tool_use сюда НЕ добавляются: иначе tool_result вырезается и
    // Anthropic отвечает invalid_request_error «Can only get item pairs from a mapping».
    const emittedToolResultIds = new Set<string>();
    // Подряд идущие tool-результаты (в т.ч. от параллельных вызовов) должны
    // попасть в ОДНО user-сообщение — требование Anthropic. Буферизуем и
    // сбрасываем при первом не-tool сообщении / в конце истории.
    let pendingToolResults: Array<Record<string, unknown>> | null = null;
    const flushToolResults = (): void => {
      if (pendingToolResults && pendingToolResults.length > 0) {
        formatted.push({ role: 'user', content: pendingToolResults });
      }
      pendingToolResults = null;
    };

    for (const msg of messages) {
      if (msg.disabled) continue;
      if (msg.role === 'info' || msg.role === 'model') continue;

      if (msg.role === 'tool') {
        if (msg.toolCallId && emittedToolResultIds.has(msg.toolCallId)) continue;
        if (msg.toolCallId) emittedToolResultIds.add(msg.toolCallId);
        if (!pendingToolResults) pendingToolResults = [];
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content,
        });
        continue;
      }

      flushToolResults();

      if (msg.role === 'assistant') {
        const contentParts: Array<Record<string, unknown>> = [];
        if (thinkingEnabled) {
          const blocks = msg.reasoningBlocks;
          if (blocks && blocks.length > 0) {
            // Мульти-блочный ответ: каждый блок реплеится со своей подписью в
            // исходном порядке (`redacted_thinking` — отдельными элементами).
            for (const block of blocks) {
              if (typeof block.redactedData === 'string' && block.redactedData) {
                contentParts.push({ type: 'redacted_thinking', data: block.redactedData });
                continue;
              }
              const text = block.text ?? '';
              const hasSignature = typeof block.signature === 'string';
              if (text || hasSignature) {
                contentParts.push({
                  type: 'thinking',
                  thinking: text,
                  signature: block.signature ?? '',
                });
              }
            }
          } else {
            // Opaque redacted-блоки — verbatim, до видимого thinking.
            for (const data of msg.reasoningRedacted ?? []) {
              if (typeof data === 'string' && data) contentParts.push({ type: 'redacted_thinking', data });
            }
            const thinking = msg.reasoning ?? '';
            const hasSignature = typeof msg.reasoningSignature === 'string';
            // thinking отправляется, если есть текст или подпись; пустая подпись —
            // валидное значение (`signature: ''`, RouterAI/qwen).
            if (thinking || hasSignature) {
              contentParts.push({
                type: 'thinking',
                thinking,
                signature: msg.reasoningSignature ?? '',
              });
            }
          }
        }
        if (msg.content) {
          contentParts.push({ type: 'text', text: msg.content });
        }
        if (msg.toolUse) {
          for (const tu of msg.toolUse) {
            const fn = tu.function as Record<string, unknown> | undefined;
            contentParts.push({
              type: 'tool_use',
              id: tu.id,
              name: fn?.name,
              input: this._parseToolInput(fn?.arguments),
            });
          }
        }
        if (contentParts.length) {
          formatted.push({ role: 'assistant', content: contentParts });
        }
        continue;
      }

      formatted.push({
        role: msg.role,
        content: this._contentWithAttachments(msg),
      });
    }

    flushToolResults();
    return formatted;
  }

  /**
   * ADR-115: контент user-сообщения блоками.
   *
   * Вложение (image/pdf) добавляется к тексту; audio/video Anthropic не
   * принимает и они пропускаются. Если вложений нет (или кодируемых частей не
   * получилось) — ровно прежний `[{type:'text', text}]` (текстовый путь не
   * меняется).
   */
  private _contentWithAttachments(msg: LLMMessage): Array<Record<string, unknown>> {
    const mediaParts = this._mediaContentParts(msg.attachments);
    if (mediaParts.length === 0) {
      return [{ type: 'text', text: msg.content }];
    }
    return [
      ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
      ...mediaParts,
    ];
  }

  /**
   * ADR-115: части контента Anthropic для вложений.
   *
   *  - `image/*` → `{type:'image', source:{type:'base64', media_type, data}}`;
   *  - `application/pdf` → `{type:'document', source:{type:'base64', media_type:'application/pdf', data}}`;
   *  - `audio/*` → `{type:'audio', source:{type:'base64', media_type, data}}` —
   *    расширение RouterAI (проверено: wav и ogg); официальный Anthropic API
   *    аудио не принимает, поэтому блок отправляется только для RouterAI.
   *  - video и прочее не поддерживаются — пропускаются.
   *
   * Фильтра по справочнику модальностей здесь **нет** (ADR-115): провайдер
   * кодирует всё, что ему передали, и пропускает только типы, которых
   * физически не умеет. Модальности фильтруются выше — гидратация
   * (`hydrateMessageAttachments` + `ModelConfig.modalities`/`resolveModelModalities`);
   * второй фильтр по неполному справочнику отбрасывал валидные вложения
   * (например, `minimax/minimax-m3.1-flash` в каталоге RouterAI — vision-модель,
   * которой в справочнике нет).
   */
  private _mediaContentParts(attachments: LLMAttachment[] | undefined): Array<Record<string, unknown>> {
    const parts: Array<Record<string, unknown>> = [];
    for (const attachment of attachments ?? []) {
      const mime = attachment.mime.toLowerCase();
      if (mime.startsWith('image/')) {
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: attachment.mime, data: attachment.base64 },
        });
      } else if (mime === 'application/pdf') {
        parts.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: attachment.base64 },
        });
      } else if (supportsNativeAudio('anthropic', this.url, mime)) {
        // RouterAI расширяет Anthropic-протокол аудио-блоком; официальный
        // Anthropic его не знает. Надёжно декодируется только wav (ogg/mp3
        // возвращают 200, но модель аудио не слышит) — предикат это учитывает.
        parts.push({
          type: 'audio',
          source: { type: 'base64', media_type: 'audio/wav', data: attachment.base64 },
        });
      }
    }
    return parts;
  }

  /**
   * Anthropic ожидает `tool_use.input` объектом. В истории arguments может
   * храниться JSON-строкой (старые сессии / OpenAI-совместимый формат) —
   * парсим; при уже-объекте отдаём как есть, при ошибке парсинга — {},
   * чтобы не ронять запрос.
   */
  private _parseToolInput(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch {
        // невалидный JSON — отдаём {}
      }
    }
    return {};
  }

  /**
   * Anthropic-совместимые прокси (RouterAI и др.) на невалидный запрос
   * отвечают HTTP 200 с телом-ошибкой вместо HTTP-статуса: в non-stream —
   * `{type:'error', error:{...}}`, в стриме — data-чанк `{code, message}`.
   * Без явной проверки такая ошибка проглатывается и превращается в пустой
   * ответ модели (ADR-041). Возвращает текст ошибки или null.
   */
  private _extractErrorPayload(data: Record<string, unknown>): string | null {
    if (data.type === 'error') {
      const err = data.error as Record<string, unknown> | undefined;
      const message = err?.message;
      return typeof message === 'string' ? message : JSON.stringify(data.error ?? data);
    }
    if (data.error && typeof data.error === 'object') {
      const err = data.error as Record<string, unknown>;
      const message = err.message;
      return typeof message === 'string' ? message : JSON.stringify(err);
    }
    // RouterAI/proxy: {code, message, request_id} без поля type.
    if (typeof data.code === 'string' && data.code && typeof data.message === 'string') {
      return data.message;
    }
    return null;
  }

  private _formatTools(tools: Record<string, unknown>[]): Array<Record<string, unknown>> {
    return tools.map((tool) => {
      if (tool.function) {
        const fn = tool.function as Record<string, unknown>;
        return {
          name: fn.name,
          description: fn.description || '',
          input_schema: fn.parameters || {},
        };
      }
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.input_schema || {},
      };
    });
  }

  /**
   * ADR-070 §2.2: `body.system` — массив блоков. Если задан `stablePrefix` и он
   * является префиксом текста, отдаём два блока: [stable, остаток] — граница
   * stable-префикса и конец system. Иначе — один блок.
   */
  private _buildSystemBlocks(systemPrompt?: SystemPromptInput): Array<Record<string, unknown>> {
    const text = resolveSystemPromptText(systemPrompt);
    if (!text) return [];

    const payload = typeof systemPrompt === 'object' && systemPrompt !== null ? systemPrompt : undefined;
    const stablePrefix = payload?.stablePrefix;
    if (stablePrefix && stablePrefix.length > 0 && text.startsWith(stablePrefix)) {
      const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: stablePrefix }];
      const rest = text.slice(stablePrefix.length);
      if (rest) blocks.push({ type: 'text', text: rest });
      return blocks;
    }

    return [{ type: 'text', text }];
  }

  /**
   * ADR-070 §2.2: расстановка `cache_control: {type:'ephemeral'}` после
   * нормализации. Приоритет tools → system → messages, бюджет ≤4 breakpoint'а;
   * лишние дропаются с предупреждением (запрос не падает 400).
   * `cachePolicy: 'none'` — ни одного маркера.
   */
  private _applyCacheControl(body: Record<string, unknown>, systemPrompt?: SystemPromptInput): void {
    const payload = typeof systemPrompt === 'object' && systemPrompt !== null ? systemPrompt : undefined;
    const policy: CachePolicy = payload?.cachePolicy ?? 'auto';
    if (policy === 'none') return;

    const systemBlocks = body.system as Array<Record<string, unknown>> | undefined;
    const tools = body.tools as Array<Record<string, unknown>> | undefined;
    const messages = body.messages as Array<Record<string, unknown>> | undefined;

    const candidates: Array<{ label: string; apply: () => void }> = [];

    // Приоритет 1: граница stable-слоя инструментов. ADR-071 §2.1: встроенные
    // идут первыми, MCP — после границы (`stableToolCount`) и не кэшируются,
    // поэтому брейкпоинт ставим на последний встроенный. Если граница не задана
    // — прежнее поведение (последний tool). Если встроенных нет (0) — tools не
    // кэшируем вовсе, бюджет уходит system/messages.
    const toolsBreakpointIndex = resolveToolsBreakpointIndex(tools, payload?.stableToolCount);
    if (toolsBreakpointIndex >= 0) {
      candidates.push({
        label: 'tools',
        apply: () => {
          tools![toolsBreakpointIndex]!.cache_control = { type: 'ephemeral' };
        },
      });
    }

    // Приоритет 2: system — граница stable-префикса и конец system.
    if (systemBlocks && systemBlocks.length > 0) {
      if (systemBlocks.length >= 2) {
        candidates.push({
          label: 'system.stable',
          apply: () => {
            systemBlocks[0]!.cache_control = { type: 'ephemeral' };
          },
        });
        candidates.push({
          label: 'system.end',
          apply: () => {
            systemBlocks[systemBlocks.length - 1]!.cache_control = { type: 'ephemeral' };
          },
        });
      } else {
        candidates.push({
          label: 'system.end',
          apply: () => {
            systemBlocks[0]!.cache_control = { type: 'ephemeral' };
          },
        });
      }
    }

    // Приоритет 3: последнее user-сообщение (последний text-part).
    const userTextPart = this._lastUserTextPart(messages);
    if (userTextPart) {
      candidates.push({
        label: 'messages',
        apply: () => {
          userTextPart.cache_control = { type: 'ephemeral' };
        },
      });
    }

    if (candidates.length > MAX_CACHE_BREAKPOINTS) {
      const dropped = candidates.slice(MAX_CACHE_BREAKPOINTS).map((c) => c.label).join(', ');
      warning(
        'ANTHROPIC',
        `Prompt-cache: breakpoints ${candidates.length} > ${MAX_CACHE_BREAKPOINTS}, дропаю: ${dropped}`,
      );
    }
    for (const candidate of candidates.slice(0, MAX_CACHE_BREAKPOINTS)) {
      candidate.apply();
    }
  }

  /** Последний text-part последнего user-сообщения (для message-breakpoint). */
  private _lastUserTextPart(
    messages: Array<Record<string, unknown>> | undefined,
  ): Record<string, unknown> | null {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role !== 'user') continue;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) return null;
      for (let j = content.length - 1; j >= 0; j--) {
        const part = content[j]!;
        if (part.type === 'text') return part;
      }
      // Последнее user-сообщение без text-part (например, tool_result) — маркер не ставим.
      return null;
    }
    return null;
  }

  private _parseResponse(
    data: Record<string, unknown>,
    debugCollector?: DebugCollector,
  ): LLMResponse {
    const contentBlocks = (data.content as Array<Record<string, unknown>>) || [];
    let accumulatedContent = '';
    const accumulatedToolCalls: Record<string, unknown>[] = [];
    let accumulatedReasoning: string | undefined;
    let accumulatedSignature: string | undefined;
    const accumulatedRedacted: string[] = [];
    const reasoningBlocks: LLMReasoningBlock[] = [];

    for (const block of contentBlocks) {
      const blockType = block.type as string | undefined;

      if (blockType === 'text') {
        accumulatedContent += String(block.text ?? '');
      } else if (blockType === 'tool_use') {
        accumulatedToolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.input || {} },
        });
      } else if (blockType === 'thinking') {
        accumulatedReasoning = String(block.thinking ?? '');
        // Подпись thinking-блока: без возврата в историю следующий tool-loop
        // отвергается API. Пустая строка — валидна (RouterAI/qwen).
        accumulatedSignature = typeof block.signature === 'string' ? block.signature : undefined;
        reasoningBlocks.push({
          text: accumulatedReasoning,
          ...(accumulatedSignature !== undefined ? { signature: accumulatedSignature } : {}),
        });
        debugCollector?.captureReasoning(accumulatedReasoning);
      } else if (blockType === 'redacted_thinking') {
        if (typeof block.data === 'string' && block.data) {
          accumulatedRedacted.push(block.data);
          reasoningBlocks.push({ text: '', redactedData: block.data });
        }
      }
    }

    const usage = data.usage as Record<string, unknown> | undefined;
    const parsedUsage = this._normalizeUsage(usage);

    return {
      content: accumulatedContent,
      model: this.model,
      usage: parsedUsage,
      toolCalls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
      reasoning: accumulatedReasoning,
      reasoningBlocks: reasoningBlocks.length ? reasoningBlocks : undefined,
      reasoningSignature: accumulatedSignature,
      reasoningRedacted: accumulatedRedacted.length ? accumulatedRedacted : undefined,
      // Причина завершения (`stop_reason`) — нестримовый ответ.
      finishReason: normalizeAnthropicFinishReason(data.stop_reason),
    };
  }

  /**
   * ADR-070 §2.3: у Anthropic `input_tokens` — только некэшированная часть,
   * поэтому нормализованный `inputTokens = input_tokens + cacheRead + cacheWrite`.
   * `totalTokens` считается от нормализованного входа.
   *
   * Reasoning-токены adaptive thinking приходят отдельно —
   * `output_tokens_details.thinking_tokens`, — но **входят** в `output_tokens`
   * (общий бюджет `max_tokens`). Пишем их только когда они есть (`> 0`).
   */
  private _normalizeUsage(usage: Record<string, unknown> | undefined): TokenUsage {
    const cacheReadTokens = usageNumber(usage?.cache_read_input_tokens);
    const cacheWriteTokens = usageNumber(usage?.cache_creation_input_tokens);
    const nonCached = usageNumber(usage?.input_tokens);
    const inputTokens = nonCached + cacheReadTokens + cacheWriteTokens;
    const outputTokens = usageNumber(usage?.output_tokens);
    const details = usage?.output_tokens_details as Record<string, unknown> | undefined;
    const reasoningTokens = usageNumber(details?.thinking_tokens);
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    };
  }

  private _getHeaders(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'Content-Type': 'application/json',
    };
  }

  private _handleErrors(statusCode: number, errorText: string): void {
    if (statusCode === 400) {
      if (errorText.toLowerCase().includes('authentication')) {
        throw new Error(`Anthropic auth error: ${errorText}`);
      }
      if (
        errorText.toLowerCase().includes('context') ||
        errorText.toLowerCase().includes('length') ||
        errorText.toLowerCase().includes('token')
      ) {
        throw new ContextLengthExceededError();
      }
      throw new Error(`Bad request: ${errorText}`);
    }
    if (statusCode === 429) {
      throw new RateLimitError();
    }
    warning('ANTHROPIC', `HTTP ${statusCode}: ${errorText}`);
  }
}
