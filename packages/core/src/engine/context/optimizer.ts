import type { Message, Session, ProviderConfig as SharedProviderConfig, SummarizationConfig, LLMGatewayConfig } from '@itphx/synth-shared';
import { MessageRole, nowISO, lookupContextWindow, generateId, makeTextPart } from '@itphx/synth-shared';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';
import type { LLMMessage } from '../../providers/base.js';
import { BaseProvider, ProviderFactory } from '../../providers/index.js';
import { info, warning } from '../../logger.js';
import { GatewayProvider, ObfuscationMapStore } from '../gateway/index.js';
import type { AuditLogger, LlmFilterRegistry, RateLimiter } from '../gateway/index.js';
import type { MetricsRegistry } from '../../metrics/registry.js';

export interface SummarizationResult {
  triggered: boolean;
  reason: 'tokens' | 'messages' | 'none';
  currentTokens?: number;
  threshold?: number;
  userCount?: number;
  limit?: number;
}

export interface SlidingWindowResult {
  triggered: boolean;
  reason: 'tokens' | 'messages' | 'none';
  disabledCount?: number;
  currentTokens?: number;
  threshold?: number;
  userCount?: number;
  limit?: number;
}

/**
 * ADR-036: gateway-обвязка для суммаризации. Регистрируется оркестратором через
 * setGatewayHooks — общий AuditLogger/RateLimiter и ObfuscationMapStore сессий.
 * Если hooks не заданы или gateway выключен — суммаризация идёт напрямую.
 */
export interface ContextOptimizerGatewayHooks {
  config: LLMGatewayConfig;
  audit: AuditLogger;
  rateLimiter: RateLimiter;
  obfMapStore: ObfuscationMapStore;
  /** ADR-094: реестр метрик (учёт вызовов суммаризации). */
  metrics?: MetricsRegistry;
  /**
   * PROP-090 §«Точка `llmFilters`»: реестр фильтров LLM-вызовов — суммаризация
   * тоже LLM-вызов, её видит фаза `pre_request` (`GatewayProvider._prepare`).
   */
  filters?: LlmFilterRegistry;
}

function toCoreProviderConfig(shared: SharedProviderConfig, model: string): { url: string; apiKey: string; model: string; timeout?: number; name?: string; type?: string } {
  return {
    name: shared.name,
    type: shared.type,
    url: shared.baseUrl || '',
    apiKey: shared.apiKey || '',
    model,
    timeout: shared.timeout,
  };
}

export class ContextOptimizer {
  private readonly _contextConfig: ContextFileRepository;
  private readonly _providerLoader: (name: string) => SharedProviderConfig | null;
  private readonly _summarizationConfig: SummarizationConfig;
  /**
   * Возвращает сохранённое контекстное окно модели (ModelConfig.contextWindow).
   * Если неизвестно (0/undefined) — ContextOptimizer использует справочник.
   */
  private readonly _modelWindowLoader: ((modelId: string) => number) | null;

  private _summaryCache = new Map<string, { result: Message; hash: string; at: number }>();
  private _gatewayHooks: ContextOptimizerGatewayHooks | null = null;

  // Константа: 4 символа ≈ 1 токен (приблизительно, fallback)
  private static readonly CHARS_PER_TOKEN = 4;

  constructor(
    contextConfig: ContextFileRepository,
    providerLoader: (name: string) => SharedProviderConfig | null,
    summarizationConfig: SummarizationConfig,
    modelWindowLoader?: (modelId: string) => number,
  ) {
    this._contextConfig = contextConfig;
    this._providerLoader = providerLoader;
    this._summarizationConfig = summarizationConfig;
    this._modelWindowLoader = modelWindowLoader ?? null;
  }

  /**
   * ADR-036: регистрирует gateway-обвязку для суммаризации (общий аудит,
   * rate limit, карта обфускации сессий). Вызывается оркестратором.
   */
  setGatewayHooks(hooks: ContextOptimizerGatewayHooks | null): void {
    this._gatewayHooks = hooks;
  }

  // ====================================================================
  // Фильтрация сообщений для LLM
  // ====================================================================

  getMessagesForLlm(session: Session): Message[] {
    const mode = session.settings.contextOptimization;

    switch (mode) {
      case 'sliding_window':
        return this._getMessagesForSlidingWindow(session);
      case 'summarization':
        return this._getMessagesForSummarization(session);
      case 'sticky_notes':
        return this._getMessagesForStickyNotes(session);
      default:
        return session.messages.filter(
          (m) => !m.disabled && !m.hidden && !m.ephemeral && m.role !== MessageRole.INFO,
        );
    }
  }

  // ====================================================================
  // Скользящее окно
  // ====================================================================

  shouldApplySlidingWindow(session: Session): SlidingWindowResult {
    const model = session.settings.model;
    const mode = session.settings.slidingWindowMode;

    if (mode === 'tokens') {
      const threshold = session.settings.slidingWindowTokenThreshold;
      const lastRequestTokens = this._getLastRequestTokens(session);
      const contextWindow = this.getContextWindow(model);
      if (contextWindow > 0 && lastRequestTokens > 0) {
        const tokenThreshold = Math.floor(contextWindow * (threshold / 100));
        if (lastRequestTokens >= tokenThreshold) {
          return { triggered: true, reason: 'tokens', currentTokens: lastRequestTokens, threshold: tokenThreshold };
        }
      }
    } else {
      const limit = session.settings.slidingWindowMessageLimit;
      const userMessages = this._getActiveUserMessages(session.messages);
      if (userMessages.length > limit) {
        return { triggered: true, reason: 'messages', userCount: userMessages.length, limit };
      }
    }

    return { triggered: false, reason: 'none' };
  }

  applySlidingWindow(session: Session): { session: Session; disabledIndices: number[]; disabledCount: number } {
    const model = session.settings.model;
    const mode = session.settings.slidingWindowMode;
    const disabledIndices: number[] = [];
    let disabledCount = 0;

    // Собираем сообщения, которые останутся активными
    let keepMessages: Message[] = [];

    // Всегда сохраняем pinned
    const pinnedMessages = session.messages.filter((m) => m.pinned && !m.disabled);

    // Всегда сохраняем summary-сообщения
    const summaryMessages = session.messages.filter((m) => m.role === MessageRole.SUMMARY && !m.disabled);

    if (mode === 'tokens') {
      const threshold = session.settings.slidingWindowTokenThreshold;
      const contextWindow = this.getContextWindow(model);
      const maxTokens = contextWindow > 0 ? Math.floor(contextWindow * (threshold / 100)) : 128000;
      keepMessages = this._selectWindowByTurns(this._getAllActiveMessages(session), maxTokens);
    } else {
      const limit = session.settings.slidingWindowMessageLimit;
      const userMessages = this._getActiveUserMessages(session.messages);
      if (userMessages.length <= limit) {
        return { session, disabledIndices, disabledCount };
      }

      const cutoffUserIndex = session.messages.indexOf(userMessages[userMessages.length - limit]!);
      const allActive = this._getAllActiveMessages(session);
      keepMessages = allActive.filter((m) => {
        const idx = session.messages.indexOf(m);
        return idx >= cutoffUserIndex;
      });
    }

    const keepSet = new Set([...keepMessages, ...pinnedMessages, ...summaryMessages]);

    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i]!;
      if (msg.disabled) continue;
      if (msg.pinned) continue; // никогда не трогаем
      if (msg.role === MessageRole.SUMMARY) continue; // сохраняем summary-сообщения
      if (!keepSet.has(msg)) {
        msg.disabled = true;
        disabledIndices.push(i);
        disabledCount++;
      }
    }

    if (disabledCount > 0) {
      info('CONTEXT', `Sliding window: disabled ${disabledCount} messages in session ${session.id}`);
    }
    return { session, disabledIndices, disabledCount };
  }

  // ====================================================================
  // Суммаризация
  // ====================================================================

  shouldSummarize(session: Session): SummarizationResult {
    if (!session.settings.summarizationEnabled) {
      return { triggered: false, reason: 'none' };
    }

    const model = session.settings.model;
    const mode = session.settings.summarizationTriggerMode;

    if (mode === 'tokens') {
      const threshold = session.settings.summarizeTokenThreshold;
      const lastRequestTokens = this._getLastRequestTokens(session);
      const contextWindow = this.getContextWindow(model);
      if (contextWindow > 0 && lastRequestTokens > 0) {
        const tokenThreshold = Math.floor(contextWindow * (threshold / 100));
        if (lastRequestTokens >= tokenThreshold) {
          return { triggered: true, reason: 'tokens', currentTokens: lastRequestTokens, threshold: tokenThreshold };
        }
      }
    } else {
      const afterN = session.settings.summarizeAfterN;
      const userCount = this._countUserMessagesSinceSummary(session);
      if (userCount >= afterN) {
        return { triggered: true, reason: 'messages', userCount, limit: afterN };
      }
    }

    return { triggered: false, reason: 'none' };
  }

  async summarize(session: Session): Promise<Message> {
    const lang = session.settings.language || 'ru';
    const headCount = session.settings.summarizationHeadMessages;
    const tailCount = session.settings.summarizationTailMessages;

    const prep = this._prepareSummarization(session, lang, headCount, tailCount);

    const cacheKey = `${session.id}:${prep.indices.join(',')}`;
    const contentHash = this._simpleHash(prep.llmMessages.map((m) => m.content).join('||'));
    const cached = this._summaryCache.get(cacheKey);
    if (cached && cached.hash === contentHash) {
      return cached.result;
    }

    const response = await prep.provider.chat(prep.llmMessages, prep.summarizerPrompt);
    info('CONTEXT', `Summarization complete for session ${session.id}`);

    const result: Message = {
      id: generateId(),
      role: MessageRole.SUMMARY,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(response.content)],
      content: response.content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      summaryOf: prep.indices,
      model: response.model,
      usage: response.usage,
      metadata: { type: 'auto_summary' },
    };

    this._summaryCache.set(cacheKey, { result, hash: contentHash, at: Date.now() });
    return result;
  }

  private _simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return hash.toString(36);
  }

  async *summarizeStream(session: Session): AsyncGenerator<
    | { type: 'chunk'; content: string; model?: string; provider?: string }
    | { type: 'done'; content: string; model: string; usage: import('@itphx/synth-shared').TokenUsage; indices: number[]; provider: string }
    | { type: 'error'; error: string }
  > {
    const lang = session.settings.language || 'ru';
    const headCount = session.settings.summarizationHeadMessages;
    const tailCount = session.settings.summarizationTailMessages;

    try {
      const prep = this._prepareSummarization(session, lang, headCount, tailCount);
      let content = '';
      let model = prep.provider.model;
      let usage: import('@itphx/synth-shared').TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      for await (const chunk of prep.provider.chatAsync(prep.llmMessages, prep.summarizerPrompt)) {
        // Финальный чанк несёт полный накопленный контент — заменяем, а не складываем,
        // и не отдаём его как отдельный фрагмент (иначе контент удваивается).
        content = chunk.isFinal && chunk.content ? chunk.content : content + chunk.content;
        yield { type: 'chunk', content: chunk.isFinal ? '' : chunk.content, model: prep.provider.model, provider: prep.provider.name };
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
      }

      info('CONTEXT', `Summarization complete for session ${session.id}`);

      yield {
        type: 'done',
        content,
        model,
        usage,
        indices: prep.indices,
        provider: prep.provider.name,
      };
    } catch (e) {
      yield { type: 'error', error: String(e) };
    }
  }

  private _prepareSummarization(
    session: Session,
    lang: string,
    headCount: number,
    tailCount: number,
  ): {
    provider: BaseProvider;
    llmMessages: LLMMessage[];
    summarizerPrompt: string;
    messagesToSummarize: Message[];
    indices: number[];
  } {
    // 1. Найти индекс последнего summary
    const lastSummaryIdx = this._findLastSummaryIndex(session.messages);

    // 2. Собрать сообщения для суммаризации
    const messagesToSummarize = this._getMessagesToSummarize(session.messages, lastSummaryIdx);

    if (messagesToSummarize.length === 0) {
      throw new Error('No messages to summarize');
    }

    // 3. Формирование запроса
    const promptParts: string[] = [];
    const summarizerPrompt = this._contextConfig.getSummarizerPrompt(lang);
    if (!summarizerPrompt) {
      throw new Error('Summarizer prompt not found');
    }

    // Предыдущее резюме
    if (lastSummaryIdx >= 0) {
      const prevSummary = session.messages[lastSummaryIdx]!;
      promptParts.push(`## Предыдущее резюме\n${prevSummary.content}`);
    }

    const totalPairs = Math.ceil(messagesToSummarize.length / 2);
    const totalToShow = headCount + tailCount;

    if (totalPairs <= totalToShow) {
      const formatted = this._formatMessagesForSummarization(messagesToSummarize);
      promptParts.push(`## Диалог\n${formatted}`);
    } else {
      const tailStart = messagesToSummarize.length - (tailCount * 2);
      const headMessages = messagesToSummarize.slice(0, headCount * 2);
      const tailMessages = messagesToSummarize.slice(Math.max(tailStart, headCount * 2));
      const skippedCount = messagesToSummarize.length - headMessages.length - tailMessages.length;

      if (headMessages.length > 0) {
        promptParts.push(`## Первые сообщения\n${this._formatMessagesForSummarization(headMessages)}`);
      }
      if (skippedCount > 0) {
        promptParts.push(`[... ${skippedCount} сообщений опущено ...]`);
      }
      if (tailMessages.length > 0) {
        promptParts.push(`## Последние сообщения\n${this._formatMessagesForSummarization(tailMessages)}`);
      }
    }

    const userContent = promptParts.join('\n\n');

    // 4. Создать провайдера
    const provider = this._createSummarizationProvider(session);
    if (!provider) {
      throw new Error('Failed to create summarization provider');
    }

    // 5. LLM-сообщения
    const llmMessages: LLMMessage[] = [{
      id: '',
      role: 'user',
      content: userContent,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      disabled: false,
      pinned: false,
      branchId: '',
    }];

    info('CONTEXT', `Summarizing ${messagesToSummarize.length} messages in session ${session.id}`);

    // 6. Индексы сообщений для последующего отключения
    const indices: number[] = [];
    for (const msg of messagesToSummarize) {
      const idx = session.messages.indexOf(msg);
      if (idx >= 0) indices.push(idx);
    }

    return { provider, llmMessages, summarizerPrompt, messagesToSummarize, indices };
  }

  // ====================================================================
  // Утилиты
  // ====================================================================

  estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this._estimateMessageTokens(msg);
    }
    return total;
  }

  getContextWindow(modelId?: string): number {
    if (!modelId) return 0;
    // Приоритет: сохранённое окно модели (ModelConfig.contextWindow из API/вручную),
    // иначе справочник известных моделей.
    const saved = this._modelWindowLoader?.(modelId) ?? 0;
    if (saved > 0) return saved;
    const result = lookupContextWindow(modelId);
    return result.window;
  }

  // ====================================================================
  // Приватные методы
  // ====================================================================

  private _getAllActiveMessages(session: Session): Message[] {
    return session.messages.filter((m) => !m.disabled && !m.hidden && !m.ephemeral && m.role !== 'summary' && m.role !== 'info');
  }

  private _getActiveUserMessages(messages: Message[]): Message[] {
    return messages.filter((m) => m.role === MessageRole.USER && !m.disabled && !m.hidden && !m.ephemeral);
  }

  private _estimateMessageTokens(msg: Message): number {
    if (msg.usage?.totalTokens) return msg.usage.totalTokens;
    return Math.ceil(msg.content.length / ContextOptimizer.CHARS_PER_TOKEN);
  }

  /**
   * Группирует подряд идущие сообщения с одинаковым metadata.stream_id в одну
   * группу («ход»); сообщение без stream_id — отдельная группа (singleton).
   * «Ход» = user-сообщение + вся его tool-chain + финальный ответ (все делят
   * stream_id и идут подряд).
   */
  private _groupTurnsByStreamId(messages: Message[]): Message[][] {
    const groups: Message[][] = [];
    let current: Message[] = [];
    let currentStreamId: string | undefined;
    for (const m of messages) {
      const streamId = m.metadata?.stream_id as string | undefined;
      if (streamId === undefined || streamId !== currentStreamId) {
        if (current.length > 0) groups.push(current);
        current = [m];
        currentStreamId = streamId;
      } else {
        current.push(m);
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  /**
   * Выбирает сообщения для токен-окна по «ходам»: группы с конца добавляются
   * целиком, пока хватает бюджета. Самая свежая группа добавляется всегда —
   * tool-chain никогда не обрезается на середине (иначе невалидный
   * OpenAI-диалог: assistant(toolUse) без tool-результатов и наоборот).
   */
  private _selectWindowByTurns(allActive: Message[], maxTokens: number): Message[] {
    const groups = this._groupTurnsByStreamId(allActive);
    const windowMessages: Message[] = [];
    let cumulative = 0;
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]!;
      const groupTokens = group.reduce((sum, m) => sum + this._estimateMessageTokens(m), 0);
      if (cumulative + groupTokens <= maxTokens || windowMessages.length === 0) {
        windowMessages.unshift(...group);
        cumulative += groupTokens;
      } else {
        break;
      }
    }
    return windowMessages;
  }

  private _getLastRequestTokens(session: Session): number {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]!;
      if (msg.role === 'assistant' && !msg.disabled && msg.usage?.inputTokens) {
        return msg.usage.inputTokens;
      }
    }
    return 0;
  }

  private _findLastSummaryIndex(messages: Message[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === MessageRole.SUMMARY) return i;
    }
    return -1;
  }

  private _countUserMessagesSinceSummary(session: Session): number {
    const lastSummaryIdx = this._findLastSummaryIndex(session.messages);
    const startIdx = lastSummaryIdx >= 0 ? lastSummaryIdx + 1 : 0;
    let count = 0;
    for (let i = startIdx; i < session.messages.length; i++) {
      const msg = session.messages[i]!;
      if (msg.role === MessageRole.USER && !msg.disabled && !msg.hidden) count++;
    }
    return count;
  }

  private _getMessagesToSummarize(messages: Message[], lastSummaryIdx: number): Message[] {
    const startIdx = lastSummaryIdx >= 0 ? lastSummaryIdx + 1 : 0;
    const result: Message[] = [];
    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.pinned) continue; // никогда не суммаризируем pinned
      if (msg.disabled || msg.hidden || msg.ephemeral) continue;
      if (msg.role === MessageRole.USER || msg.role === MessageRole.ASSISTANT) {
        result.push(msg);
      }
    }
    return result;
  }

  private _formatMessagesForSummarization(messages: Message[]): string {
    const lines: string[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const roleLabel = msg.role === 'user' ? 'Пользователь' : 'AI';
      lines.push(`[${i + 1}] ${roleLabel}: ${msg.content}`);
    }
    return lines.join('\n\n');
  }

  private _getMessagesForSlidingWindow(session: Session): Message[] {
    const allActive = this._getAllActiveMessages(session);
    const pinnedActive = session.messages.filter((m) => m.pinned && !m.disabled && !m.hidden && !m.ephemeral);
    const summaryActive = session.messages.filter((m) => m.role === MessageRole.SUMMARY && !m.disabled && !m.hidden && !m.ephemeral);
    const mode = session.settings.slidingWindowMode;

    let windowMessages: Message[];
    if (mode === 'tokens') {
      const threshold = session.settings.slidingWindowTokenThreshold;
      const contextWindow = this.getContextWindow(session.settings.model);
      const maxTokens = contextWindow > 0 ? Math.floor(contextWindow * (threshold / 100)) : 128000;
      windowMessages = this._selectWindowByTurns(allActive, maxTokens);
    } else {
      const limit = session.settings.slidingWindowMessageLimit;
      const userMessages = this._getActiveUserMessages(allActive);
      if (userMessages.length <= limit) return [...allActive, ...summaryActive];
      const cutoff = userMessages[userMessages.length - limit]!;
      const cutoffIdx = allActive.indexOf(cutoff);
      windowMessages = allActive.filter((_m, i) => i >= cutoffIdx);
    }

    // pinned и summary всегда добавляются
    const resultSet = new Set([...windowMessages, ...pinnedActive, ...summaryActive]);
    // Сохраняем порядок
    return session.messages.filter((m) => resultSet.has(m));
  }

  private _getMessagesForSummarization(session: Session): Message[] {
    const result: Message[] = [];
    const lastSummaryIdx = this._findLastSummaryIndex(session.messages);

    if (lastSummaryIdx >= 0) {
      result.push(session.messages[lastSummaryIdx]!);
    }

    const startIdx = lastSummaryIdx >= 0 ? lastSummaryIdx + 1 : 0;
    for (let i = startIdx; i < session.messages.length; i++) {
      const msg = session.messages[i]!;
      if (msg.disabled || msg.hidden || msg.ephemeral) continue;
      if (msg.role === MessageRole.INFO) continue;
      result.push(msg);
    }

    return result;
  }

  private _getMessagesForStickyNotes(session: Session): Message[] {
    const active = this._getAllActiveMessages(session);
    const limit = 6;
    const summaryActive = session.messages.filter((m) => m.role === MessageRole.SUMMARY && !m.disabled && !m.hidden && !m.ephemeral);

    if (active.length <= limit) return [...active, ...summaryActive];

    const result = active.slice(-limit);
    return [...result, ...summaryActive];
  }

  private _createSummarizationProvider(session: Session): BaseProvider | null {
    const providerName = this._summarizationConfig.provider || session.settings.provider || '';
    const modelName = this._summarizationConfig.model || session.settings.model || '';

    if (!providerName || !modelName) {
      warning('CONTEXT', 'Cannot create summarization provider: no provider or model configured');
      return null;
    }

    const sharedConfig = this._providerLoader(providerName);
    if (!sharedConfig) {
      warning('CONTEXT', `Summarization provider "${providerName}" not found`);
      return null;
    }

    try {
      const provider = ProviderFactory.create(
        providerName,
        toCoreProviderConfig(sharedConfig, modelName),
        this._summarizationConfig.temperature,
      );
      return this._wrapWithGateway(provider, session);
    } catch (e) {
      warning('CONTEXT', `Failed to create summarization provider: ${e}`);
      return null;
    }
  }

  /**
   * ADR-036: оборачивает провайдер суммаризации в GatewayProvider по тому же
   * паттерну, что оркестратор в _wrapWithGateway. sessionId/userId берутся из
   * текущей сессии — карта обфускации привязывается к сессии.
   */
  private _wrapWithGateway(provider: BaseProvider, session: Session): BaseProvider {
    const hooks = this._gatewayHooks;
    if (!hooks) return provider;
    return new GatewayProvider(provider, hooks.config, {
      getMap: () => hooks.obfMapStore.get(session.id),
      saveMap: (map) => hooks.obfMapStore.set(session.id, map),
      getAudit: () => hooks.audit,
      getRateLimiter: () => hooks.rateLimiter,
      sessionId: session.id,
      userId: session.userId ?? '',
      metrics: hooks.metrics,
      filters: hooks.filters,
    });
  }

  /**
   * Проверяет, можно ли выполнить суммаризацию в текущей сессии.
   * Должно быть ≥3 активных не-summary сообщений с последнего summary.
   */
  canSummarize(session: Session): boolean {
    if (!session.settings.provider || !session.settings.model) return false;

    const lastSummaryIdx = this._findLastSummaryIndex(session.messages);
    const startIdx = lastSummaryIdx >= 0 ? lastSummaryIdx + 1 : 0;
    const activeSinceLast = session.messages.slice(startIdx)
      .filter((m) => !m.disabled && !m.hidden && !m.ephemeral && m.role !== MessageRole.INFO && m.role !== MessageRole.SUMMARY);

    return activeSinceLast.length >= 3;
  }

  /**
   * Подготавливает суммаризацию и возвращает данные для processMessage.
   * Вызывается оркестратором для system-сообщений типа summarization_request.
   */
  prepareSummarizationForOrchestrator(
    session: Session,
    lang: string,
  ): {
    provider: BaseProvider;
    llmMessages: LLMMessage[];
    summarizerPrompt: string;
    messagesToSummarize: Message[];
    indices: number[];
  } {
    const headCount = session.settings.summarizationHeadMessages;
    const tailCount = session.settings.summarizationTailMessages;
    return this._prepareSummarization(session, lang, headCount, tailCount);
  }
}
