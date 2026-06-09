import type { LLMChunk, LLMResponse, TokenUsage } from '@synth/shared';
import { BaseProvider, type LLMMessage, type CancellationToken } from './base.js';
import { info, warning } from '../logger.js';
import type { DebugCollector } from '../debug.js';
import { ContextLengthExceededError, RateLimitError } from './exceptions.js';

const ANTHROPIC_API_VERSION = '2023-06-01';

export class AnthropicProvider extends BaseProvider {
  getProviderName(): string {
    return this.name;
  }

  async listModels(): Promise<string[]> {
    const baseUrl = this.url.replace(/\/v1\/messages\/?$/, '').replace(/\/+$/, '');
    const modelsUrl = `${baseUrl}/v1/models`;

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
      // fall through
    }
    return [];
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
      max_tokens: 4096,
    };
    if (this.topP !== undefined) body.top_p = this.topP;
    if (systemPrompt) body.system = systemPrompt;
    if (tools?.length) body.tools = this._formatTools(tools);
    if (stream) body.stream = true;

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
      max_tokens: 4096,
      stream: true,
    };
    if (this.topP !== undefined) body.top_p = this.topP;
    if (systemPrompt) body.system = systemPrompt;
    if (tools?.length) body.tools = this._formatTools(tools);

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

              if (eventType === 'content_block_start') {
                const block = chunkData.content_block as Record<string, unknown> | undefined;
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

              if (eventType === 'message_delta') {
                const usage = chunkData.usage as Record<string, number> | undefined;
                if (usage) {
                  accumulatedUsage = {
                    inputTokens: usage.input_tokens || 0,
                    outputTokens: usage.output_tokens || 0,
                    totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                    cacheReadTokens: usage.cache_read_input_tokens || 0,
                    cacheWriteTokens: usage.cache_creation_input_tokens || 0,
                  };
                }
              }

              if (eventType === 'message_stop') break;
            } catch {
              continue;
            }
          }
        }
      } catch (e) {
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
    const seenToolUseIds = new Set<string>();

    for (const msg of messages) {
      if (msg.disabled) continue;
      if (msg.role === 'info' || msg.role === 'model') continue;

      if (msg.role === 'tool') {
        if (msg.toolCallId && seenToolUseIds.has(msg.toolCallId)) continue;
        if (msg.toolCallId) seenToolUseIds.add(msg.toolCallId);
        formatted.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content }],
        });
        continue;
      }

      if (msg.role === 'assistant') {
        const contentParts: Array<Record<string, unknown>> = [];
        if (msg.content) {
          contentParts.push({ type: 'text', text: msg.content });
        }
        if (msg.toolUse) {
          for (const tu of msg.toolUse) {
            contentParts.push({
              type: 'tool_use',
              id: tu.id,
              name: (tu.function as Record<string, unknown>)?.name,
              input: (tu.function as Record<string, unknown>)?.arguments || {},
            });
            if (tu.id) seenToolUseIds.add(String(tu.id));
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

    return formatted;
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
    const parsedUsage: TokenUsage = {
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      totalTokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
      cacheReadTokens: usage?.cache_read_input_tokens || 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens || 0,
    };

    return {
      content: accumulatedContent,
      model: this.model,
      usage: parsedUsage,
      toolCalls: accumulatedToolCalls.length ? accumulatedToolCalls : undefined,
      reasoning: accumulatedReasoning,
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
