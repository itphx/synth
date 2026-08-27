import type { LLMChunk, LLMResponse, TokenUsage } from '@itphx/synth-shared';
import { BaseProvider, type LLMMessage, type CancellationToken } from './base.js';
import { info, warning } from '../logger.js';
import type { DebugCollector } from '../debug.js';
import { ContextLengthExceededError, RateLimitError } from './exceptions.js';

export class OpenAIProvider extends BaseProvider {
  getProviderName(): string {
    return this.name;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt?: string,
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
    systemPrompt?: string,
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
    };
    if (this.reasoningLevel && this.reasoningLevel !== 'default') body.reasoning_effort = this.reasoningLevel;
    if (this.topP !== undefined) body.top_p = this.topP;
    if (this.topK !== undefined) body.top_k = this.topK;
    if (tools?.length) body.tools = tools;
    if (this.maxTokens && this.maxTokens > 0) body.max_tokens = this.maxTokens;

    const headers = this._getHeaders();
    debugCollector?.captureApiRequest(this.url, 'POST', headers, body);

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
    }

    try {
      let resp: Response;
      try {
        resp = await fetch(this.url, {
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

              const choices = chunkData.choices as Array<Record<string, unknown>> | undefined;
              const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;

              if (delta) {
                if (delta.reasoning_content && typeof delta.reasoning_content === 'string') {
                  if (delta.reasoning_content === '.' || delta.reasoning_content === '.\n') continue;
                  if (!firstChunkReceived) {
                    firstChunkReceived = true;
                    clearTimeout(timer);
                  }
                  accumulatedReasoning += delta.reasoning_content;
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
                const usage = chunkData.usage as Record<string, unknown>;
                const details = usage.completion_tokens_details as Record<string, number> | undefined;
                accumulatedUsage = {
                  inputTokens: (usage.prompt_tokens as number) || 0,
                  outputTokens: (usage.completion_tokens as number) || 0,
                  totalTokens: (usage.total_tokens as number) || 0,
                  reasoningTokens: details?.reasoning_tokens || 0,
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
        // отмене (cancellationToken) молча выходим.
        if (!cancellationToken?.cancelled) {
          info('OPENAI', `Стрим прерван: ${e}`);
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
    const baseUrl = this.url.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
    const modelsUrl = `${baseUrl}/models`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const resp = await fetch(modelsUrl, {
        headers: this._getHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.ok) {
        const data = await resp.json() as { data?: Array<{ id: string }> };
        return (data.data || []).map((m) => m.id).filter(Boolean);
      }
    } catch {
      // fall trough
    }

    return [];
  }

  private _formatMessages(
    messages: LLMMessage[],
    systemPrompt?: string,
  ): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];

    if (systemPrompt) {
      formatted.push({
        role: 'system',
        content: [{ type: 'text', text: systemPrompt }],
      });
    }

    for (const msg of messages) {
      if (msg.disabled) continue;
      if (msg.role === 'info' || msg.role === 'model') continue;

      const entry: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };

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
    const reasoning = message?.reasoning_content as string | undefined;

    const usage = data.usage as Record<string, unknown> | undefined;
    const details = usage?.completion_tokens_details as Record<string, number> | undefined;
    const parsedUsage: TokenUsage = {
      inputTokens: (usage?.prompt_tokens as number) || 0,
      outputTokens: (usage?.completion_tokens as number) || 0,
      totalTokens: (usage?.total_tokens as number) || 0,
      reasoningTokens: details?.reasoning_tokens || 0,
    };

    return {
      content,
      model: this.model,
      usage: parsedUsage,
      toolCalls,
      reasoning: reasoning || undefined,
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
