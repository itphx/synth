/**
 * EmbeddingModel — микро-модель на эмбеддингах (AD-035).
 * Уровень 2 каскада: семантическая классификация.
 *
 * Два пути получения эмбеддингов:
 * 1. Через ProviderPool (Ollama API) — если передан pool и провайдер доступен
 * 2. Через @huggingface/transformers — fallback (ленивый импорт)
 */
import type { MicroInput, MicroResult, MicroTaskClass } from '../types.js';
import type { MicroModel } from './base.js';
import type { ProviderPool } from '../../provider-pool.js';
import { info, warning } from '../../../../logger.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Эталонные тексты для меток — английские (по умолчанию). */
const REFERENCE_TEXTS: Record<string, string> = {
  question: 'What is this? How does it work? Why did this happen?',
  command: 'Make this. Write a function. Create a file. Fix the bug.',
  review: 'Review this code. Check for errors. Audit the system.',
  explain: 'Explain how this works. Describe the architecture.',
  debug: 'Debug this error. There is a bug. Not working.',
  fix: 'Fix this code. Repair the function. Patch the issue.',
  test: 'Write a test. Add unit tests. Test this function.',
  yes: 'Yes, I agree. Confirm. Sure, do it.',
  no: 'No, cancel. Do not do it. Reject.',
  approve: 'Approve the plan. Go ahead. Proceed.',
  reject: 'Reject this. Cancel. Redo it.',
  mode_plan: 'Plan first. Investigate. Research. Analyze.',
  mode_act: 'Execute now. Implement. Code. Build.',
};

/** Эталонные тексты для меток — русские. */
const REFERENCE_TEXTS_RU: Record<string, string> = {
  question: 'Что это такое? Как это работает? Почему это произошло? Какой вопрос?',
  command: 'Сделай это. Напиши функцию. Создай файл. Реализуй алгоритм.',
  review: 'Проверь этот код. Найди ошибки. Проведи ревью. Оцени качество.',
  explain: 'Объясни как это работает. Опиши архитектуру. Расскажи принцип работы.',
  debug: 'Отладь эту ошибку. Здесь баг. Не работает. Падает с ошибкой.',
  fix: 'Исправь этот код. Почини функцию. Почини ошибку. Устрани баг.',
  test: 'Напиши тест. Добавь юнит-тесты. Покрой тестами. Протестируй функцию.',
  yes: 'Да, согласен. Подтверждаю. Конечно, делай.',
  no: 'Нет, отмена. Не делай. Отклоняю.',
  approve: 'Утверждаю план. Продолжай. Давай, выполняй.',
  reject: 'Отклоняю это. Отмена. Переделай. Не подходит.',
  mode_plan: 'Сначала спланируй. Исследуй. Проанализируй. Составь план.',
  mode_act: 'Выполняй сейчас. Реализуй. Пиши код. Действуй.',
};

/** Выбирает эталонные тексты по языку запроса. */
function referenceTextsFor(lang: string): Record<string, string> {
  return lang === 'ru' ? REFERENCE_TEXTS_RU : REFERENCE_TEXTS;
}

export class EmbeddingModel implements MicroModel {
  readonly kind = 'embedding' as const;
  readonly name = 'embedding-classifier';
  private readonly _pool: ProviderPool | null;
  private _embedProvider: string;
  private _embedModel: string;
  private _initialized = false;
  private _pipeline: unknown = null;
  private _refEmbeddings: Record<string, number[]> | null = null;
  /** Флаг: используем ли Ollama API вместо transformers */
  private _usingOllama = false;
  /** Кеш для Ollama-эмбеддингов (текст → вектор) */
  private readonly _ollamaCache = new Map<string, number[]>();
  /** Кеш-ключ последнего провайдера/модели для детекта изменений */
  private _lastInitKey = '';

  constructor(pool?: ProviderPool) {
    this._pool = pool ?? null;
    this._embedProvider = 'ollama';
    this._embedModel = '';
  }

  canHandle(taskClass: MicroTaskClass): boolean {
    return taskClass !== 'small_talk'; // small_talk — через rules
  }

  async handle(input: MicroInput, taskClass: MicroTaskClass): Promise<MicroResult> {
    const startTime = performance.now();
    const threshold = input.sessionSettings.microConfidenceThreshold || 0.8;

    // Обновляем провайдер/модель/язык из input и ре-инициализируем если изменились
    const newProvider = input.embedProvider || 'ollama';
    const newModel = input.embedModel || '';
    const lang = input.language || 'ru';
    const initKey = `${newProvider}:${newModel}:${lang}`;
    if (initKey !== this._lastInitKey || !this._initialized) {
      this._embedProvider = newProvider;
      this._embedModel = newModel;
      this._lastInitKey = initKey;
      await this._init(lang);
    }

    try {
      if (!this._initialized || !this._refEmbeddings) {
        return this._unsure(taskClass, startTime, ['embedding_not_available']);
      }

      const labels = this._getLabelsForClass(taskClass, lang);
      if (labels.length === 0) {
        return this._unsure(taskClass, startTime, ['no_labels_for_class']);
      }

      // Вычисляем эмбеддинг входа
      const inputVector = await this._getInputEmbedding(input.userMessage);
      if (!inputVector || inputVector.length === 0) {
        return this._unsure(taskClass, startTime, ['embedding_failed']);
      }

      // Косинусная близость к эталонным векторам меток
      let bestLabel = '';
      let bestSimilarity = -1;

      for (const label of labels) {
        const refVector = this._refEmbeddings[label];
        if (!refVector || refVector.length === 0) {
          continue;
        }
        const similarity = this._cosineSimilarity(inputVector, refVector);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestLabel = label;
        }
      }

      if (bestLabel && bestSimilarity >= 0.5) {
        const confidence = Math.min(bestSimilarity * 1.2, 0.99); // нормализуем
        return {
          status: confidence >= threshold ? 'OK' : 'UNSURE',
          taskClass,
          label: bestLabel,
          confidence,
          latencyMs: Math.round(performance.now() - startTime),
          signals: [`embedding:${bestLabel}:${bestSimilarity.toFixed(3)}`],
        };
      }

      return this._unsure(taskClass, startTime, [`low_similarity:${bestSimilarity.toFixed(3)}`]);
    } catch (err) {
      return this._unsure(taskClass, startTime, [`error:${String(err).slice(0, 100)}`]);
    }
  }

  // ── private ──

  private async _init(lang: string): Promise<void> {
    // Путь 1: попробовать через ProviderPool (Ollama API) — быстро, без загрузки локальной модели
    if (this._pool) {
      try {
        const modelName = this._embedModel || 'local.nomic-embed-text:latest';
        const provider = this._pool.getProvider(this._embedProvider, modelName);
        if (provider && typeof (provider as unknown as Record<string, unknown>).embed === 'function') {
          // Предзагружаем эталонные эмбеддинги через Ollama
          this._refEmbeddings = {};
          await this._warmupEmbeddingsViaProvider(provider as unknown as { embed: (t: string) => Promise<number[]> }, lang);
          this._usingOllama = true;
          this._initialized = true;
          info('MICRO', 'EmbeddingModel: инициализирован через ProviderPool (Ollama API)');
          return;
        }
      } catch (err) {
        warning('MICRO', `EmbeddingModel: ProviderPool unavailable (${err}), fallback на transformers`);
      }
    }

    // Путь 2: fallback на @huggingface/transformers
    try {
      // Ленивый импорт — пакет может быть не установлен
      // @ts-expect-error - динамический импорт опциональной зависимости
      const { pipeline } = await import('@huggingface/transformers');
      const extractor = await pipeline('feature-extraction', DEFAULT_MODEL);
      this._pipeline = extractor;

      // Предзагружаем эталонные эмбеддинги для всех меток
      this._refEmbeddings = {};
      await this._warmupEmbeddings(extractor, lang);

      this._usingOllama = false;
      this._initialized = true;
      info('MICRO', 'EmbeddingModel: инициализирован через @huggingface/transformers');
    } catch {
      // Пакет не установлен или не удалось загрузить модель — остаёмся UNSURE
      this._pipeline = null;
      this._refEmbeddings = null;
    }
  }

  private async _warmupEmbeddingsViaProvider(
    provider: { embed: (t: string) => Promise<number[]> },
    lang: string,
  ): Promise<void> {
    // Эталонные тексты для каждой метки (используем с Ollama)
    const referenceTexts = referenceTextsFor(lang);

    for (const [label, text] of Object.entries(referenceTexts)) {
      try {
        this._refEmbeddings![label] = await provider.embed(text);
      } catch {
        // Пропускаем эту метку
      }
    }
  }

  private async _getInputEmbedding(text: string): Promise<number[] | null> {
    // Если используем Ollama — кешируем и вызываем через провайдера
    if (this._usingOllama && this._pool) {
      const cacheKey = text.slice(0, 500); // короткие тексты кешируем
      const cached = this._ollamaCache.get(cacheKey);
      if (cached) return cached;

      try {
        const modelName = this._embedModel || 'local.nomic-embed-text:latest';
        const provider = this._pool.getProvider(this._embedProvider, modelName);
        if (provider && typeof (provider as unknown as Record<string, unknown>).embed === 'function') {
          const vec = await (provider as unknown as { embed: (t: string) => Promise<number[]> }).embed(text);
          this._ollamaCache.set(cacheKey, vec);
          return vec;
        }
      } catch {
        // fall through
      }
    }

    // Fallback: используем локальный pipeline (transformers)
    if (!this._pipeline) return null;

    const extractor = this._pipeline as { (text: string, opts: Record<string, unknown>): Promise<{ data: Float32Array }> };
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data) as number[];
  }

  private async _warmupEmbeddings(extractor: { (text: string, opts: Record<string, unknown>): Promise<{ data: Float32Array }> }, lang: string): Promise<void> {
    // Эталонные тексты для каждой метки
    const referenceTexts = referenceTextsFor(lang);

    for (const [label, text] of Object.entries(referenceTexts)) {
      try {
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        this._refEmbeddings![label] = Array.from(output.data) as number[];
      } catch {
        // Пропускаем эту метку
      }
    }
  }

  private _cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private _getLabelsForClass(taskClass: MicroTaskClass, _lang: string): string[] {
    switch (taskClass) {
      case 'classify':
        return ['question', 'command', 'review', 'explain', 'debug', 'fix', 'test'];
      case 'enum_decision':
        return ['yes', 'no', 'approve', 'reject', 'mode_plan', 'mode_act'];
      default:
        return [];
    }
  }

  private _unsure(taskClass: MicroTaskClass, startTime: number, signals: string[]): MicroResult {
    return {
      status: 'UNSURE',
      taskClass,
      confidence: 0.3,
      latencyMs: Math.round(performance.now() - startTime),
      signals,
    };
  }
}
