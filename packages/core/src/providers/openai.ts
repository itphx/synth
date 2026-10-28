import type { LLMChunk, LLMResponse, TokenUsage } from '@itphx/synth-shared';
import {
  BaseProvider,
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
} from './base.js';
import { info, warning } from '../logger.js';
import type { DebugCollector } from '../debug.js';
import { ContextLengthExceededError, RateLimitError } from './exceptions.js';
// ADR-099: запросы провайдера — через единый транспорт доверия TLS/CA.
import { egressFetch } from '../security/tls.js';

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
  ): Promise<LLMResponse> {
    info('OPENAI', `чат: model=${this.model}, сообщений=${messages.length}`);

    const formattedMessages = this._formatMessages(messages, systemPrompt);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      temperature: this.temperature,
    };
    if (this.reasoningLevel && this.reasoningLevel !== 'default') body.reasoning_effort = this.reasoningLevel;
    if (this.topP !== undefined) body.top_p = this.topP;
    if (this.topK !== undefined) body.top_k = this.topK;
    if (tools?.length) body.tools = tools;
    if (stream) body.stream = true;
    if (this.maxTokens && this.maxTokens > 0) body.max_tokens = this.maxTokens;
    this._applyPromptCacheKey(body, systemPrompt);

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
  ): AsyncGenerator<LLMChunk> {
    info('OPENAI', `чатAsync: model=${this.model}, сообщений=${messages.length}`);

    const formattedMessages = this._formatMessages(messages, systemPrompt);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      temperature: this.temperature,
      stream: true,
      // ADR-070 §2.3: просим провайдера прислать usage в стриме — иначе
      // cached_tokens/reasoning_tokens в статистику не попадают.
      stream_options: { include_usage: true },
    };
    if (this.reasoningLevel && this.reasoningLevel !== 'default') body.reasoning_effort = this.reasoningLevel;
    if (this.topP !== undefined) body.top_p = this.topP;
    if (this.topK !== undefined) body.top_k = this.topK;
    if (tools?.length) body.tools = tools;
    if (this.maxTokens && this.maxTokens > 0) body.max_tokens = this.maxTokens;
    this._applyPromptCacheKey(body, systemPrompt);

    const headers = this._getHeaders();
    if (debugCollector?.enabled) {
      debugCollector.captureApiRequest(this.url, 'POST', headers, redactAttachmentPayloadForDebug(body));
    }

    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let accumulatedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const accumulatedToolCalls: Record<string, unknown>[] = [];

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

              if (delta) {
                // Reasoning приходит в разных форматах: DeepSeek — `reasoning_content`,
                // OpenRouter/RouterAI — `reasoning`. Приоритет у `reasoning_content`
                // (текущее поведение DeepSeek/itphx), пустые строки пропускаем.
                const rc = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined;
                const r = typeof delta.reasoning === 'string' ? delta.reasoning : undefined;
                const reasoningDelta = rc !== undefined && rc !== '' ? rc : r !== undefined && r !== '' ? r : undefined;
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
        debugCollector?.captureApiResponse({
          usage: accumulatedUsage,
          model: this.model,
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

  private _formatMessages(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
  ): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];

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

      // DeepSeek reasoning-модели требуют возврат reasoning_content в повторной
      // истории (иначе 400 «The reasoning_content ... must be passed back»).
      if (msg.role === 'assistant' && msg.reasoning) {
        entry.reasoning_content = msg.reasoning;
      }

      formatted.push(entry);
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
   */
  private _applyPromptCacheKey(body: Record<string, unknown>, systemPrompt?: SystemPromptInput): void {
    if (typeof systemPrompt !== 'object' || systemPrompt === null) return;
    if (systemPrompt.cachePolicy === 'none') return;
    if (systemPrompt.cacheKey) body.prompt_cache_key = systemPrompt.cacheKey;
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
    // `reasoning_content` (DeepSeek) либо `reasoning` (OpenRouter/RouterAI).
    const reasoning = (message?.reasoning_content ?? message?.reasoning) as string | undefined;

    return {
      content,
      model: this.model,
      usage: this._parseUsage(data.usage as Record<string, unknown> | undefined),
      toolCalls,
      reasoning: reasoning || undefined,
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
