import type { LLMChunk, LLMResponse, TokenUsage } from '@itphx/synth-shared';
import {
  BaseProvider,
  fetchModelsCatalog,
  resolveSystemPromptText,
  parseTokenPricing,
  toNonNegativeNumber,
  type DetailedModelInfo,
  type LLMMessage,
  type SystemPromptInput,
  type CachePolicy,
  type CancellationToken,
} from './base.js';
import { info, warning } from '../logger.js';
import type { DebugCollector } from '../debug.js';
import { ProviderError, ContextLengthExceededError, RateLimitError } from './exceptions.js';

const ANTHROPIC_API_VERSION = '2023-06-01';

/** AD-070 §2.2: бюджет cache_control breakpoint'ов на запрос. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * AD-071 §2.1: индекс инструмента для tools-брейкпоинта.
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
   *    токенов (только токенные тарифы).
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

    const parsed = parseTokenPricing(
      raw.pricing as Record<string, unknown> | undefined,
      raw.pricing_units as Record<string, unknown> | undefined,
    );
    if (parsed) Object.assign(result, parsed);

    return result;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    stream?: boolean,
    debugCollector?: DebugCollector,
  ): Promise<LLMResponse> {
    const formattedMessages = this._formatMessages(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      temperature: this.temperature,
      max_tokens: this.maxTokens ?? 4096,
    };
    if (this.reasoningLevel === 'high') body.thinking = { type: 'enabled', budget_tokens: 8192 };
    else if (this.reasoningLevel === 'none') body.thinking = { type: 'disabled' };
    if (this.topP !== undefined) body.top_p = this.topP;
    const systemBlocks = this._buildSystemBlocks(systemPrompt);
    if (systemBlocks.length) body.system = systemBlocks;
    if (tools?.length) body.tools = this._formatTools(tools);
    if (stream) body.stream = true;
    this._applyCacheControl(body, systemPrompt);

    const headers = this._getHeaders();
    debugCollector?.captureApiRequest(this.url, 'POST', headers, body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);

    try {
      const resp = await fetch(this.url, {
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
  ): AsyncGenerator<LLMChunk> {
    const formattedMessages = this._formatMessages(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      temperature: this.temperature,
      max_tokens: this.maxTokens ?? 4096,
      stream: true,
    };
    if (this.reasoningLevel === 'high') body.thinking = { type: 'enabled', budget_tokens: 8192 };
    else if (this.reasoningLevel === 'none') body.thinking = { type: 'disabled' };
    if (this.topP !== undefined) body.top_p = this.topP;
    const systemBlocks = this._buildSystemBlocks(systemPrompt);
    if (systemBlocks.length) body.system = systemBlocks;
    if (tools?.length) body.tools = this._formatTools(tools);
    this._applyCacheControl(body, systemPrompt);

    const headers = this._getHeaders();
    debugCollector?.captureApiRequest(this.url, 'POST', headers, body);

    info('ANTHROPIC', `чатAsync: url=${this.url}, model=${this.model}`);

    let accumulatedReasoning = '';
    let accumulatedContent = '';
    let accumulatedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const accumulatedToolCalls: Record<string, unknown>[] = [];
    const toolCallByBlockIndex = new Map<number, number>();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);

    // Таймаут — только на ожидание первого чанка. Как только стрим пошёл,
    // таймер снимается, дальше стрим длится сколько нужно.
    let firstChunkReceived = false;

    try {
      const resp = await fetch(this.url, {
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
          if (cancellationToken?.cancelled) {
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
                if (block?.type === 'thinking' || block?.type === 'tool_use') {
                  if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    clearTimeout(timer);
                  }
                }
                if (block?.type === 'thinking') {
                  accumulatedReasoning = '';
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
                    yield {
                      content: '',
                      isFinal: false,
                      usage: accumulatedUsage,
                      reasoning: accumulatedReasoning,
                    };
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
                const usage = message?.usage as Record<string, number> | undefined;
                if (usage) accumulatedUsage = this._normalizeUsage(usage);
              }

              if (eventType === 'message_delta') {
                const usage = chunkData.usage as Record<string, number> | undefined;
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
                  });
                }
              }

              if (eventType === 'message_stop') break;
            } catch (e) {
              // Ошибка API, пришедшая data-чанком ({code,message} / type:error),
              // должна дойти до оркестратора, а не превратиться в пустой ответ
              // (AD-041). Невалидный JSON по-прежнему пропускаем.
              if (e instanceof ProviderError) throw e;
              continue;
            }
          }
        }
      } catch (e) {
        // Ошибка API (ProviderError) должна дойти до оркестратора и не
        // превратиться в пустой ответ (AD-041); прочие обрывы стрима логируем.
        if (e instanceof ProviderError) throw e;
        info('ANTHROPIC', `Стрим прерван: ${e}`);
      } finally {
        reader.releaseLock();
      }

      if (!cancellationToken?.cancelled) {
        debugCollector?.captureApiResponse({
          usage: accumulatedUsage,
          model: this.model,
          tool_calls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
        });

        yield {
          content: accumulatedContent,
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

  private _formatMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
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
        content: [{ type: 'text', text: msg.content }],
      });
    }

    flushToolResults();
    return formatted;
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
   * ответ модели (AD-041). Возвращает текст ошибки или null.
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
   * AD-070 §2.2: `body.system` — массив блоков. Если задан `stablePrefix` и он
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
   * AD-070 §2.2: расстановка `cache_control: {type:'ephemeral'}` после
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

    // Приоритет 1: граница stable-слоя инструментов. AD-071 §2.1: встроенные
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
        debugCollector?.captureReasoning(accumulatedReasoning);
      }
    }

    const usage = data.usage as Record<string, number> | undefined;
    const parsedUsage = this._normalizeUsage(usage);

    return {
      content: accumulatedContent,
      model: this.model,
      usage: parsedUsage,
      toolCalls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
      reasoning: accumulatedReasoning,
    };
  }

  /**
   * AD-070 §2.3: у Anthropic `input_tokens` — только некэшированная часть,
   * поэтому нормализованный `inputTokens = input_tokens + cacheRead + cacheWrite`.
   * `totalTokens` считается от нормализованного входа.
   */
  private _normalizeUsage(usage: Record<string, number> | undefined): TokenUsage {
    const cacheReadTokens = usage?.cache_read_input_tokens || 0;
    const cacheWriteTokens = usage?.cache_creation_input_tokens || 0;
    const nonCached = usage?.input_tokens || 0;
    const inputTokens = nonCached + cacheReadTokens + cacheWriteTokens;
    const outputTokens = usage?.output_tokens || 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
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
