import type { AttachmentModality, TokenUsage, LLMChunk, LLMResponse, ReasoningLevel, Currency, DecisionQuestion, DecisionResponse } from '@itphx/synth-shared';
import type { DebugCollector } from '../debug.js';
import { warning } from '../logger.js';
import { ProviderError } from './exceptions.js';
// ADR-099: запросы провайдеров — через единый транспорт доверия TLS/CA.
import { egressFetch } from '../security/tls.js';

/** Таймаут best-effort загрузки каталога моделей, мс. */
const MODELS_CATALOG_TIMEOUT_MS = 10_000;

/**
 * ADR-115: модальности каталога моделей → наши (`AttachmentModality`).
 * `file` у OpenAI-совместимых каталогов — документы, поэтому маппится в `pdf`;
 * неизвестные значения игнорируются.
 */
export const CATALOG_MODALITY_MAP: Record<string, AttachmentModality> = {
  text: 'text',
  image: 'image',
  audio: 'audio',
  video: 'video',
  file: 'pdf',
  pdf: 'pdf',
};

/**
 * ADR-115: модальности входа из `architecture` каталога `/models`.
 *
 * RouterAI/OpenRouter отдают `architecture: {modality: 'text+image->text',
 * input_modalities: ['text', 'image']}` — одинаково для OpenAI- и
 * Anthropic-совместимых эндпоинтов, поэтому парсер общий для провайдеров
 * (`providers/base.ts`). Неизвестные значения игнорируются; ничего не
 * распознано — `undefined` (поле не задаётся, действует справочник).
 */
export function parseArchitectureModalities(
  architecture: Record<string, unknown> | undefined,
): AttachmentModality[] | undefined {
  if (!architecture || typeof architecture !== 'object') return undefined;

  const collected = new Set<AttachmentModality>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const mapped = CATALOG_MODALITY_MAP[value.trim().toLowerCase()];
    if (mapped) collected.add(mapped);
  };

  const input = architecture.input_modalities;
  if (Array.isArray(input)) {
    for (const item of input) add(item);
  }

  // `modality` описывает пару «вход → выход»: берём только входную часть.
  const modality = architecture.modality;
  if (typeof modality === 'string') {
    const [inputs] = modality.split('->');
    for (const part of (inputs ?? '').split('+')) add(part);
  }

  return collected.size > 0 ? [...collected] : undefined;
}

/**
 * Модель с расширенными метаданными, которые отдают каталоги провайдеров
 * (контекст, лимиты, цены, размер и т.п.). Используется синхронизацией
 * `POST /models/fetch`, чтобы записать цены/лимиты в конфиг модели.
 */
export interface DetailedModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Цены за 1M токенов; заполняются только для тарифов priceUnit==='token'. */
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  priceUnit?: 'token' | 'request' | 'second' | 'image' | 'search_unit' | 'unknown';
  /** Валюта цен, если провайдер её явно отдаёт (иначе определяет backend по конфигу провайдера). */
  currency?: Currency;
  /** Метаданные Ollama (необязательно). */
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  capabilities?: string[];
  /**
   * ADR-115: модальности входа, сообщённые каталогом провайдера
   * (`architecture` у OpenAI-совместимых RouterAI/OpenRouter). Не задано —
   * провайдер их не сообщает, действует справочник.
   */
  modalities?: AttachmentModality[];
}

/**
 * Безопасное число: конечное и >= 0. Пустые/невалидные значения → undefined.
 * Строки приводятся через Number(...) (каталоги отдают цены строками).
 */
export function toNonNegativeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

/**
 * Ключ считается токенным, если `units` не задан, для ключа нет явной
 * единицы, либо единица равна `token`. Явные non-token единицы
 * (`request`, `second`, `image`, ...) исключаются.
 */
function _isTokenUnit(
  units: Record<string, unknown> | undefined,
  key: string,
): boolean {
  if (!units) return true;
  const unit = units[key];
  if (unit === undefined || unit === null) return true;
  return unit === 'token';
}

/** Первое непустое токенное значение из списка альтернативных ключей. */
function _findTokenPrice(
  pricing: Record<string, unknown>,
  units: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    if (!(key in pricing)) continue;
    if (!_isTokenUnit(units, key)) continue;
    const value = toNonNegativeNumber(pricing[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Разбор OpenRouter/RouterAI-прайсинга. Цены отдаются за 1 токен —
 * нормируем к 1M токенов (×1_000_000). Учитываются только токенные тарифы;
 * `request`/`second`/`image`/`search_unit` игнорируются. Если токенных цен
 * нет — возвращает `undefined`.
 */
export function parseTokenPricing(
  pricing: Record<string, unknown> | undefined,
  units: Record<string, unknown> | undefined,
): {
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  priceUnit?: DetailedModelInfo['priceUnit'];
} | undefined {
  if (!pricing || typeof pricing !== 'object') return undefined;

  const perMillion = (value: number): number => value * 1_000_000;

  const input = _findTokenPrice(pricing, units, ['prompt', 'input']);
  const output = _findTokenPrice(pricing, units, ['completion', 'output']);
  const cacheRead = _findTokenPrice(pricing, units, ['input_cache_read', 'cache_read', 'cached_input']);
  const cacheWrite = _findTokenPrice(pricing, units, ['input_cache_write', 'cache_write']);

  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined;
  }

  const result: {
    inputPrice?: number;
    outputPrice?: number;
    cacheReadPrice?: number;
    cacheWritePrice?: number;
    priceUnit?: DetailedModelInfo['priceUnit'];
  } = { priceUnit: 'token' };

  if (input !== undefined) result.inputPrice = perMillion(input);
  if (output !== undefined) result.outputPrice = perMillion(output);
  if (cacheRead !== undefined) result.cacheReadPrice = perMillion(cacheRead);
  if (cacheWrite !== undefined) result.cacheWritePrice = perMillion(cacheWrite);

  return result;
}

/**
 * Загружает каталог моделей с таймаутом и разбирает общий конверт
 * `{ data: [...] }`, который отдают OpenAI- и Anthropic-совместимые
 * эндпоинты `/models`.
 *
 * Возвращает «сырые» записи каталога — маппинг полей остаётся за провайдером
 * (форматы ответов и заголовки у провайдеров различаются). Загрузка
 * best-effort: сеть/таймаут/не-OK статус/невалидный JSON → пустой массив,
 * каталог не должен ронять синхронизацию. Таймер abort'а всегда очищается
 * (try/finally), в том числе при исключении fetch/`resp.json()`.
 */
export async function fetchModelsCatalog(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = MODELS_CATALOG_TIMEOUT_MS,
): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await egressFetch(url, { headers, signal: controller.signal });
    if (!resp.ok) return [];
    const data = await resp.json() as { data?: Array<Record<string, unknown>> };
    return Array.isArray(data.data) ? data.data : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADR-115 §3: вложение в LLM-вызове (типовая часть контракта).
 *
 * Байты лежат в blob-хранилище, а провайдеру уходит **уже прочитанное**
 * содержимое в base64. На этом шаге контракт только объявлен: чтение из
 * `BlobStore` и маппинг в форматы провайдеров — следующий шаг (ADR-115
 * §«Провайдеры и gateway»).
 */
export interface LLMAttachment {
  /** MIME-тип вложения (`image/png`, `application/pdf`, …). */
  mime: string;
  /** Имя файла (необязательно — для подписи у провайдера). */
  name?: string;
  /** Содержимое вложения в base64 (без data-URL-префикса). */
  base64: string;
}

export interface LLMMessage {
  id: string;
  role: string;
  content: string;
  /**
   * ADR-115: вложения сообщения (рядом с текстовым `content` — порядок:
   * сначала текст, затем вложения). Поле необязательное: текстовые сообщения
   * ведут себя как раньше.
   */
  attachments?: LLMAttachment[];
  usage: TokenUsage;
  debug?: Record<string, unknown>;
  model?: string;
  summaryOf?: number[];
  disabled: boolean;
  pinned: boolean;
  branchId: string;
  source?: string;
  status?: Record<string, unknown>;
  toolCallId?: string;
  toolUse?: Record<string, unknown>[];
  reasoning?: string;
  groupId?: string;
  agentRole?: string;
}

/**
 * ADR-115 §4: модальность вложения по MIME-типу.
 *
 * `text/*` — текстовая модальность (байтами не отправляется: содержимое уже
 * в `content`), `application/pdf` — `pdf`, остальные `file`-типы — `null`
 * (провайдеру не отправляются).
 */
export function attachmentModalityOf(mime: string): AttachmentModality | null {
  const normalized = (mime ?? '').toLowerCase().trim();
  if (!normalized) return null;
  if (normalized.startsWith('image/')) return 'image';
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('text/')) return 'text';
  return null;
}

/** Признак объекта-контейнера base64-данных вложения (для отладки). */
function isAttachmentDataHolder(value: Record<string, unknown>): boolean {
  return (
    value.type === 'input_audio'
    || value.type === 'image'
    || value.type === 'document'
    || typeof value.media_type === 'string'
    || (typeof value.format === 'string' && typeof value.data === 'string')
  );
}

function redactValue(value: unknown, dataField: boolean): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    if (value.startsWith('data:') && value.includes(';base64,')) {
      const mime = value.slice(5, value.indexOf(';base64,'));
      return { value: `data:${mime};base64,<redacted>`, changed: true };
    }
    if (dataField) {
      return { value: `<redacted ${value.length}b>`, changed: true };
    }
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = redactValue(item, dataField);
      if (result.changed) changed = true;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const holder = isAttachmentDataHolder(record);
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      // `data` внутри блока вложения — всегда base64: вырезаем независимо от
      // длины (у мелких файлов она может быть небольшой).
      const result = redactValue(item, holder && key === 'data');
      if (result.changed) changed = true;
      next[key] = result.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

/**
 * ADR-115 §«Gateway»: убрать base64 вложений из отладочного снимка запроса.
 *
 * `DebugCollector.captureApiRequest` сохраняет тело запроса как есть; после
 * маппинга вложений в форматы провайдеров там оказались бы data-URL и
 * base64-данные. В отладочный снимок они не попадают: data-URL заменяется на
 * `data:<mime>;base64,<redacted>`, поля `data` внутри блоков вложения — на
 * пометку с длиной. Объект без вложений возвращается тем же (без копий).
 */
export function redactAttachmentPayloadForDebug<T>(body: T): T {
  return redactValue(body, false).value as T;
}


export interface CancellationToken {
  cancelled: boolean;
  cancel: () => void;
  /**
   * ADR-104 (этап 2): прерывание текущей генерации БЕЗ отмены хода.
   *
   * `interrupted` — флаг прерывания (его снимает оркестратор на границе
   * шага, где прерырование применяется); `interrupt()` — запрос прерывания:
   * провайдер закрывает сетевой стрим, но `cancelled` не выставляется — ход
   * продолжается (в отличие от «Стоп», который завершает ход целиком).
   */
  interrupted?: boolean;
  interrupt?: () => void;
}

export interface ProviderConfig {
  type?: string;
  name?: string;
  url: string;
  apiKey: string;
  model: string;
  timeout?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  reasoningLevel?: ReasoningLevel;
  /** Лимит выходных токенов (max_tokens у OpenAI/Anthropic). */
  maxTokens?: number;
  /** Размер контекста модели (num_ctx у Ollama). */
  numCtx?: number;
}

/**
 * ADR-070 §2.2: политика prompt-cache. `auto` — ставить маркеры кэша,
 * `none` — полностью отключить (для отладки/сравнений).
 */
export type CachePolicy = 'auto' | 'none';

/**
 * ADR-070 §2.2: system prompt как payload для управления prompt-cache.
 * Провайдеры принимают как строку (обратная совместимость, в т.ч. саб-агенты),
 * так и этот объект.
 */
export interface SystemPromptPayload {
  /** Полный текст системного промпта. */
  text: string;
  /** Кэшируемый префикс (если задан — граница stable-префикса). */
  stablePrefix?: string;
  /** Ключ кэша (OpenAI prompt_cache_key) — стабильный id сессии. */
  cacheKey?: string;
  /** Политика кэша: auto (по умолчанию) | none. */
  cachePolicy?: CachePolicy;
  /**
   * ADR-071 §2.1: число встроенных инструментов в начале `tools`-массива
   * (граница stable-слоя). Кэш-брейкпоинт ставится на последний встроенный
   * инструмент; MCP-инструменты после границы не кэшируются. Если не задан —
   * провайдер сохраняет прежнее поведение (брейкпоинт на последний инструмент).
   */
  stableToolCount?: number;
}

export type SystemPromptInput = string | SystemPromptPayload;

/**
 * Возвращает текст системного промпта из строки или payload'а.
 * `undefined`, если input не задан или текст пуст.
 */
export function resolveSystemPromptText(input: SystemPromptInput | undefined): string | undefined {
  if (input === undefined) return undefined;
  const text = typeof input === 'string' ? input : input.text;
  return text || undefined;
}

/** RouterAI — прокси с расширениями протоколов (аудио, PDF-файлы и т.п.). */
export function isRouterAiUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'routerai.ru' || host.endsWith('.routerai.ru');
  } catch {
    return false;
  }
}

/**
 * ADR-115: может ли провайдер данного типа/хоста принять аудиофайл с таким
 * MIME **нативно** (без aux-модели и конвертации).
 *
 *  - официальный OpenAI — wav/mp3;
 *  - RouterAI (OpenAI-протокол) — wav/mp3 и ogg/opus (`input_audio` с
 *    `format:'ogg'`, проверено на живом API);
 *  - Anthropic-протокол — только wav и только RouterAI: официальный Anthropic
 *    аудио не принимает, а Anthropic-совместимый RouterAI для ogg/mp3 отвечает
 *    200, но модель аудио не слышит (галлюцинирует) — такие форматы должны
 *    идти через aux-модель.
 *
 * Гидратация использует предикат, чтобы не терять вложение молча: формат вне
 * списка обрабатывается aux-моделью или помечается как недоставленный.
 */
export function supportsNativeAudio(providerType: string, baseUrl: string, mime: string): boolean {
  const normalized = mime.toLowerCase().split(';')[0]!.trim();
  const wav = normalized === 'audio/wav' || normalized === 'audio/x-wav' || normalized === 'audio/wave';
  const mp3 = normalized === 'audio/mpeg' || normalized === 'audio/mp3';
  const ogg = normalized === 'audio/ogg' || normalized === 'audio/opus' || normalized === 'audio/oga';
  const routerAi = isRouterAiUrl(baseUrl);
  if (providerType === 'anthropic') return wav && routerAi;
  if (providerType === 'openai' || providerType === 'generic') {
    return wav || mp3 || (ogg && routerAi);
  }
  return false;
}

export abstract class BaseProvider {
  url: string;
  apiKey: string;
  model: string;
  timeout: number;
  temperature: number;
  topP?: number;
  topK?: number;
  name: string;
  type: string;
  reasoningLevel: ReasoningLevel;
  maxTokens?: number;
  numCtx?: number;

  constructor(params: {
    url: string;
    apiKey: string;
    model: string;
    timeout?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    name?: string;
    type?: string;
    reasoningLevel?: ReasoningLevel;
    maxTokens?: number;
    numCtx?: number;
  }) {
    this.url = params.url;
    this.apiKey = params.apiKey;
    this.model = params.model;
    this.timeout = params.timeout ?? 120;
    this.temperature = params.temperature ?? 0.7;
    this.topP = params.topP;
    this.topK = params.topK;
    this.name = params.name ?? 'unknown';
    this.type = params.type ?? 'generic';
    this.reasoningLevel = params.reasoningLevel ?? 'default';
    this.maxTokens = params.maxTokens;
    this.numCtx = params.numCtx;
  }

  abstract chat(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    stream?: boolean,
    debugCollector?: DebugCollector,
  ): Promise<LLMResponse>;

  abstract chatAsync(
    messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    tools?: Record<string, unknown>[],
    debugCollector?: DebugCollector,
    cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk>;

  abstract getProviderName(): string;

  async embed(_text: string): Promise<number[]> {
    throw new Error('Not implemented');
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  /**
   * Список моделей с расширенными метаданными (если провайдер их отдаёт).
   * Базовая реализация не знает окон/цен — возвращает только идентификаторы.
   */
  async listModelsDetailed(): Promise<DetailedModelInfo[]> {
    const ids = await this.listModels();
    return ids.map((id) => ({ id }));
  }

  /**
   * ADR-084: decision-запрос (`state + questions → answers`). Реализуют только
   * провайдеры типа `decision`; прочие типы бросают `ProviderError` (единый
   * fail-safe контракт для `GatewayProvider.decide`).
   */
  async decide(
    _state: unknown,
    _questions: Record<string, DecisionQuestion>,
    _opts?: { model?: string },
  ): Promise<DecisionResponse> {
    throw new ProviderError('Провайдер не поддерживает decision-запросы', this.name);
  }
}

export class ProviderFactory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static _providers = new Map<string, new (params: any) => BaseProvider>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static register(name: string, providerClass: new (params: any) => BaseProvider): void {
    this._providers.set(name.toLowerCase(), providerClass);
  }

  static create(
    name: string,
    config: ProviderConfig,
    temperature?: number,
    topP?: number,
    topK?: number,
  ): BaseProvider {
    let providerType = (config.type || name).toLowerCase();
    const url = config.url || '';
    const apiKey = config.apiKey || '';
    const model = config.model || '';
    const timeout = config.timeout ?? 120;

    if (!this._providers.has(providerType)) {
      providerType = this._detectProviderType(url, providerType);
    }

    if (!this._providers.has(providerType)) {
      throw new Error(`Неизвестный тип провайдера: ${providerType}`);
    }

    const ProviderClass = this._providers.get(providerType)!;
    const normalizedUrl = this._normalizeUrl(url, providerType);

    return new ProviderClass({
      url: normalizedUrl,
      apiKey,
      model,
      timeout,
      temperature: temperature ?? 0.7,
      topP,
      topK,
      name: config.name || name,
      type: providerType,
      reasoningLevel: config.reasoningLevel,
      maxTokens: config.maxTokens,
      numCtx: config.numCtx,
    });
  }

  static getRegistered(): string[] {
    return [...this._providers.keys()];
  }

  static _detectProviderType(url: string, providerType: string): string {
    const lower = url.toLowerCase();

    if (!providerType || providerType === 'generic') {
      if (lower.includes('anthropic.com') || lower.includes('minimaxi.com')) return 'anthropic';
      if (lower.includes('ollama.com') || lower.includes(':11434')) return 'ollama';
      if (lower.includes('openai.com') || lower.includes('azure.com')) return 'openai';
      return 'generic';
    }

    return providerType;
  }

  static _normalizeUrl(url: string, providerType: string): string {
    const trimmed = url.replace(/\/+$/, '');

    // ADR-084: decision-провайдеры (`decision` → /decisions, `systemone` →
    // /v1/systemone) строят endpoint сами — url остаётся базовым.
    if (providerType === 'decision' || providerType === 'systemone') {
      return trimmed;
    }
    // Ollama: класс провайдера нативный — тело запроса несёт `options`
    // (`num_ctx`), `think` и нативный формат `tools`, а сервер понимает их
    // только на `/api/chat`. Поэтому URL всегда приводится к нативному
    // `/api/chat`; OpenAI-совместимый суффикс `/v1` (в т.ч. полный
    // `/v1/chat/completions`) снимается — иначе OpenAI-слой Ollama молча
    // проигнорировал бы `options`/`think`/`tools`. Для OpenAI-совместимого
    // пути используйте `type: openai`/`generic`.
    if (providerType === 'ollama') {
      if (trimmed.endsWith('/api/chat')) return trimmed;
      if (trimmed.endsWith('/v1/chat/completions')) {
        const base = trimmed.slice(0, -'/v1/chat/completions'.length);
        warning(
          'OLLAMA',
          `type: ollama ожидает нативный базовый URL без /v1 — «${trimmed}» нормализован в «${base}/api/chat» (для OpenAI-совместимого пути используйте type: openai/generic)`,
        );
        return `${base}/api/chat`;
      }
      if (trimmed.endsWith('/v1')) {
        const base = trimmed.slice(0, -'/v1'.length);
        warning(
          'OLLAMA',
          `type: ollama ожидает нативный базовый URL без суффикса /v1 — «${trimmed}» нормализован в «${base}/api/chat» (для OpenAI-совместимого пути используйте type: openai/generic)`,
        );
        return `${base}/api/chat`;
      }
      return `${trimmed}/api/chat`;
    }
    if (providerType === 'anthropic' && !trimmed.endsWith('/v1/messages')) {
      return `${trimmed}/v1/messages`;
    }
    if ((providerType === 'openai' || providerType === 'generic') && !trimmed.includes('/chat/completions')) {
      if (trimmed.includes('/v1')) return `${trimmed}/chat/completions`;
      return `${trimmed}/v1/chat/completions`;
    }

    return trimmed;
  }
}
