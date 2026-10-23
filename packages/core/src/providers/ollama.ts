import type { LLMChunk, LLMResponse, TokenUsage } from '@itphx/synth-shared';
import {
  BaseProvider,
  resolveSystemPromptText,
  toNonNegativeNumber,
  type DetailedModelInfo,
  type LLMMessage,
  type SystemPromptInput,
  type CancellationToken,
} from './base.js';
import { info, warning } from '../logger.js';
import type { DebugCollector } from '../debug.js';
import { ContextLengthExceededError, RateLimitError } from './exceptions.js';
// ADR-099: запросы к Ollama — через единый транспорт доверия TLS/CA.
import { egressFetch } from '../security/tls.js';

/** Максимум best-effort POST /api/show за один синк (первые N моделей). */
const MAX_CONTEXT_PROBES = 50;

/** Размер батча параллельных проб контекста (чтобы не заваливать Ollama). */
const CONTEXT_PROBE_BATCH_SIZE = 6;

/** Общий дедлайн fallback-проб контекста, мс — ограничивает серию батчей. */
const CONTEXT_PROBE_DEADLINE_MS = 20_000;

export class OllamaProvider extends BaseProvider {
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
    const formattedMessages = this._formatMessages(messages);
    // Ollama /api/chat игнорирует top-level `system` (это поле есть только у
    // /api/generate) — системный промпт обязан идти первым сообщением с
    // role:'system', иначе он молча теряется целиком (роль, инструкции, режим).
    const systemText = resolveSystemPromptText(systemPrompt);
    if (systemText) formattedMessages.unshift({ role: 'system', content: systemText });
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      temperature: this.temperature,
      stream: !!stream,
    };
    if (this.reasoningLevel === 'low') body.think = true;
    else if (this.reasoningLevel === 'none') body.think = false;
    if (tools?.length) body.tools = this._formatTools(tools);
    if (this.numCtx && this.numCtx > 0) body.options = { num_ctx: this.numCtx };

    const headers = { 'Content-Type': 'application/json' };
    debugCollector?.captureApiRequest(this.url, 'POST', headers, body);

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
        throw new Error(`Ollama API error ${resp.status}: ${errorText}`);
      }

      const data = await resp.json() as Record<string, unknown>;
      debugCollector?.captureApiResponse(data);
      debugCollector?.captureRawModelResponse(JSON.stringify(data));

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
    // Ollama /api/chat игнорирует top-level `system` (см. chat()) — промпт
    // уходит первым сообщением role:'system', одним ведущим system-ходом.
    const systemText = resolveSystemPromptText(systemPrompt);
    if (systemText) formattedMessages.unshift({ role: 'system', content: systemText });
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      temperature: this.temperature,
      stream: true,
    };
    if (this.reasoningLevel === 'low') body.think = true;
    else if (this.reasoningLevel === 'none') body.think = false;
    if (tools?.length) body.tools = this._formatTools(tools);
    if (this.numCtx && this.numCtx > 0) body.options = { num_ctx: this.numCtx };

    const headers = { 'Content-Type': 'application/json' };
    debugCollector?.captureApiRequest(this.url, 'POST', headers, body);

    let accumulatedReasoning = '';
    let accumulatedContent = '';
    // ADR-070 §2.3: у Ollama cache-полей нет — cacheRead/cacheWrite = 0.
    const accumulatedUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
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
        if (cancellationToken?.cancelled || cancellationToken?.interrupted) return;
        throw e;
      }

      if (!resp.ok) {
        const errorText = await resp.text();
        this._handleErrors(resp.status, errorText);
        throw new Error(`Ollama API error ${resp.status}: ${errorText}`);
      }

      if (!resp.body) throw new Error('Нет тела ответа');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          if (cancellationToken?.cancelled || cancellationToken?.interrupted) {
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

            try {
              const chunkData = JSON.parse(trimmed) as Record<string, unknown>;
              debugCollector?.captureRawModelResponse(trimmed);

              const msg = chunkData.message as Record<string, unknown> | undefined;

              // ADR-070: накапливаем usage ДО yield'ов, иначе чанк уносит
              // предыдущее (устаревшее) значение, а актуальное попадёт только
              // в следующий чанк/финал. Семантика — running total.
              if (typeof chunkData.prompt_eval_count === 'number') {
                accumulatedUsage.inputTokens += chunkData.prompt_eval_count;
              }
              if (typeof chunkData.eval_count === 'number') {
                accumulatedUsage.outputTokens += chunkData.eval_count;
              }
              accumulatedUsage.totalTokens =
                accumulatedUsage.inputTokens + accumulatedUsage.outputTokens;

              if (msg?.content && typeof msg.content === 'string') {
                if (!firstChunkReceived) {
                  firstChunkReceived = true;
                  clearTimeout(timer);
                }
                const hasReasoning = !!accumulatedReasoning;
                accumulatedContent += msg.content;
                yield {
                  content: msg.content,
                  isFinal: false,
                  usage: accumulatedUsage,
                  toolCalls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
                  reasoning: hasReasoning ? accumulatedReasoning : undefined,
                };
                if (hasReasoning) accumulatedReasoning = '';
              }

              if (msg?.tool_calls) {
                if (!firstChunkReceived) {
                  firstChunkReceived = true;
                  clearTimeout(timer);
                }
                for (const tc of msg.tool_calls as Record<string, unknown>[]) {
                  accumulatedToolCalls.push({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: (tc.function as Record<string, unknown>)?.name,
                      // Строку → объект: единообразие с _parseResponse.
                      arguments: this._normalizeToolArguments(
                        (tc.function as Record<string, unknown>)?.arguments,
                      ),
                    },
                  });
                }
              }

              if (msg?.thinking && typeof msg.thinking === 'string') {
                if (!firstChunkReceived) {
                  firstChunkReceived = true;
                  clearTimeout(timer);
                }
                accumulatedReasoning += msg.thinking;
                debugCollector?.captureReasoning(accumulatedReasoning);
                yield {
                  content: '',
                  isFinal: false,
                  usage: accumulatedUsage,
                  reasoning: accumulatedReasoning || undefined,
                };
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
          info('OLLAMA', `Стрим прерван: ${e}`);
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

  async embed(text: string): Promise<number[]> {
    const baseUrl = this.url.replace(/\/api\/chat\/?$/, '').replace(/\/v1\/?$/, '');
    // Имя модели без префикса local. — Ollama знает модель без него
    const ollamaModel = this.model.startsWith('local.') ? this.model.slice('local.'.length) : this.model;

    // Формат 1: новый /api/embed с полем input → embeddings[0]
    try {
      const resp = await egressFetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, input: text }),
        signal: AbortSignal.timeout(this.timeout * 1000),
      });
      if (resp.ok) {
        const data = await resp.json() as { embeddings?: number[][] };
        if (data.embeddings?.[0]?.length) return data.embeddings[0];
      }
    } catch {
      // fallback
    }

    // Формат 2: старый /api/embeddings с полем prompt → embedding
    const resp2 = await egressFetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaModel, prompt: text }),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });
    if (!resp2.ok) throw new Error(`Ollama embeddings error ${resp2.status}`);
    const data2 = await resp2.json() as { embedding?: number[] };
    return data2.embedding ?? [];
  }

  async listModels(): Promise<string[]> {
    const models = await this.listModelsDetailed();
    return models.map((m) => m.id);
  }

  /**
   * Список моделей из /api/tags: контекстное окно (details.context_length /
   * model_info), а также метаданные (размер, параметры, квантизация,
   * capabilities). Если окно из tags не определено — best-effort POST
   * /api/show {model} и `model_info["<arch>.context_length"]`. Пробы идут
   * батчами параллельно, ограничены первыми MAX_CONTEXT_PROBES моделями,
   * имеют общий дедлайн и не роняют синк при ошибках.
   */
  async listModelsDetailed(): Promise<DetailedModelInfo[]> {
    const baseUrl = this.url.replace('/api/chat', '').replace('/v1/chat/completions', '');
    const tagsUrl = `${baseUrl}/api/tags`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    let models: DetailedModelInfo[] | undefined;
    try {
      const resp = await egressFetch(tagsUrl, { signal: controller.signal });

      if (resp.ok) {
        const data = await resp.json() as {
          models?: Array<{
            name: string;
            size?: number;
            details?: {
              context_length?: number;
              parameter_size?: string;
              quantization_level?: string;
            };
            model_info?: Record<string, unknown>;
            capabilities?: unknown;
          }>;
        };

        models = (data.models || [])
          .map((m) => this._parseTagModel(m))
          .filter((m) => m.id);
      }
    } catch {
      // fall through
    } finally {
      clearTimeout(timer);
    }

    if (!models) return [];

    // Fallback-пробы контекста: только пока окно неизвестно и в пределах
    // первых MAX_CONTEXT_PROBES моделей.
    await this._probeContextWindows(models, baseUrl);

    return models;
  }

  /**
   * Best-effort дозапрос контекстных окон через POST /api/show.
   *
   * Пробы идут батчами по CONTEXT_PROBE_BATCH_SIZE параллельно
   * (`Promise.allSettled`), только для моделей без уже известного окна и не
   * более чем для первых MAX_CONTEXT_PROBES моделей. Результаты раскладываются
   * по исходным индексам — порядок и детерминизм моделей сохраняются. Общий
   * дедлайн ограничивает длительность всей серии проб.
   */
  private async _probeContextWindows(
    models: DetailedModelInfo[],
    baseUrl: string,
  ): Promise<void> {
    const candidates: number[] = [];
    for (let i = 0; i < models.length && i < MAX_CONTEXT_PROBES; i++) {
      if (models[i]!.contextWindow === undefined) candidates.push(i);
    }

    const deadline = Date.now() + CONTEXT_PROBE_DEADLINE_MS;
    for (let start = 0; start < candidates.length; start += CONTEXT_PROBE_BATCH_SIZE) {
      if (Date.now() >= deadline) break;

      const batch = candidates.slice(start, start + CONTEXT_PROBE_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((index) => this._fetchContextFromShow(baseUrl, models[index]!.id)),
      );

      for (let j = 0; j < batch.length; j++) {
        const result = results[j]!;
        if (result.status !== 'fulfilled') continue;
        const contextWindow = result.value;
        if (contextWindow !== undefined) {
          models[batch[j]!]!.contextWindow = contextWindow;
        }
      }
    }
  }

  private _parseTagModel(model: {
    name: string;
    size?: number;
    details?: {
      context_length?: number;
      parameter_size?: string;
      quantization_level?: string;
    };
    model_info?: Record<string, unknown>;
    capabilities?: unknown;
  }): DetailedModelInfo {
    const result: DetailedModelInfo = { id: model.name };

    const contextWindow = this._extractContextWindow(model);
    if (contextWindow !== undefined) result.contextWindow = contextWindow;

    if (typeof model.details?.parameter_size === 'string' && model.details.parameter_size) {
      result.parameterSize = model.details.parameter_size;
    }
    if (typeof model.details?.quantization_level === 'string' && model.details.quantization_level) {
      result.quantization = model.details.quantization_level;
    }

    const sizeBytes = toNonNegativeNumber(model.size);
    if (sizeBytes !== undefined && sizeBytes > 0) result.sizeBytes = sizeBytes;

    if (Array.isArray(model.capabilities)) {
      const capabilities = model.capabilities.filter((c): c is string => typeof c === 'string' && c.length > 0);
      if (capabilities.length) result.capabilities = capabilities;
    }

    return result;
  }

  /**
   * Best-effort контекст из POST /api/show: архитектура → ключ
   * `"<arch>.context_length"` в model_info. Любая ошибка/таймаут → undefined.
   */
  private async _fetchContextFromShow(baseUrl: string, model: string): Promise<number | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const resp = await egressFetch(`${baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: controller.signal,
      });

      if (!resp.ok) return undefined;

      const data = await resp.json() as { model_info?: Record<string, unknown> };
      const info = data.model_info ?? {};
      const arch = typeof info['general.architecture'] === 'string'
        ? info['general.architecture']
        : undefined;
      if (!arch) return undefined;

      const raw = info[`${arch}.context_length`];
      const num = toNonNegativeNumber(raw);
      return num !== undefined && num > 0 ? num : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Извлекает размер контекстного окна из записи /api/tags.
   * Поле может лежать в details.context_length или model_info
   * (context_length / ContextLength / llama.context_length) — берём
   * первый числовой вариант. Если окно неизвестно — возвращаем undefined.
   */
  private _extractContextWindow(model: {
    details?: { context_length?: number };
    model_info?: Record<string, unknown>;
  }): number | undefined {
    const info = model.model_info ?? {};
    const raw = model.details?.context_length
      ?? info.context_length
      ?? info.ContextLength
      ?? info['llama.context_length'];
    const num = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(num) && num > 0 ? num : undefined;
  }

  /**
   * Нормализует function.arguments в tool_calls: JSON-строка → объект.
   * Сборка Ollama (0.32.x, llama-server c --spec-type draft-mtp) принимает
   * только объект и падает с 400 «can't find closing '}'» на строке.
   * Если парсинг не удался — оставляем строку как есть (не роняем запрос).
   */
  private _normalizeToolArguments(args: unknown): unknown {
    if (typeof args !== 'string') return args;
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }

  private _formatMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.disabled) continue;
      if (msg.role === 'info' || msg.role === 'model') continue;

      if (msg.role === 'tool') {
        formatted.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolCallId,
        });
        continue;
      }

      const entry: Record<string, unknown> = { role: msg.role, content: msg.content };
      if (msg.toolUse) {
        // Старые сессии хранят arguments строкой — приводим к объекту
        // перед отправкой, иначе Ollama вернёт 400.
        entry.tool_calls = msg.toolUse.map((tc) => {
          const fn = tc.function as Record<string, unknown> | undefined;
          if (!fn || typeof fn.arguments === 'undefined') return tc;
          return {
            ...tc,
            function: {
              ...fn,
              arguments: this._normalizeToolArguments(fn.arguments),
            },
          };
        });
      }
      formatted.push(entry);
    }

    return formatted;
  }

  private _parseResponse(
    data: Record<string, unknown>,
    debugCollector?: DebugCollector,
  ): LLMResponse {
    const message = data.message as Record<string, unknown> | undefined;
    const content = String(message?.content ?? '');
    const reasoning = message?.thinking as string | undefined;

    if (reasoning) debugCollector?.captureReasoning(reasoning);

    let toolCalls: Record<string, unknown>[] | undefined;
    if (message?.tool_calls) {
      toolCalls = (message.tool_calls as Record<string, unknown>[]).map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: (tc.function as Record<string, unknown>)?.name,
          // Строку → объект, чтобы в сессию сохранялись объекты (единообразие)
          // и повторная отправка не ломалась.
          arguments: this._normalizeToolArguments(
            (tc.function as Record<string, unknown>)?.arguments,
          ),
        },
      }));
    }

    const inputTokens = (data.prompt_eval_count as number) || 0;
    const outputTokens = (data.eval_count as number) || 0;
    // ADR-070 §2.3: у Ollama cache-полей нет — cacheRead/cacheWrite = 0.
    const parsedUsage: TokenUsage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    return { content, model: this.model, usage: parsedUsage, toolCalls, reasoning };
  }

  private _formatTools(tools: Record<string, unknown>[]): Record<string, unknown>[] {
    return tools.map((tool) => {
      if (tool.type === 'function' && tool.function) return tool;
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || tool.input_schema || {},
        },
      };
    });
  }

  private _handleErrors(statusCode: number, errorText: string): void {
    if (statusCode === 400) {
      const lower = errorText.toLowerCase();
      if (lower.includes('context') || lower.includes('length') || lower.includes('token')) {
        throw new ContextLengthExceededError();
      }
      throw new Error(`Ollama bad request: ${errorText}`);
    }
    if (statusCode === 429) {
      throw new RateLimitError();
    }
    warning('OLLAMA', `HTTP ${statusCode}: ${errorText}`);
  }
}
