// RemoteProvider — виртуальный LLM-провайдер гибридного режима (Часть 6).
// Локальный core ходит за LLM через серверный /api/v2/llm/chat/completions
// (LLM Proxy backend, OpenAI-совместимый): все LLM-запросы проходят централизованно
// через backend (gateway ADR-036 применяется на сервере).
//
// Токен берётся из:
//   1. this.getToken (конструктор) — обычно RemoteSession.getToken (авто-refresh);
//   2. реестра setRemoteTokenProvider (для провайдеров, созданных через ProviderFactory);
//   3. this.apiKey как последний fallback.
// Если токена нет — ProviderError (оркестратор не ретраит бесконечно).

import type { LLMChunk, LLMResponse, TokenUsage } from '@itphx/synth-shared';
import { BaseProvider, resolveSystemPromptText, type LLMMessage, type SystemPromptInput, type CancellationToken } from './base.js';
import { ProviderError, ContextLengthExceededError, RateLimitError } from './exceptions.js';
import { info } from '../logger.js';
// ADR-099: запросы к backend-прокси — через единый транспорт доверия TLS/CA.
import { egressFetch } from '../security/tls.js';
import type { DebugCollector } from '../debug.js';

/** Параметры RemoteProvider. url — базовый URL backend (без /api/v2). */
export interface RemoteProviderOptions {
  url: string;
  apiKey: string;
  model: string;
  /** Поставщик токена для Authorization: Bearer (обычно RemoteSession.getToken). */
  getToken?: () => Promise<string | null>;
  timeout?: number;
  temperature?: number;
  maxTokens?: number;
  name?: string;
  type?: string;
  /**
   * Имя провайдера НА СЕРВЕРЕ (отправляется в теле LLM Proxy, чтобы backend
   * резолвил явного провайдера). В отличие от name — локального имени, по
   * которому резолвится токен/движок. По умолчанию совпадает с name (зеркала
   * серверных провайдеров называются их настоящими именами).
   */
  provider?: string;
}

/** Путь LLM Proxy на backend. */
const LLM_PROXY_PATH = '/api/v2/llm/chat/completions';

/**
 * Реестр поставщиков токена для RemoteProvider, созданных через ProviderFactory
 * (фабрика не передаёт getToken). Заполняется при инъекции remote-провайдера
 * в createStandaloneApp; живёт in-memory, в store не пишется.
 */
const REMOTE_TOKEN_PROVIDERS = new Map<string, () => Promise<string | null>>();

/** Зарегистрировать поставщика токена для RemoteProvider по имени провайдера. */
export function setRemoteTokenProvider(name: string, getToken: () => Promise<string | null>): void {
  REMOTE_TOKEN_PROVIDERS.set(name.toLowerCase(), getToken);
}

/** Удалить поставщика токена (при отключении remote-провайдера). */
export function removeRemoteTokenProvider(name: string): void {
  REMOTE_TOKEN_PROVIDERS.delete(name.toLowerCase());
}

/** Сброс реестра (для тестов). */
export function clearRemoteTokenProviders(): void {
  REMOTE_TOKEN_PROVIDERS.clear();
}

function lookupRemoteTokenProvider(name: string): (() => Promise<string | null>) | undefined {
  return REMOTE_TOKEN_PROVIDERS.get(name.toLowerCase());
}

export class RemoteProvider extends BaseProvider {
  private readonly _getToken?: () => Promise<string | null>;
  /** Имя серверного провайдера для тела LLM Proxy (по умолчанию — локальное name). */
  private readonly _providerName?: string;

  constructor(opts: RemoteProviderOptions) {
    super({
      url: opts.url,
      apiKey: opts.apiKey,
      model: opts.model,
      timeout: opts.timeout,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      name: opts.name ?? 'synth-remote',
      type: opts.type ?? 'remote',
    });
    this._getToken = opts.getToken;
    this._providerName = opts.provider ?? opts.name;
  }

  getProviderName(): string {
    return this.name;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    _stream?: boolean,
    debugCollector?: DebugCollector,
  ): Promise<LLMResponse> {
    info('REMOTE', `чат: model=${this.model}, сообщений=${messages.length}`);

    const resp = await this._request(messages, systemPrompt, tools, false);
    const data = (await resp.json()) as Record<string, unknown>;
    debugCollector?.captureApiResponse(data);
    debugCollector?.captureRawModelResponse(JSON.stringify(data));

    return this._parseResponse(data);
  }

  async *chatAsync(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    debugCollector?: DebugCollector,
    cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    info('REMOTE', `чатAsync: model=${this.model}, сообщений=${messages.length}`);

    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let accumulatedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const accumulatedToolCalls: Record<string, unknown>[] = [];

    const controller = new AbortController();
    // Таймаут — на установление соединения и получение заголовков ответа
    // (backend проксирует заголовки сразу). Как только стрим пошёл, таймер
    // снимается, дальше стрим длится сколько нужно.
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);

    // Кнопка «Стоп»: отмена пользователя немедленно прерывает fetch/reader.read().
    if (cancellationToken) {
      const originalCancel = cancellationToken.cancel.bind(cancellationToken);
      cancellationToken.cancel = () => {
        originalCancel();
        controller.abort();
      };
    }

    let resp: Response;
    try {
      resp = await this._request(messages, systemPrompt, tools, true, controller.signal);
    } catch (e) {
      // Отмена пользователя — молча завершаем генератор.
      if (cancellationToken?.cancelled) return;
      // Таймаут/обрыв до начала стрима: AbortError от нашего таймера.
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ProviderError(`Таймаут удалённого LLM-провайдера (${this.timeout}с)`, this.name);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!resp.body) {
      throw new ProviderError('Нет тела ответа от удалённого LLM-провайдера', this.name);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (cancellationToken?.cancelled) {
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

            // Ошибка провайдера в середине стрима: backend шлёт
            // data: {error:{code,message}} и закрывает поток.
            if (chunkData.error && typeof chunkData.error === 'object') {
              const err = chunkData.error as Record<string, unknown>;
              throw this.mapError(502, String(err.code ?? ''), String(err.message ?? 'Ошибка удалённого LLM-провайдера'));
            }

            const choices = chunkData.choices as Array<Record<string, unknown>> | undefined;
            const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;

            if (delta) {
              if (delta.reasoning_content && typeof delta.reasoning_content === 'string') {
                if (delta.reasoning_content === '.' || delta.reasoning_content === '.\n') continue;
                accumulatedReasoning += delta.reasoning_content;
                yield {
                  content: '',
                  isFinal: false,
                  usage: accumulatedUsage,
                  reasoning: accumulatedReasoning,
                };
              }

              if (delta.content && typeof delta.content === 'string') {
                accumulatedContent += delta.content;
                yield {
                  content: delta.content,
                  isFinal: false,
                  usage: accumulatedUsage,
                  reasoning: accumulatedReasoning || undefined,
                };
              }

              if (delta.tool_calls) {
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
          } catch (e) {
            // Ошибки классификации (ProviderError и т.п.) пробрасываем наружу —
            // иначе генератор «успешно» завершится с пустым ответом.
            if (e instanceof ProviderError || e instanceof ContextLengthExceededError || e instanceof RateLimitError) {
              throw e;
            }
            // Невалидный JSON — пропускаем строку.
            continue;
          }
        }
      }
    } catch (e) {
      // Ошибки чтения стрима (обрыв/AbortError) пробрасываем наружу.
      // При пользовательской отмене молча выходим.
      if (!cancellationToken?.cancelled) {
        throw e;
      }
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
        content: accumulatedContent || '',
        isFinal: true,
        usage: accumulatedUsage,
        toolCalls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
        reasoning: accumulatedReasoning || undefined,
        model: this.model,
      };
    }
  }

  /**
   * Маппинг ошибок LLM Proxy (backend) на исключения ядра.
   * Ошибки: { error: { code, message } }, статусы 400/404/429/401/502.
   */
  mapError(status: number, code?: string, message?: string): Error {
    const codeLower = (code || '').toLowerCase();
    const text = (message || '').toLowerCase();

    if (status === 404 || codeLower === 'model_not_found') {
      return new ProviderError(`Модель не найдена на удалённом сервере: ${message ?? `HTTP ${status}`}`, this.name);
    }
    if (status === 429 || codeLower === 'rate_limited') {
      return new RateLimitError(message || undefined);
    }
    if (status === 400 || codeLower === 'context_length_exceeded' || text.includes('context length')) {
      return new ContextLengthExceededError(message || undefined);
    }
    if (status === 401 || codeLower === 'unauthorized') {
      return new ProviderError('Не авторизован на удалённом сервере (токен истёк?)', this.name);
    }
    return new ProviderError(message || `Удалённый LLM-провайдер вернул ошибку HTTP ${status}`, this.name);
  }

  /** Модели подтягиваются через models-роут backend — список не нужен. */
  async listModels(): Promise<string[]> {
    return [];
  }

  /**
   * POST /api/v2/llm/chat/completions (OpenAI-совместимый).
   * Возвращает raw Response: для chat() — JSON, для chatAsync() — SSE-стрим.
   */
  private async _request(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    stream?: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    const token = await this._resolveToken();
    const base = this.url.replace(/\/api\/v2\/?$/, '').replace(/\/+$/, '');
    const url = `${base}${LLM_PROXY_PATH}`;
    const body = this._buildBody(messages, systemPrompt, tools, stream);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);
    const effectiveSignal = signal ?? controller.signal;

    try {
      const resp = await egressFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: effectiveSignal,
      });

      if (!resp.ok) {
        const errorBody = (await resp.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        const code = errorBody?.error?.code;
        const message = errorBody?.error?.message ?? `HTTP ${resp.status}`;
        throw this.mapError(resp.status, code, message);
      }
      return resp;
    } catch (err) {
      // Таймаут нашего таймера (когда сигнал не передан извне).
      if (err instanceof Error && err.name === 'AbortError' && !signal?.aborted) {
        throw new ProviderError(`Таймаут удалённого LLM-провайдера (${this.timeout}с)`, this.name);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async _resolveToken(): Promise<string> {
    let token: string | null = null;
    if (this._getToken) {
      token = await this._getToken();
    } else {
      const registered = lookupRemoteTokenProvider(this.name);
      token = registered ? await registered() : (this.apiKey || null);
    }
    if (!token) {
      throw new ProviderError('Нет токена для удалённого LLM-провайдера', this.name);
    }
    return token;
  }

  private _buildBody(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    stream?: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this._formatMessages(messages, systemPrompt),
      temperature: this.temperature,
    };
    if (stream) body.stream = true;
    // ADR-070: просим backend-proxy отдать usage в стриме (как OpenAIProvider),
    // иначе live-статистика remote-провайдера до финального чанка недоступна.
    if (stream) body.stream_options = { include_usage: true };
    if (tools?.length) body.tools = tools;
    if (this.maxTokens && this.maxTokens > 0) body.max_tokens = this.maxTokens;
    // ADR-070 §2.2: prompt_cache_key пробрасывается на backend LLM Proxy, который
    // исполняет провайдера с этим именем; при cachePolicy:'none' — не отправляем.
    if (
      typeof systemPrompt === 'object'
      && systemPrompt !== null
      && systemPrompt.cachePolicy !== 'none'
      && systemPrompt.cacheKey
    ) {
      body.prompt_cache_key = systemPrompt.cacheKey;
    }
    // Явный провайдер: backend исполняет своего провайдера с этим именем
    // (см. chatCompletionsSchema.provider в routes/llm.ts backend).
    if (this._providerName) body.provider = this._providerName;
    return body;
  }

  /**
   * OpenAI-формат сообщений для LLM Proxy. В отличие от OpenAIProvider здесь
   * content — всегда строка (схема backend chatCompletionsSchema требует string).
   */
  private _formatMessages(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
  ): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];

    const systemText = resolveSystemPromptText(systemPrompt);
    if (systemText) {
      formatted.push({ role: 'system', content: systemText });
    }

    for (const msg of messages) {
      if (msg.disabled) continue;
      if (msg.role === 'info' || msg.role === 'model') continue;

      const entry: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.toolUse) {
        // Нормализация function.arguments: объект → JSON-строка (как в OpenAIProvider).
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
      if (msg.role === 'assistant' && msg.reasoning) {
        entry.reasoning_content = msg.reasoning;
      }

      formatted.push(entry);
    }

    return formatted;
  }

  private _parseResponse(data: Record<string, unknown>): LLMResponse {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = String(message?.content ?? '');
    const toolCalls = message?.tool_calls as Record<string, unknown>[] | undefined;
    const reasoning = message?.reasoning_content as string | undefined;

    return {
      content,
      model: this.model,
      usage: this._parseUsage(data.usage as Record<string, unknown> | undefined),
      toolCalls,
      reasoning: reasoning || undefined,
    };
  }

  private _parseUsage(usage?: Record<string, unknown>): TokenUsage {
    if (!usage) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    }
    const completionDetails = usage.completion_tokens_details as Record<string, number> | undefined;
    const promptDetails = usage.prompt_tokens_details as Record<string, number> | undefined;
    // ADR-070 §2.3: backend LLM Proxy отдаёт OpenAI-совместимый usage; cache read
    // приходит в prompt_tokens_details.cached_tokens (fallback — Anthropic-поле).
    const cacheReadTokens =
      promptDetails?.cached_tokens
      ?? (usage.cache_read_input_tokens as number)
      ?? 0;
    return {
      inputTokens: (usage.prompt_tokens as number) || 0,
      outputTokens: (usage.completion_tokens as number) || 0,
      totalTokens: (usage.total_tokens as number) || 0,
      cacheReadTokens,
      cacheWriteTokens: (usage.cache_creation_input_tokens as number) || 0,
      reasoningTokens: completionDetails?.reasoning_tokens || 0,
    };
  }
}
