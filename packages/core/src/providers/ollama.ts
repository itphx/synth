import type { LLMChunk, LLMResponse, TokenUsage } from '@itphx/synth-shared';
import { BaseProvider, type LLMMessage, type CancellationToken } from './base.js';
import { info, warning } from '../logger.js';
import type { DebugCollector } from '../debug.js';
import { ContextLengthExceededError, RateLimitError } from './exceptions.js';

export class OllamaProvider extends BaseProvider {
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
    const formattedMessages = this._formatMessages(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      temperature: this.temperature,
      stream: !!stream,
    };
    if (systemPrompt) body.system = systemPrompt;
    if (tools?.length) body.tools = this._formatTools(tools);

    const headers = { 'Content-Type': 'application/json' };
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
    systemPrompt?: string,
    tools?: Record<string, unknown>[],
    debugCollector?: DebugCollector,
    cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    const formattedMessages = this._formatMessages(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      temperature: this.temperature,
      stream: true,
    };
    if (systemPrompt) body.system = systemPrompt;
    if (tools?.length) body.tools = this._formatTools(tools);

    const headers = { 'Content-Type': 'application/json' };
    debugCollector?.captureApiRequest(this.url, 'POST', headers, body);

    let accumulatedReasoning = '';
    let accumulatedContent = '';
    const accumulatedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const accumulatedToolCalls: Record<string, unknown>[] = [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);

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
        throw new Error(`Ollama API error ${resp.status}: ${errorText}`);
      }

      if (!resp.body) throw new Error('Нет тела ответа');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          if (cancellationToken?.cancelled) {
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

              if (msg?.content && typeof msg.content === 'string') {
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
                for (const tc of msg.tool_calls as Record<string, unknown>[]) {
                  accumulatedToolCalls.push({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: (tc.function as Record<string, unknown>)?.name,
                      arguments: (tc.function as Record<string, unknown>)?.arguments,
                    },
                  });
                }
              }

              if (msg?.thinking && typeof msg.thinking === 'string') {
                accumulatedReasoning += msg.thinking;
                debugCollector?.captureReasoning(accumulatedReasoning);
                yield {
                  content: '',
                  isFinal: false,
                  usage: accumulatedUsage,
                  reasoning: accumulatedReasoning || undefined,
                };
              }

              if (typeof chunkData.prompt_eval_count === 'number') {
                accumulatedUsage.inputTokens += chunkData.prompt_eval_count;
              }
              if (typeof chunkData.eval_count === 'number') {
                accumulatedUsage.outputTokens += chunkData.eval_count;
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
          info('OLLAMA', `Стрим прерван: ${e}`);
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
      const resp = await fetch(`${baseUrl}/api/embed`, {
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
    const resp2 = await fetch(`${baseUrl}/api/embeddings`, {
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
    const baseUrl = this.url.replace('/api/chat', '').replace('/v1/chat/completions', '');
    const tagsUrl = `${baseUrl}/api/tags`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const resp = await fetch(tagsUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (resp.ok) {
        const data = await resp.json() as { models?: Array<{ name: string }> };
        return (data.models || []).map((m) => m.name).filter(Boolean);
      }
    } catch {
      // fall through
    }

    return [];
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
      if (msg.toolUse) entry.tool_calls = msg.toolUse;
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
          arguments: (tc.function as Record<string, unknown>)?.arguments,
        },
      }));
    }

    const parsedUsage: TokenUsage = {
      inputTokens: (data.prompt_eval_count as number) || 0,
      outputTokens: (data.eval_count as number) || 0,
      totalTokens: 0,
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
