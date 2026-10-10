/**
 * AD-084: DecisionProvider — адаптер decision-моделей (System One: Clef/Jev/…).
 * Не чат: `state + типизированные вопросы → вероятности` за один forward-pass.
 * Два транспорта под один контракт (SystemOne-совместимые):
 * - `decisions` (RouterAI): `POST {base}/decisions`;
 * - `systemone` (Ollama): `POST {base}/v1/systemone`.
 *
 * Транспорт выбирается полем конфига провайдера `decisionApi`
 * (`decisions` по умолчанию). Запросы идут через `fetch` с таймаутом;
 * ошибки маппятся на `ProviderError`/`RateLimitError`/`ContextLengthExceededError`.
 */

import type {
  DecisionAnswer,
  DecisionQuestion,
  DecisionResponse,
  LLMChunk,
} from '@itphx/synth-shared';

import {
  BaseProvider,
  type LLMMessage,
  type SystemPromptInput,
  type CancellationToken,
} from './base.js';
import type { DebugCollector } from '../debug.js';
import {
  ContextLengthExceededError,
  ProviderError,
  RateLimitError,
} from './exceptions.js';

/** Ответ decision-провайдера (answers без гарантии `type` — нормализуем сами). */
type RawAnswers = Record<string, unknown>;

export class DecisionProvider extends BaseProvider {
  getProviderName(): string {
    return this.name;
  }

  /**
   * decision-провайдер не умеет чат — явный отказ вместо тихой поломки.
   * `GatewayProvider.chat` вызывает этот метод только при ошибочной
   * маршрутизации; корректный путь — `decide`.
   */
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: DebugCollector,
  ): Promise<never> {
    throw new ProviderError('decision-провайдер не поддерживает chat', this.name);
  }

  chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _debugCollector?: DebugCollector,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    throw new ProviderError('decision-провайдер не поддерживает chat', this.name);
  }

  /**
   * AD-084: основной метод — единый decision-запрос. `state` — текст/JSON,
   * `questions` — типизированные вопросы (`noul`/`choice`/`score`).
   */
  async decide(
    state: unknown,
    questions: Record<string, DecisionQuestion>,
    opts?: { model?: string },
  ): Promise<DecisionResponse> {
    const url = this._endpoint();
    const body = {
      model: opts?.model || this.model,
      state,
      questions,
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new ProviderError(
          `Таймаут decision-запроса (${this.timeout} с)`,
          this.name,
        );
      }
      throw new ProviderError(
        `Ошибка сети decision-провайдера: ${e instanceof Error ? e.message : String(e)}`,
        this.name,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => '');
      this._handleError(resp.status, errorText);
    }

    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      throw new ProviderError('Некорректный JSON в ответе decision-провайдера', this.name);
    }

    return this._parseResponse(data, questions);
  }

  /** URL транспорта: `systemone` → `/v1/systemone`, иначе `/decisions`. */
  private _endpoint(): string {
    const base = this.url.replace(/\/+$/, '');
    return this.decisionApi === 'systemone'
      ? `${base}/v1/systemone`
      : `${base}/decisions`;
  }

  private _handleError(status: number, errorText: string): never {
    if (status === 429) {
      throw new RateLimitError();
    }
    if (status === 400 || status === 413) {
      const lower = errorText.toLowerCase();
      if (lower.includes('context') || lower.includes('length') || lower.includes('token')) {
        throw new ContextLengthExceededError();
      }
      throw new ProviderError(`decision-провайдер: ${status} ${errorText}`, this.name);
    }
    throw new ProviderError(`decision-провайдер: ${status} ${errorText}`, this.name);
  }

  private _parseResponse(
    data: unknown,
    questions: Record<string, DecisionQuestion>,
  ): DecisionResponse {
    if (!data || typeof data !== 'object') {
      throw new ProviderError('Пустой ответ decision-провайдера', this.name);
    }
    const obj = data as Record<string, unknown>;
    const rawAnswers = (obj.answers ?? {}) as RawAnswers;

    const result: DecisionResponse = {
      answers: this._normalizeAnswers(rawAnswers, questions),
    };
    if (typeof obj.id === 'string') result.id = obj.id;
    if (typeof obj.model === 'string') result.model = obj.model;

    const usage = obj.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === 'object') {
      result.usage = {
        input_tokens: this._num(usage.input_tokens),
        output_tokens: this._num(usage.output_tokens),
      };
    }

    return result;
  }

  /** Приводит `answers` к типизированному виду, опираясь на вопрос (fallback — по ключам). */
  private _normalizeAnswers(
    rawAnswers: RawAnswers,
    questions: Record<string, DecisionQuestion>,
  ): Record<string, DecisionAnswer> {
    const out: Record<string, DecisionAnswer> = {};
    for (const [id, raw] of Object.entries(rawAnswers)) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;
      const declared = typeof obj.type === 'string' ? obj.type : undefined;
      const type = declared ?? questions[id]?.type ?? this._inferType(obj);
      if (type === 'noul') {
        out[id] = { type: 'noul', noul: this._num(obj.noul ?? obj.probability ?? obj.score) };
      } else if (type === 'choice') {
        out[id] = {
          type: 'choice',
          choice: this._str(obj.choice ?? obj.answer),
          confidence: this._num(obj.confidence),
          probabilities: this._probabilities(obj.probabilities),
        };
      } else if (type === 'score') {
        const legend = this._legend(obj.legend);
        out[id] = {
          type: 'score',
          score: this._num(obj.score ?? obj.answer),
          confidence: this._num(obj.confidence),
          probabilities: this._probabilities(obj.probabilities),
          ...(legend ? { legend } : {}),
        };
      }
    }
    return out;
  }

  private _inferType(obj: Record<string, unknown>): DecisionQuestion['type'] | undefined {
    if ('noul' in obj) return 'noul';
    if ('choice' in obj) return 'choice';
    if ('score' in obj) return 'score';
    return undefined;
  }

  private _probabilities(value: unknown): Record<string, number> {
    if (!value || typeof value !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = this._num(raw);
    }
    return out;
  }

  private _legend(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = this._str(raw);
    }
    return out;
  }

  private _num(value: unknown): number {
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  private _str(value: unknown): string {
    return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  }
}
