import type { LLMChunk, LLMResponse, LlmFinishReason, TokenUsage, ResolvedModelCompatibility } from '@itphx/synth-shared';
import {
  BaseProvider,
  resolveProviderCompatibility,
  fetchModelsCatalog,
  parseArchitectureModalities,
  redactAttachmentPayloadForDebug,
  resolveSystemPromptText,
  parseTokenPricing,
  supportsNativeAudio,
  supportsNativeVideo,
  toNonNegativeNumber,
  type DetailedModelInfo,
  type LLMAttachment,
  type LLMMessage,
  type SystemPromptInput,
  type CancellationToken,
  type ChatOptions,
} from './base.js';
import { info, warning } from '../logger.js';
import type { DebugCollector } from '../debug.js';
import { ContextLengthExceededError, ProviderError, RateLimitError } from './exceptions.js';
// ADR-099: запросы провайдера — через единый транспорт доверия TLS/CA.
import { egressFetch } from '../security/tls.js';

/**
 * ADR-117: бюджет `cache_control` breakpoint'ов на запрос (паритет с
 * `BREAKPOINT_CAP` в opencode, `packages/ai/src/cache-policy.ts`).
 */
const MAX_CACHE_BREAKPOINTS = 4;

/** Маркер inline-кэша для провайдера (`cache_control: {type:'ephemeral'}`). */
function ephemeralCacheControl(): Record<string, unknown> {
  return { type: 'ephemeral' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Причина завершения ответа OpenAI-совместимых API (`finish_reason`) → общий
 * словарь. `stop` — естественное завершение, `length` — срез лимитом вывода,
 * `tool_calls`/`function_call` — запрос инструмента, `content_filter` — фильтр
 * провайдера. Незнакомое значение → `unknown`; отсутствие → `undefined`.
 */
const OPENAI_FINISH_REASONS: Record<string, LlmFinishReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'content_filter',
};

export function normalizeOpenAiFinishReason(raw: unknown): LlmFinishReason | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return OPENAI_FINISH_REASONS[raw] ?? 'unknown';
}

/**
 * ADR-117: сколько `cache_control`-маркеров уже стоит в теле запроса
 * (tools + части контента сообщений). Уже стоящие маркеры не дублируются и
 * расходуют бюджет.
 */
function countCacheMarkers(body: Record<string, unknown>): number {
  let count = 0;
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (isRecord(tool) && tool.cache_control !== undefined) count += 1;
    }
  }
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message) || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (isRecord(part) && part.cache_control !== undefined) count += 1;
      }
    }
  }
  return count;
}

/** Тип функции-маркера: ставит `cache_control` на часть, если бюджет не исчерпан. */
type CacheMark = (target: Record<string, unknown>) => boolean;

function createCacheMark(budget: { remaining: number }): CacheMark {
  return (target: Record<string, unknown>): boolean => {
    if (budget.remaining <= 0) return false;
    // Уже стоящий маркер не дублируем и бюджет не тратим.
    if (target.cache_control !== undefined) return false;
    target.cache_control = ephemeralCacheControl();
    budget.remaining -= 1;
    return true;
  };
}

/** Маркер на последнем tool-дефинишне (AUTO-набор, `tools: true`). */
function markLastTool(tools: unknown, mark: CacheMark): void {
  if (!Array.isArray(tools) || tools.length === 0) return;
  const last = tools[tools.length - 1];
  if (isRecord(last)) mark(last);
}

/**
 * Маркеры границ system: первый и последний **различные** блоки (как AUTO в
 * opencode, `markSystemBoundaries`). У нас system обычно одним блоком — тогда
 * ровно один маркер.
 */
function markSystemBoundaries(messages: unknown, mark: CacheMark): void {
  if (!Array.isArray(messages)) return;
  const system = messages.find((message) => isRecord(message) && message.role === 'system') as
    | Record<string, unknown>
    | undefined;
  if (!system) return;
  const parts = system.content;
  if (typeof parts === 'string') {
    if (parts.length === 0) return;
    const part: Record<string, unknown> = { type: 'text', text: parts };
    if (!mark(part)) return;
    system.content = [part];
    return;
  }
  if (!Array.isArray(parts) || parts.length === 0) return;
  const first = parts[0];
  if (isRecord(first)) mark(first);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    // Один и тот же блок дважды не маркируем.
    if (isRecord(last) && last !== first) mark(last);
  }
}

/**
 * Маркер границы последнего сообщения (`messages: {tail: 1}`): последняя
 * текстовая часть, а если её нет — последняя часть контента (tool-result-only
 * сообщение тоже получает breakpoint). Строковый контент разворачивается в
 * массив частей — так маркер и живёт на проводе (`{type:'text', text,
 * cache_control}`).
 */
function markLastMessageBoundary(messages: unknown, mark: CacheMark): void {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (!isRecord(last)) return;
  const content = last.content;

  if (typeof content === 'string') {
    if (content.length === 0) return;
    const part: Record<string, unknown> = { type: 'text', text: content };
    if (!mark(part)) return;
    last.content = [part];
    return;
  }
  if (!Array.isArray(content) || content.length === 0) return;

  let target: Record<string, unknown> | undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (isRecord(part) && part.type === 'text') {
      target = part;
      break;
    }
  }
  if (!target) {
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i];
      if (isRecord(part)) {
        target = part;
        break;
      }
    }
  }
  if (target) mark(target);
}

/**
 * Имя файла для `file`-блока вложения (ADR-115).
 *
 * Значение уходит в JSON-тело запроса, поэтому убираем символы, ломающие
 * подпись/экранирование (`"`, `\`) и переводы строк; пустой результат
 * заменяем на `document.pdf` — у каталога имя необязательно.
 */
function sanitizeAttachmentFileName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/["\\\r\n\t]/g, '').trim();
  return cleaned.length > 0 ? cleaned : 'document.pdf';
}

export class OpenAIProvider extends BaseProvider {
  getProviderName(): string {
    return this.name;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    stream?: boolean,
    debugCollector?: DebugCollector,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    info('OPENAI', `чат: model=${this.model}, сообщений=${messages.length}`);

    const compatibility = this._resolveCompatibility();
    const formattedMessages = this._formatMessages(messages, systemPrompt, compatibility);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
    };
    this._applyTemperature(body);
    if (this.reasoningLevel && this.reasoningLevel !== 'default') body.reasoning_effort = this.reasoningLevel;
    if (this.topP !== undefined) body.top_p = this.topP;
    if (this.topK !== undefined) body.top_k = this.topK;
    if (tools?.length) {
      body.tools = tools;
      // `tool_choice` — только вместе с инструментами (без них часть API
      // отвечает ошибкой); поле задаётся вызывающим слоем (финальный шаг).
      if (options?.toolChoice) body.tool_choice = options.toolChoice;
    }
    if (stream) body.stream = true;
    if (this.maxTokens && this.maxTokens > 0) body[compatibility.maxTokensField] = this.maxTokens;
    this._applyPromptCacheKey(body, systemPrompt, compatibility);
    this._applyInlineCacheMarkers(body, systemPrompt, compatibility);

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
        throw new Error(`OpenAI API error ${resp.status}: ${errorText}`);
      }

      const data = await resp.json() as Record<string, unknown>;
      debugCollector?.captureApiResponse(data);
      debugCollector?.captureRawModelResponse(JSON.stringify(data));

      return this._parseResponse(data);
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
    info('OPENAI', `chatAsync: model=${this.model}, сообщений=${messages.length}`);

    const compatibility = this._resolveCompatibility();
    const formattedMessages = this._formatMessages(messages, systemPrompt, compatibility);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      stream: true,
    };
    // ADR-070 §2.3: просим провайдера прислать usage в стриме — иначе
    // cached_tokens/reasoning_tokens в статистику не попадают. Дефолт —
    // включено (как в opencode); `compatibility.streamUsage: false` — не
    // отправляем (эндпоинт не знает поля), usage тогда остаётся нулевым.
    if (compatibility.streamUsage) body.stream_options = { include_usage: true };
    this._applyTemperature(body);
    if (this.reasoningLevel && this.reasoningLevel !== 'default') body.reasoning_effort = this.reasoningLevel;
    if (this.topP !== undefined) body.top_p = this.topP;
    if (this.topK !== undefined) body.top_k = this.topK;
    if (tools?.length) {
      body.tools = tools;
      // `tool_choice` — только вместе с инструментами (без них часть API
      // отвечает ошибкой); поле задаётся вызывающим слоем (финальный шаг).
      if (options?.toolChoice) body.tool_choice = options.toolChoice;
    }
    if (this.maxTokens && this.maxTokens > 0) body[compatibility.maxTokensField] = this.maxTokens;
    this._applyPromptCacheKey(body, systemPrompt, compatibility);
    this._applyInlineCacheMarkers(body, systemPrompt, compatibility);

    const headers = this._getHeaders();
    if (debugCollector?.enabled) {
      debugCollector.captureApiRequest(this.url, 'POST', headers, redactAttachmentPayloadForDebug(body));
    }

    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let accumulatedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const accumulatedToolCalls: Record<string, unknown>[] = [];
    // ADR-117: `finish_reason` — признак корректного завершения стрима.
    // Провайдер, закрывший соединение без него, отдал недописанный ответ;
    // ловим это после чтения (дефолт — ошибка, `requireFinishReason: false` —
    // прежнее толерантное поведение).
    let finishReasonSeen = false;
    /**
     * Нормализованная причина завершения. Нужна, чтобы отличить «модель ничего
     * не ответила» от «ответ срезан лимитом вывода» (`length` → `max_tokens`).
     */
    let finishReasonValue: LlmFinishReason | undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);

    // Таймаут — только на ожидание первого чанка. Как только стрим пошёл,
    // таймер снимается, дальше стрим длится сколько нужно.
    let firstChunkReceived = false;

    // Кнопка «Стоп»: отмена пользователя (cancellationToken.cancel) немедленно
    // прерывает висящий fetch/reader.read() через AbortController — иначе
    // reader.read() висит до таймаута 120с и отмена не работает.
    if (cancellationToken) {
      const originalCancel = cancellationToken.cancel.bind(cancellationToken);
      cancellationToken.cancel = () => {
        originalCancel();
        controller.abort();
      };
      // ADR-104 (этап 2): прерывание генерации без отмены хода — тот же обрыв
      // сетевого запроса, что и у «Стоп», но токен НЕ помечается отменённым:
      // ход продолжается (оркестратор применяет инъекцию на границе шага).
      const originalInterrupt = cancellationToken.interrupt?.bind(cancellationToken);
      cancellationToken.interrupt = () => {
        originalInterrupt?.();
        controller.abort();
      };
    }

    try {
      let resp: Response;
      try {
        resp = await egressFetch(this.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        // Отмена пользователя — abort() из cancellationToken до/во время fetch:
        // молча завершаем генератор, не превращая в stream.error.
        if (cancellationToken?.cancelled) return;
        throw e;
      }

      if (!resp.ok) {
        const errorText = await resp.text();
        this._handleErrors(resp.status, errorText);
        throw new Error(`OpenAI API error ${resp.status}: ${errorText}`);
      }

      if (!resp.body) throw new Error('Нет тела ответа');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          if (cancellationToken?.cancelled || cancellationToken?.interrupted) {
            reader.cancel();
            break;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') break;

            try {
              const chunkData = JSON.parse(dataStr) as Record<string, unknown>;
              debugCollector?.captureRawModelResponse(dataStr);

              const choices = chunkData.choices as Array<Record<string, unknown>> | undefined;
              const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
              // Пустая строка/`null` завершением не считаются.
              const rawFinishReason = choices?.[0]?.finish_reason;
              if (rawFinishReason) {
                finishReasonSeen = true;
                const normalized = normalizeOpenAiFinishReason(rawFinishReason);
                if (normalized) finishReasonValue = normalized;
              }

              if (delta) {
                // Reasoning приходит в разных форматах: DeepSeek — `reasoning_content`,
                // OpenRouter/RouterAI — `reasoning`; имя поля можно задать явно
                // (`compatibility.reasoningField`). Приоритет — у настроенного
                // поля, затем `reasoning_content`, затем `reasoning`; пустые
                // строки пропускаем.
                const configuredField = compatibility.reasoningField;
                const custom = configuredField !== 'reasoning_content' && configuredField !== 'reasoning'
                  && typeof delta[configuredField] === 'string'
                  ? delta[configuredField] as string
                  : undefined;
                const rc = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined;
                const r = typeof delta.reasoning === 'string' ? delta.reasoning : undefined;
                const reasoningDelta = custom !== undefined && custom !== ''
                  ? custom
                  : rc !== undefined && rc !== '' ? rc : r !== undefined && r !== '' ? r : undefined;
                // DeepSeek-модели иногда шлют служебные '.'/'.\\n' как отдельные
                // reasoning_content-чанки — пропускаем. У поля `reasoning`
                // (OpenRouter/RouterAI) такого фильтра нет: точки там осмысленны.
                const isDeepSeekQuirk = rc !== undefined && (rc === '.' || rc === '.\n');
                if (reasoningDelta !== undefined && !isDeepSeekQuirk) {
                  if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    clearTimeout(timer);
                  }
                  accumulatedReasoning += reasoningDelta;
                  yield {
                    content: '',
                    isFinal: false,
                    usage: accumulatedUsage,
                    reasoning: accumulatedReasoning,
                  };
                }

                if (delta.content && typeof delta.content === 'string') {
                  if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    clearTimeout(timer);
                  }
                  accumulatedContent += delta.content;
                  yield {
                    content: delta.content,
                    isFinal: false,
                    usage: accumulatedUsage,
                    toolCalls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
                    reasoning: accumulatedReasoning || undefined,
                  };
                }

                if (delta.tool_calls) {
                  if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    clearTimeout(timer);
                  }
                  for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
                    const tcIndex = tc.index as number;
                    const func = tc.function as Record<string, unknown> | undefined;
                    const existing = accumulatedToolCalls.find(
                      (t) => (t.index as number) === tcIndex,
                    );
                    if (existing) {
                      const ef = existing.function as Record<string, unknown>;
                      if (func?.name) ef.name = func.name;
                      ef.arguments = String(ef.arguments || '') + String(func?.arguments || '');
                    } else {
                      accumulatedToolCalls.push({
                        index: tcIndex,
                        id: tc.id,
                        type: 'function',
                        function: {
                          name: func?.name || '',
                          arguments: func?.arguments || '',
                        },
                      });
                    }
                  }
                }
              }

              if (chunkData.usage) {
                accumulatedUsage = this._parseUsage(chunkData.usage as Record<string, unknown>);
              }
            } catch {
              continue;
            }
          }
        }
      } catch (e) {
        // Ошибки чтения стрима (таймаут/обрыв сети/AbortError) пробрасываем
        // наружу — иначе генератор «успешно» завершится с пустым ответом и
        // оркестратор не узнает о сбое провайдера. При пользовательской
        // отмене (cancellationToken) и при прерывании генерации (ADR-104)
        // молча выходим.
        if (!cancellationToken?.cancelled && !cancellationToken?.interrupted) {
          info('OPENAI', `Стрим прерван: ${e}`);
          throw e;
        }
      } finally {
        reader.releaseLock();
      }

      if (!cancellationToken?.cancelled && !cancellationToken?.interrupted) {
        // ADR-117: стрим закончился без `finish_reason` — incomplete-stream.
        // `ProviderError` + `finish_reason` в тексте: `classifyLlmError`/
        // `isLlmErrorRecoverable` относят это к невосстановимым ошибкам
        // (повтор не поможет — провайдер недописал ответ), транспортные
        // ошибки (network/timeout/rate_limit) по-прежнему ретраятся.
        if (compatibility.requireFinishReason && !finishReasonSeen) {
          throw new ProviderError(
            `Провайдер закрыл стрим без finish_reason (model=${this.model})`,
            this.name,
          );
        }

        debugCollector?.captureApiResponse({
          usage: accumulatedUsage,
          model: this.model,
          finish_reason: finishReasonValue ?? null,
          tool_calls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
        });

        const finalContent = accumulatedContent || '';
        yield {
          content: finalContent,
          isFinal: true,
          usage: accumulatedUsage,
          toolCalls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
          reasoning: accumulatedReasoning || undefined,
          model: this.model,
          finishReason: finishReasonValue,
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(): Promise<string[]> {
    const models = await fetchModelsCatalog(this._modelsUrl(), this._getHeaders());
    return models
      .map((m) => (typeof m.id === 'string' ? m.id : String(m.id ?? '')))
      .filter(Boolean);
  }

  /**
   * Список моделей с метаданными (RouterAI/OpenRouter-совместимый каталог):
   * `context_length` → contextWindow, `pricing`/`pricing_units` → цены за 1M
   * токенов (только токенные тарифы). Официальный OpenAI каталог цен и окна
   * не отдаёт — тогда вернётся только `{ id }`.
   */
  async listModelsDetailed(): Promise<DetailedModelInfo[]> {
    const models = await fetchModelsCatalog(this._modelsUrl(), this._getHeaders());
    return models.map((m) => this._parseModel(m)).filter((m) => m.id);
  }

  private _modelsUrl(): string {
    const baseUrl = this.url.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
    return `${baseUrl}/models`;
  }

  private _parseModel(raw: Record<string, unknown>): DetailedModelInfo {
    const id = typeof raw.id === 'string' ? raw.id : String(raw.id ?? '');
    const result: DetailedModelInfo = { id };
    if (!id) return result;

    if (typeof raw.name === 'string' && raw.name) result.name = raw.name;

    const contextWindow = toNonNegativeNumber(raw.context_length);
    if (contextWindow !== undefined && contextWindow > 0) result.contextWindow = contextWindow;

    // ADR-115: модальности входа из каталога провайдера.
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
   * Итоговая совместимость провайдера: явный `compatibility` (provider+model)
   * → shorthand `requiresReasoning` → эвристики opencode (deepseek/mistral).
   */
  private _resolveCompatibility(): ResolvedModelCompatibility {
    return resolveProviderCompatibility({
      type: this.type,
      name: this.name,
      url: this.url,
      model: this.model,
      compatibility: this.compatibility,
      requiresReasoning: this.requiresReasoning,
    });
  }

  private _formatMessages(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    compatibility: ResolvedModelCompatibility = this._resolveCompatibility(),
  ): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];

    // DeepSeek thinking-модели требуют поле reasoning у **каждого**
    // assistant-сообщения, даже если reasoning пуст (иначе 400 «The
    // `reasoning_content` in the thinking mode must be passed back»).
    // Имя поля — `compatibility.reasoningField` (по умолчанию
    // `reasoning_content`), требование — `requireReasoning`; порядок резолва:
    // явное модели → явное провайдера → эвристика (deepseek).
    const { reasoningField, requireReasoning, requireAssistantAfterTool } = compatibility;

    const systemText = resolveSystemPromptText(systemPrompt);
    if (systemText) {
      formatted.push({
        role: 'system',
        content: [{ type: 'text', text: systemText }],
      });
    }

    for (const msg of messages) {
      if (msg.disabled) continue;
      if (msg.role === 'info' || msg.role === 'model') continue;

      // Mistral-семейство: между tool-результатами и следующим user-сообщением
      // обязателен assistant-турн (opencode `bridgeTools`). Вставка идёт
      // **после** tool-результата, поэтому пары `tool_calls`/`tool_call_id`
      // не рвутся.
      if (requireAssistantAfterTool && msg.role === 'user' && formatted.at(-1)?.role === 'tool') {
        formatted.push({ role: 'assistant', content: 'Done.' });
      }

      const entry: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };

      // ADR-115: вложения — content становится массивом частей. Если
      // кодируемых у OpenAI частей нет (модальности отфильтрованы выше или тип
      // не маппится), остаётся прежняя строка — текстовый путь не меняется.
      const mediaParts = this._mediaContentParts(msg.attachments);
      if (mediaParts.length > 0) {
        entry.content = [
          ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
          ...mediaParts,
        ];
      }

      if (msg.toolUse) {
        // Нормализация function.arguments: объект → JSON-строка. OpenAI-совместимые
        // API (DeepSeek через open-webui) требуют строку и возвращают 400
        // «invalid type: map, expected a string» на объекте. Строку не трогаем,
        // невалидное/undefined оставляем как есть — запрос не роняем.
        entry.tool_calls = msg.toolUse.map((tc) => {
          const fn = tc.function as Record<string, unknown> | undefined;
          if (!fn || typeof fn.arguments !== 'object' || fn.arguments === null) return tc;
          try {
            return {
              ...tc,
              function: { ...fn, arguments: JSON.stringify(fn.arguments) },
            };
          } catch {
            return tc;
          }
        });
      }
      if (msg.toolCallId) entry.tool_call_id = msg.toolCallId;

      // DeepSeek reasoning-модели требуют возврат reasoning в повторной
      // истории (иначе 400 «The reasoning_content ... must be passed back»).
      // При `requireReasoning` поле отправляется всегда — пустой строкой, если
      // reasoning нет (opencode: `reasoning.length === 0 → requireReasoning ? '' : undefined`).
      // Имя поля — из `compatibility.reasoningField` (не только DeepSeek:
      // OpenRouter/RouterAI — `reasoning`).
      if (msg.role === 'assistant') {
        const rc = msg.reasoning ?? (requireReasoning ? '' : undefined);
        if (rc !== undefined) entry[reasoningField] = rc;
      }

      formatted.push(entry);
    }

    // История закончилась tool-результатом — замыкаем assistant-турном
    // (Mistral-семейство не принимает ответ, начинающийся с tool).
    if (requireAssistantAfterTool && formatted.at(-1)?.role === 'tool') {
      formatted.push({ role: 'assistant', content: 'Done.' });
    }

    return formatted;
  }

  /**
   * ADR-115: части контента OpenAI для вложений.
   *
   *  - `image/*` → `{type:'image_url', image_url:{url:'data:<mime>;base64,…'}}`;
   *  - `video/*` (RouterAI) → `{type:'video_url', video_url:{url:'data:<mime>;base64,…'}}`
   *    (проверено: модель видит и слышит ролик);
   *  - `application/pdf` → `{type:'file', file:{filename, file_data:'data:application/pdf;base64,…'}}`
   *    (формат OpenAI-совместимых API; RouterAI принимает так PDF и читает документ);
   *  - `audio/wav` (в т.ч. `audio/x-wav`) → `input_audio` c `format:'wav'`;
   *  - `audio/mpeg`/`audio/mp3` → `input_audio` c `format:'mp3'`;
   *  - `audio/ogg`/`audio/opus`/`audio/oga` → `input_audio` c `format:'ogg'`
   *    (расширение RouterAI; официальный OpenAI знает только wav/mp3,
   *    поэтому формат отправляется только для RouterAI);
   *  - прочие типы не отправляются — плейсхолдер уже в тексте.
   *
   * Фильтра по справочнику модальностей здесь **нет** (ADR-115): провайдер
   * кодирует всё, что ему передали, и пропускает только типы, которые
   * физически не умеет кодировать. Модальности фильтруются выше — гидратация
   * (`hydrateMessageAttachments` + `ModelConfig.modalities`/`resolveModelModalities`);
   * второй фильтр по неполному справочнику отбрасывал валидные вложения
   * (например, vision-модель каталога, которой в справочнике нет).
   */
  private _mediaContentParts(attachments: LLMAttachment[] | undefined): Array<Record<string, unknown>> {
    const parts: Array<Record<string, unknown>> = [];
    for (const attachment of attachments ?? []) {
      const mime = attachment.mime.toLowerCase();
      if (mime.startsWith('image/')) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${attachment.mime};base64,${attachment.base64}` },
        });
        continue;
      }
      if (mime === 'application/pdf') {
        // PDF — отдельным `file`-блоком с data-URL: RouterAI (OpenAI-тип)
        // принимает документ только так, иначе вложение теряется на провайдере.
        parts.push({
          type: 'file',
          file: {
            filename: sanitizeAttachmentFileName(attachment.name),
            file_data: `data:application/pdf;base64,${attachment.base64}`,
          },
        });
        continue;
      }
      if (mime.startsWith('video/') && supportsNativeVideo('openai', this.url)) {
        // RouterAI принимает видео как `video_url` (data-URL); официальный
        // OpenAI/Anthropic такого блока не знают — там видео идёт кадрами.
        parts.push({
          type: 'video_url',
          video_url: { url: `data:${attachment.mime};base64,${attachment.base64}` },
        });
        continue;
      }
      if (mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave') {
        parts.push({
          type: 'input_audio',
          input_audio: { data: attachment.base64, format: 'wav' },
        });
        continue;
      }
      if (mime === 'audio/mpeg' || mime === 'audio/mp3') {
        parts.push({
          type: 'input_audio',
          input_audio: { data: attachment.base64, format: 'mp3' },
        });
        continue;
      }
      if (supportsNativeAudio('openai', this.url, mime)) {
        // Голосовые Telegram — ogg/opus; RouterAI принимает их как
        // `input_audio` с форматом `ogg` (проверено), официальный OpenAI — нет.
        parts.push({
          type: 'input_audio',
          input_audio: { data: attachment.base64, format: 'ogg' },
        });
      }
    }
    return parts;
  }

  /**
   * ADR-070 §2.2: OpenAI не поддерживает явный cache_control — используется
   * implicit prefix caching через `prompt_cache_key` (стабильный id сессии).
   * При `cachePolicy: 'none'` ключ не отправляется.
   *
   * ADR-117: при заданном `compatibility.cacheFormat` ключ **не отправляется** —
   * провайдер ориентирован на inline-маркеры (`_applyInlineCacheMarkers`), а
   * это разные механизмы (как в opencode).
   */
  private _applyPromptCacheKey(
    body: Record<string, unknown>,
    systemPrompt?: SystemPromptInput,
    compatibility: ResolvedModelCompatibility = this._resolveCompatibility(),
  ): void {
    if (compatibility.cacheFormat) return;
    if (typeof systemPrompt !== 'object' || systemPrompt === null) return;
    if (systemPrompt.cachePolicy === 'none') return;
    if (systemPrompt.cacheKey) body.prompt_cache_key = systemPrompt.cacheKey;
  }

  /**
   * ADR-117: inline-маркеры prompt-cache (`cache_control: {type:'ephemeral'}`)
   * для OpenAI-совместимых провайдеров, которые кешируют только по явным
   * маркерам. Набор задаётся данными — `compatibility.cacheFormat`:
   *
   *  - `anthropic` — как AUTO в opencode: последний tool-дефинишн, границы
   *    system и граница последнего сообщения (`tail: 1`);
   *  - `alibaba` — как QWEN в opencode: system и граница последнего сообщения,
   *    **без** маркера на tools (Qwen кеширует tools вместе с system-промптом).
   *
   * Бюджет — не больше `MAX_CACHE_BREAKPOINTS` на запрос; уже стоящие маркеры
   * не дублируются и учитываются. `cachePolicy: 'none'` — ни одного маркера.
   * Без `cacheFormat` метод ничего не делает: поведение прежних провайдеров
   * (в т.ч. system-контент частями, который ждут не все эндпоинты) не меняется.
   */
  private _applyInlineCacheMarkers(
    body: Record<string, unknown>,
    systemPrompt: SystemPromptInput | undefined,
    compatibility: ResolvedModelCompatibility = this._resolveCompatibility(),
  ): void {
    const format = compatibility.cacheFormat;
    if (!format) return;
    const payload = typeof systemPrompt === 'object' && systemPrompt !== null ? systemPrompt : undefined;
    if (payload?.cachePolicy === 'none') return;

    const budget = { remaining: MAX_CACHE_BREAKPOINTS - countCacheMarkers(body) };
    if (budget.remaining <= 0) return;
    const mark = createCacheMark(budget);

    if (format === 'anthropic') markLastTool(body.tools, mark);
    markSystemBoundaries(body.messages, mark);
    markLastMessageBoundary(body.messages, mark);
  }

  private _getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private _parseResponse(data: Record<string, unknown>): LLMResponse {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = String(message?.content ?? '');
    const toolCalls = message?.tool_calls as Record<string, unknown>[] | undefined;
    // Настроенное поле (`compatibility.reasoningField`), затем
    // `reasoning_content` (DeepSeek) и `reasoning` (OpenRouter/RouterAI).
    const reasoningField = this._resolveCompatibility().reasoningField;
    const reasoning = (message?.[reasoningField] ?? message?.reasoning_content ?? message?.reasoning) as string | undefined;

    return {
      content,
      model: this.model,
      usage: this._parseUsage(data.usage as Record<string, unknown> | undefined),
      toolCalls,
      reasoning: reasoning || undefined,
      // Причина завершения (`finish_reason`) — нестримовый ответ.
      finishReason: normalizeOpenAiFinishReason(choices?.[0]?.finish_reason),
    };
  }

  /**
   * ADR-070 §2.3: нормализация OpenAI usage. `prompt_tokens` уже включает
   * кэшированные токены; `prompt_tokens_details.cached_tokens` → cacheRead,
   * `nonCached = prompt_tokens − cached_tokens` вычисляется потребителем.
   * Явных cache write у OpenAI нет — 0.
   */
  private _parseUsage(usage?: Record<string, unknown>): TokenUsage {
    if (!usage) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    }
    const completionDetails = usage.completion_tokens_details as Record<string, number> | undefined;
    const promptDetails = usage.prompt_tokens_details as Record<string, number> | undefined;
    return {
      inputTokens: (usage.prompt_tokens as number) || 0,
      outputTokens: (usage.completion_tokens as number) || 0,
      totalTokens: (usage.total_tokens as number) || 0,
      cacheReadTokens: promptDetails?.cached_tokens || 0,
      cacheWriteTokens: 0,
      reasoningTokens: completionDetails?.reasoning_tokens || 0,
    };
  }

  private _handleErrors(statusCode: number, errorText: string): void {
    if (statusCode === 400) {
      const lower = errorText.toLowerCase();
      if (lower.includes('context') || lower.includes('length') || lower.includes('token')) {
        throw new ContextLengthExceededError();
      }
      throw new Error(`Bad request: ${errorText}`);
    }
    if (statusCode === 429) {
      throw new RateLimitError();
    }
    warning('OPENAI', `HTTP ${statusCode}: ${errorText}`);
  }
}
