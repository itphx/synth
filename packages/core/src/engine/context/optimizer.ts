import type {
  Message,
  Session,
  ProviderConfig as SharedProviderConfig,
  SummarizationConfig,
  LLMGatewayConfig,
  LlmFinishReason,
  LLMResponse,
  TokenUsage,
} from '@itphx/synth-shared';
import {
  MessageRole,
  nowISO,
  lookupContextWindow,
  generateId,
  makeTextPart,
  DEFAULT_CONTEXT_WINDOW,
} from '@itphx/synth-shared';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';
import type { LLMMessage } from '../../providers/base.js';
import { BaseProvider, ProviderFactory } from '../../providers/index.js';
import { info, warning } from '../../logger.js';
import { GatewayProvider, ObfuscationMapStore } from '../gateway/index.js';
import type { AuditLogger, LlmFilterRegistry, RateLimiter } from '../gateway/index.js';
import type { MetricsRegistry } from '../../metrics/registry.js';
import { toCoreProviderConfig } from '../router/utils.js';
import { resolveMaxOutputTokens } from '../orchestrator/max-output.js';
import { t as sm } from '../system-messages.js';

/**
 * Профиль сжатия контекста:
 * - `summarization` — итоги беседы (обобщённые выводы, в т.ч. по tool-вызовам);
 * - `compaction` — рабочее состояние по коду/проекту (пути, команды, ошибки).
 */
export type CompressionMode = 'summarization' | 'compaction';

export interface SummarizationResult {
  triggered: boolean;
  reason: 'tokens' | 'messages' | 'none';
  /** Эффективный профиль (аддитивно; `null` — сжатие не настроено). */
  mode?: CompressionMode | null;
  currentTokens?: number;
  threshold?: number;
  userCount?: number;
  limit?: number;
}

/** Результат проверки триггера сжатия (оба профиля). */
export interface CompressionTriggerResult {
  triggered: boolean;
  reason: 'messages' | 'tokens' | 'none';
  mode: CompressionMode | null;
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
 * План сжатия: всё, что нужно для одного вызова суммаризатора/компактора.
 * Отключение сообщений делает вызывающий код (см. `disableCompressedMessages`).
 */
export interface CompressionPlan {
  mode: CompressionMode;
  provider: BaseProvider;
  llmMessages: LLMMessage[];
  /** Промпт суммаризатора/компактора. */
  systemPrompt: string;
  messagesToCompress: Message[];
  /** Индексы `session.messages`, покрытые резюме (без pinned). */
  coveredIndices: number[];
  /** Индекс первого живого сообщения; `-1` — хвоста нет. */
  keepFromIndex: number;
  keepFromId?: string;
  /** Живые сообщения хвоста (для mid-loop overflow и диагностики). */
  keepMessages: Message[];
}

/** Опции подготовки плана сжатия. */
export interface CompressionPrepareOptions {
  /** Профиль; по умолчанию — эффективный режим сессии. */
  mode?: CompressionMode;
  /** Нижняя граница хвоста: сообщения с этим индексом и позже не покрываются. */
  minKeepFromIndex?: number;
  /** Явный бюджет хвоста в токенах (переопределяет настройку режима). */
  keepTokens?: number;
}

/** Обязательные заголовки шаблона компактизации. */
export const COMPACTION_TEMPLATE_HEADINGS = [
  '## Objective',
  '## Requirements',
  '## Decisions',
  '## Work State',
  '## Next Move',
  '## Relevant Files',
  '## Important Context',
] as const;

/** Минимальная длина содержательного резюме (символов). */
const MIN_SUMMARY_LENGTH = 20;

/** Напоминание модели при нарушении формата (один nudge-повтор). */
const COMPRESSION_FORMAT_NUDGE: Record<CompressionMode, string> = {
  summarization:
    'Предыдущий ответ не был содержательным резюме. Верни структурированный итог '
    + 'беседы (## О чём говорили / ## К чему пришли / ## Открытые вопросы / ## Следующие шаги).',
  compaction:
    'Предыдущий ответ не соответствовал обязательному шаблону. Верни ответ строго '
    + 'с заголовками: ## Objective, ## Requirements, ## Decisions, ## Work State, '
    + '## Next Move, ## Relevant Files, ## Important Context.',
};

/** Капы рендера транскрипта (M8): аргументы/результаты инструментов. */
interface TranscriptCaps {
  argCap: number;
  resultCap: number;
  successCap: number;
}

/** Языковые метки транскрипта (m2). */
function compressionTranscriptLabels(lang: string): {
  user: string;
  assistant: string;
  toolCall: string;
  toolResult: string;
  attachment: string;
  chars: string;
  empty: string;
} {
  if (lang.toLowerCase().startsWith('en')) {
    return {
      user: '[User]',
      assistant: '[Assistant]',
      toolCall: '[Tool call]',
      toolResult: '[Tool result]',
      attachment: '[Attachment: ',
      chars: 'chars',
      empty: '(empty)',
    };
  }
  return {
    user: '[Пользователь]',
    assistant: '[Ассистент]',
    toolCall: '[Вызов]',
    toolResult: '[Результат]',
    attachment: '[Вложение: ',
    chars: 'символов',
    empty: '(пусто)',
  };
}

/** Маркер выброшенных старых сообщений (M8, уровень 4). */
function compressionOmittedMarker(count: number, lang: string): string {
  return lang.toLowerCase().startsWith('en')
    ? `[... ${count} older messages omitted ...]`
    : `[… ${count} старых сообщений опущено …]`;
}

/** Проверка формата/содержания ответа сжатия. */
export function validateCompressionContent(
  mode: CompressionMode,
  content: string,
): { ok: true } | { ok: false; reason: string } {
  const text = (content ?? '').trim();
  if (mode === 'summarization') {
    if (text.length < MIN_SUMMARY_LENGTH) {
      return { ok: false, reason: `summary too short (${text.length} < ${MIN_SUMMARY_LENGTH})` };
    }
    return { ok: true };
  }
  const headings = COMPACTION_TEMPLATE_HEADINGS.filter((heading) => text.includes(heading));
  if (headings.length < 2) {
    return { ok: false, reason: `compaction template mismatch (${headings.length}/2 headings)` };
  }
  return { ok: true };
}

/**
 * Понятная ошибка для причин завершения, несовместимых с ответом сжатия.
 * `null` — причина допустима.
 */
export function compressionFinishReasonError(
  mode: CompressionMode,
  reason: LlmFinishReason | undefined,
): string | null {
  if (reason === 'max_tokens' || reason === 'length') {
    return sm('context.compression_output_limit');
  }
  if (reason === 'content_filter') {
    return sm('context.compression_failed', { mode, reason: 'content_filter' });
  }
  return null;
}

/**
 * ADR-036/ADR-119: gateway-обвязка для суммаризации. Регистрируется
 * оркестратором через setGatewayHooks — общий AuditLogger/RateLimiter и
 * ObfuscationMapStore сессий. Hooks задаются **всегда** (инвариант 3): при
 * выключенном gateway используется `DISABLED_GATEWAY_CONFIG`, то есть вызов
 * идёт passthrough (guard/обфускация no-op), но через `GatewayProvider` —
 * учитывается метриками и проходит общий контур фильтров при включении gateway.
 * `hooks === null` — только прямое использование оптимизатора без оркестратора.
 */
export interface ContextOptimizerGatewayHooks {
  config: LLMGatewayConfig;
  audit: AuditLogger;
  rateLimiter: RateLimiter;
  obfMapStore: ObfuscationMapStore;
  /** ADR-094: реестр метрик (учёт вызовов суммаризации). */
  metrics?: MetricsRegistry;
  /**
   * ADR-090: реестр фильтров LLM-вызовов — суммаризация
   * тоже LLM-вызов, её видит фаза `pre_request` (`GatewayProvider._prepare`).
   */
  filters?: LlmFilterRegistry;
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
      case 'compaction':
        return this._getMessagesForSummarization(session);
      case 'sticky_notes':
        return this._getMessagesForStickyNotes(session);
      default:
        // Легаси-фоллбек: сохранённая сессия с `summarizationEnabled` и
        // `contextOptimization: 'none'` продолжает вести себя как суммаризация.
        if (this.effectiveMode(session) === 'summarization') {
          return this._getMessagesForSummarization(session);
        }
        return session.messages.filter(
          (m) => !m.disabled && !m.hidden && !m.ephemeral && m.role !== MessageRole.INFO,
        );
    }
  }

  // ====================================================================
  // Эффективный режим и триггеры сжатия
  // ====================================================================

  /**
   * Эффективный профиль сжатия. `null` — сжатие не настроено.
   *
   * Легаси-фоллбек: `contextOptimization: 'none'` + `summarizationEnabled: true`
   * у сохранённой сессии = `summarization` (старые сессии не ломаем).
   */
  effectiveMode(session: Session): CompressionMode | null {
    const opt = session.settings.contextOptimization;
    if (opt === 'summarization' || opt === 'compaction') return opt;
    if (opt === 'none' && session.settings.summarizationEnabled === true) return 'summarization';
    return null;
  }

  /**
   * Единый триггер сжатия для обоих профилей.
   *
   * - суммаризация: `messages` (N реплик с последнего summary) или `tokens`
   *   (% окна);
   * - компактизация: только токены, порог `window - max((100 - pct)% окна, 16000)`.
   *   Неизвестное окно (`0`) считается оценкой `DEFAULT_CONTEXT_WINDOW` (та же,
   *   что показывает UI), а не «триггер отключён»; явное окно модели приоритетнее.
   *   Порог не клампится в 1 токен: на малых окнах резерв съедает окно и
   *   авто-триггер выключается (`force`/overflow работают).
   */
  shouldCompress(session: Session): CompressionTriggerResult {
    const mode = this.effectiveMode(session);
    if (!mode) return { triggered: false, reason: 'none', mode: null };

    if (mode === 'summarization') {
      // m4: источник истины — `contextOptimization`; `summarizationEnabled`
      // больше не гейтит явный режим (флаг остаётся только для легаси-фоллбека
      // `none + summarizationEnabled` в `effectiveMode`).
      if (session.settings.summarizationTriggerMode === 'tokens') {
        const thresholdPct = session.settings.summarizeTokenThreshold;
        const contextWindow = this._effectiveContextWindow(session.settings.model);
        const currentTokens = this.estimatePromptTokens(session);
        if (currentTokens > 0) {
          const threshold = Math.floor(contextWindow * (thresholdPct / 100));
          if (currentTokens >= threshold) {
            return {
              triggered: true,
              reason: 'tokens',
              mode,
              currentTokens,
              threshold,
            };
          }
        }
        return { triggered: false, reason: 'none', mode, currentTokens };
      }

      const limit = session.settings.summarizeAfterN;
      const userCount = this._countUserMessagesSinceSummary(session);
      if (userCount >= limit) {
        return { triggered: true, reason: 'messages', mode, userCount, limit };
      }
      return { triggered: false, reason: 'none', mode, userCount, limit };
    }

    // Компактизация — только токены.
    const contextWindow = this._effectiveContextWindow(session.settings.model);
    const pct = this._compactionThresholdPercent(session);
    const reserve = Math.max(Math.floor(contextWindow * ((100 - pct) / 100)), 16000);
    // M7: на малых окнах (8k/16k) резерв съедает всё окно — авто-триггер
    // бессмысленен (не клампим порог в 1 токен). Force/overflow работает.
    if (reserve >= contextWindow) {
      return { triggered: false, reason: 'none', mode, currentTokens: this.estimatePromptTokens(session) };
    }
    const threshold = Math.max(1, contextWindow - reserve);
    const currentTokens = this.estimatePromptTokens(session);
    if (currentTokens >= threshold) {
      return { triggered: true, reason: 'tokens', mode, currentTokens, threshold };
    }
    return { triggered: false, reason: 'none', mode, currentTokens, threshold };
  }

  /**
   * Оценка объёма текущего промпта в токенах.
   *
   * База — `usage` последнего assistant-сообщения **той же модели/провайдера**
   * (`input + cacheRead + cacheWrite + output + reasoning`), плюс оценка всех
   * активных сообщений после него. Нет измеренного сообщения — оценка всей
   * выборки `getMessagesForLlm`.
   */
  estimatePromptTokens(session: Session): number {
    const lastSummaryIdx = this._findLastSummaryIndex(session.messages);
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]!;
      if (msg.role !== MessageRole.ASSISTANT) continue;
      if (msg.disabled || msg.hidden || msg.ephemeral) continue;
      if (!msg.usage) continue;
      if (session.settings.model && msg.model && msg.model !== session.settings.model) continue;
      if (
        session.settings.provider
        && msg.provider
        && msg.provider !== session.settings.provider
      ) {
        continue;
      }
      // M2: измерение на промпте ДО последнего сжатия неактуально (сообщение
      // покрыто резюме) — оцениваем текущую выборку, не используя старый usage.
      if (lastSummaryIdx >= 0 && i <= lastSummaryIdx) {
        return this.estimateTokens(this.getMessagesForLlm(session));
      }
      const usage = msg.usage;
      // M1: нормализация провайдеров уже включает cache в inputTokens, а
      // reasoning — в outputTokens. Не суммируем повторно.
      const input = usage.inputTokens || 0;
      const output = usage.outputTokens || 0;
      let measured = input + output;
      if (measured <= 0) measured = usage.totalTokens || 0;
      if (measured <= 0) continue;

      const tail = session.messages
        .slice(i + 1)
        .filter((m) => !m.disabled && !m.hidden && !m.ephemeral && m.role !== MessageRole.INFO);
      return measured + this.estimateTokens(tail);
    }
    return this.estimateTokens(this.getMessagesForLlm(session));
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
      const contextWindow = this._effectiveContextWindow(model);
      if (lastRequestTokens > 0) {
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
  // Суммаризация / компактизация
  // ====================================================================

  shouldSummarize(session: Session): SummarizationResult {
    const result = this.shouldCompress(session);
    if (result.mode !== 'summarization') {
      return { triggered: false, reason: 'none', mode: result.mode ?? null };
    }
    return { ...result };
  }

  /**
   * Подготовить план сжатия. Бросает, если сжимать нечего/нет провайдера/промпта.
   *
   * Отключение покрытых сообщений делает вызывающий код — здесь только план.
   */
  prepareCompression(
    session: Session,
    lang = 'ru',
    opts: CompressionPrepareOptions = {},
  ): CompressionPlan {
    const explicitMode = opts.mode;
    const mode = explicitMode ?? this.effectiveMode(session);
    if (!mode) {
      // M4: без явного профиля и без эффективного режима сжимать нельзя —
      // overflow падает штатной `context_length`, история не мутируется.
      throw new Error(
        sm('context.compression_failed', { mode: 'none', reason: 'mode_disabled' }),
      );
    }
    const boundary = this._buildCompressionBoundary(
      session,
      mode,
      opts.minKeepFromIndex,
      opts.keepTokens,
    );

    if (boundary.coveredIndices.length === 0) {
      throw new Error(sm('context.compression_empty'));
    }

    const provider = this._createSummarizationProvider(session);
    if (!provider) {
      throw new Error(sm('context.compression_failed', { mode, reason: 'provider_unavailable' }));
    }

    const systemPrompt = mode === 'compaction'
      ? this._contextConfig.getCompactorPrompt(lang)
      : this._contextConfig.getSummarizerPrompt(lang);
    if (!systemPrompt.trim()) {
      throw new Error(sm('context.compression_failed', { mode, reason: 'prompt_not_found' }));
    }

    const promptParts: string[] = [];
    const lastSummaryIdx = this._findLastSummaryIndex(session.messages);
    const prevSummaryBlock = lastSummaryIdx >= 0
      ? `## Предыдущее резюме\n${session.messages[lastSummaryIdx]!.content}`
      : '';
    if (prevSummaryBlock) promptParts.push(prevSummaryBlock);

    const tailHeader = mode === 'compaction'
      ? '## Последние сообщения (останутся у агента дословно)\n'
        + 'Не пересказывай их, но используй для Work State и Next Move.\n\n'
      : '';
    let tailTranscript: string | undefined;
    if (mode === 'compaction' && boundary.keepMessages.length > 0) {
      const candidate = this._renderCompressionTranscript(
        boundary.keepMessages,
        mode,
        lang,
        this._compressionCaps(mode, 0),
      );
      if (this._tailFits(session, promptParts.join('\n\n'), candidate, systemPrompt)) {
        tailTranscript = candidate;
      }
    }

    // M8: бюджет запроса сжатия. Окно — модель компрессора; резерв max(4000,
    // 20% окна) на ответ и промпт. Без известного окна бюджет не применяем.
    const compressionModel = provider.model || session.settings.model || '';
    const window = this.getContextWindow(compressionModel);
    let maxTranscriptChars = Number.POSITIVE_INFINITY;
    if (window > 0) {
      const reserve = Math.max(4000, Math.floor(window * 0.2));
      const budgetTokens = Math.max(0, window - reserve);
      const tailTokens = tailTranscript ? Math.ceil(tailTranscript.length / 4) : 0;
      const tailHeaderTokens = tailTranscript ? Math.ceil(tailHeader.length / 4) : 0;
      const promptTokens = Math.ceil(systemPrompt.length / 4)
        + Math.ceil(prevSummaryBlock.length / 4)
        + Math.ceil('## Диалог\n'.length / 4)
        + tailTokens
        + tailHeaderTokens;
      maxTranscriptChars = Math.max(0, (budgetTokens - promptTokens) * 4);
    }

    const baseTranscript = this._renderCompressionTranscriptBounded(
      boundary.messages,
      mode,
      lang,
      maxTranscriptChars,
    );
    promptParts.push(`## Диалог\n${baseTranscript}`);
    if (tailTranscript) promptParts.push(`${tailHeader}${tailTranscript}`);

    const userContent = promptParts.join('\n\n');
    const llmMessages: LLMMessage[] = [{
      id: '',
      role: 'user',
      content: userContent,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      disabled: false,
      pinned: false,
      branchId: '',
    }];

    info(
      'CONTEXT',
      `Compression (${mode}): ${boundary.messages.length} messages, `
        + `keep ${boundary.keepMessages.length}, session ${session.id}`,
    );

    return {
      mode,
      provider,
      llmMessages,
      systemPrompt,
      messagesToCompress: boundary.messages,
      coveredIndices: boundary.coveredIndices,
      keepFromIndex: boundary.keepFromIndex,
      ...(boundary.keepFromId ? { keepFromId: boundary.keepFromId } : {}),
      keepMessages: boundary.keepMessages,
    };
  }

  /**
   * Непотоковый вызов сжатия с валидацией ответа и одним nudge-повтором
   * (компактизация — обязательный шаблон; суммаризация — непустой ответ).
   */
  async completeCompression(
    plan: CompressionPlan,
  ): Promise<{ content: string; response: LLMResponse }> {
    let response = await plan.provider.chat(plan.llmMessages, plan.systemPrompt);
    const finishError = compressionFinishReasonError(plan.mode, response.finishReason);
    if (finishError) throw new Error(finishError);

    let validation = validateCompressionContent(plan.mode, response.content);
    if (!validation.ok) {
      const nudgePrompt = `${plan.systemPrompt}\n\n${COMPRESSION_FORMAT_NUDGE[plan.mode]}`;
      response = await plan.provider.chat(plan.llmMessages, nudgePrompt);
      const secondFinishError = compressionFinishReasonError(plan.mode, response.finishReason);
      if (secondFinishError) throw new Error(secondFinishError);
      validation = validateCompressionContent(plan.mode, response.content);
    }
    if (!validation.ok) {
      throw new Error(
        plan.mode === 'compaction'
          ? sm('context.compression_template')
          : sm('context.compression_failed', { mode: plan.mode, reason: validation.reason }),
      );
    }
    return { content: response.content, response };
  }

  async summarize(session: Session): Promise<Message> {
    const lang = session.settings.language || 'ru';
    const plan = this.prepareCompression(session, lang, {
      mode: 'summarization',
      keepTokens: 0,
    });

    const cacheKey = `${session.id}:${plan.mode}:${plan.coveredIndices.join(',')}`;
    const contentHash = this._simpleHash(plan.llmMessages.map((m) => m.content).join('||'));
    const cached = this._summaryCache.get(cacheKey);
    if (cached && cached.hash === contentHash) {
      return cached.result;
    }

    const { content, response } = await this.completeCompression(plan);
    info('CONTEXT', `Summarization complete for session ${session.id}`);

    const result: Message = {
      id: generateId(),
      role: MessageRole.SUMMARY,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(content)],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      summaryOf: plan.coveredIndices,
      model: response.model,
      usage: response.usage,
      metadata: { type: 'auto_summary', mode: plan.mode },
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
    | {
      type: 'done';
      content: string;
      model: string;
      usage: TokenUsage;
      indices: number[];
      provider: string;
      mode: CompressionMode;
    }
    | { type: 'error'; error: string }
  > {
    const lang = session.settings.language || 'ru';

    try {
      const plan = this.prepareCompression(session, lang, {
        mode: 'summarization',
        keepTokens: 0,
      });
      let content = '';
      let model = plan.provider.model;
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      for await (const chunk of plan.provider.chatAsync(plan.llmMessages, plan.systemPrompt)) {
        // Финальный чанк несёт полный накопленный контент — заменяем, а не складываем,
        // и не отдаём его как отдельный фрагмент (иначе контент удваивается).
        content = chunk.isFinal && chunk.content ? chunk.content : content + chunk.content;
        yield {
          type: 'chunk',
          content: chunk.isFinal ? '' : chunk.content,
          model: plan.provider.model,
          provider: plan.provider.name,
        };
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
      }

      info('CONTEXT', `Summarization complete for session ${session.id}`);

      yield {
        type: 'done',
        content,
        model,
        usage,
        indices: plan.coveredIndices,
        provider: plan.provider.name,
        mode: plan.mode,
      };
    } catch (e) {
      yield { type: 'error', error: String(e) };
    }
  }

  /** @deprecated Используйте `prepareCompression` (возвращает тот же план). */
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
    const plan = this.prepareCompression(session, lang, { mode: 'summarization', keepTokens: 0 });
    return {
      provider: plan.provider,
      llmMessages: plan.llmMessages,
      summarizerPrompt: plan.systemPrompt,
      messagesToSummarize: plan.messagesToCompress,
      indices: plan.coveredIndices,
    };
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

  /**
   * Сохранённое окно модели или справочник; `0` — окно **неизвестно** (это не
   * «включено/выключено», а факт отсутствия данных).
   */
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

  /**
   * Окно для авто-триггеров: явно заданное окно модели, иначе
   * `DEFAULT_CONTEXT_WINDOW` — та же оценка, что показывает UI.
   *
   * Используется только триггерами (`shouldCompress`, `shouldApplySlidingWindow`).
   * Лимиты транскрипта/бюджеты сжатия остаются на `getContextWindow` (там `0`
   * означает «неизвестно, не ограничиваем»).
   *
   * Риск осознан: у модели с реальным окном больше 200k сжатие наступит раньше
   * (консервативно), у модели с меньшим окном предохранителем остаётся
   * `context.windowPolicy`/overflow.
   */
  private _effectiveContextWindow(modelId?: string): number {
    return this.getContextWindow(modelId) || DEFAULT_CONTEXT_WINDOW;
  }

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

  /** Порог компактизации в процентах окна (1..100, дефолт 85). */
  private _compactionThresholdPercent(session: Session): number {
    const raw = session.settings.compactionTokenThreshold;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 85;
    return Math.min(100, Math.max(1, Math.trunc(raw)));
  }

  private _keepTokensFor(session: Session, mode: CompressionMode): number {
    const raw = mode === 'compaction'
      ? session.settings.compactionKeepTokens
      : session.settings.summarizationKeepTokens;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.trunc(raw);
    return mode === 'compaction' ? 15000 : 5000;
  }

  /**
   * Граница хвоста: кандидаты после последнего SUMMARY; считаем токены с конца,
   * затем сдвигаем границу вперёд до ближайшего user-сообщения (не рвём ход и
   * tool-пары). `budget = 0` без `minKeepFromIndex` → хвоста нет.
   */
  private _buildCompressionBoundary(
    session: Session,
    mode: CompressionMode,
    minKeepFromIndex?: number,
    keepTokensOverride?: number,
  ): {
    coveredIndices: number[];
    keepFromIndex: number;
    keepFromId?: string;
    messages: Message[];
    keepMessages: Message[];
  } {
    const lastSummaryIdx = this._findLastSummaryIndex(session.messages);
    const startIdx = lastSummaryIdx >= 0 ? lastSummaryIdx + 1 : 0;
    const candidates: Array<{ index: number; msg: Message }> = [];

    for (let i = startIdx; i < session.messages.length; i++) {
      const msg = session.messages[i]!;
      if (msg.pinned) continue; // pinned не покрываются
      if (msg.disabled || msg.hidden || msg.ephemeral) continue;
      if (msg.role === MessageRole.SUMMARY || msg.role === MessageRole.INFO) continue;
      candidates.push({ index: i, msg });
    }

    const budget = keepTokensOverride ?? this._keepTokensFor(session, mode);
    let startPos = candidates.length;

    if (budget > 0 && candidates.length > 0) {
      let cumulative = 0;
      for (let i = candidates.length - 1; i >= 0; i--) {
        const tokens = this._estimateMessageTokens(candidates[i]!.msg);
        const isNewest = i === candidates.length - 1;
        if (!isNewest && cumulative + tokens > budget) break;
        startPos = i;
        cumulative += tokens;
        if (cumulative >= budget) break;
      }
    }

    if (minKeepFromIndex !== undefined) {
      const protectedPos = candidates.findIndex((c) => c.index >= minKeepFromIndex);
      if (protectedPos >= 0) startPos = Math.min(startPos, protectedPos);
    }

    // Хвост обязан начинаться с user-сообщения (иначе разорвали бы ход/tool-пары).
    if (budget > 0 || minKeepFromIndex !== undefined) {
      const lastUserPos = this._findLastPosWithRole(candidates, MessageRole.USER);
      if (lastUserPos < 0) {
        startPos = candidates.length;
      } else {
        if (startPos > lastUserPos) startPos = lastUserPos;
        let p = startPos;
        while (p < candidates.length && candidates[p]!.msg.role !== MessageRole.USER) p++;
        startPos = p < candidates.length ? p : candidates.length;
      }
    }

    const covered = candidates.slice(0, startPos);
    const keep = candidates.slice(startPos);
    const keepFromIndex = keep.length > 0 ? keep[0]!.index : -1;

    return {
      coveredIndices: covered.map((c) => c.index),
      keepFromIndex,
      ...(keepFromIndex >= 0 && session.messages[keepFromIndex]
        ? { keepFromId: session.messages[keepFromIndex]!.id }
        : {}),
      messages: covered.map((c) => c.msg),
      keepMessages: keep.map((c) => c.msg),
    };
  }

  private _findLastPosWithRole(
    candidates: Array<{ index: number; msg: Message }>,
    role: MessageRole,
  ): number {
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i]!.msg.role === role) return i;
    }
    return -1;
  }

  private _renderCompressionTranscript(
    messages: Message[],
    mode: CompressionMode,
    lang = 'ru',
    caps: TranscriptCaps = this._compressionCaps(mode, 0),
  ): string {
    const labels = compressionTranscriptLabels(lang);
    const toolNames = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role !== MessageRole.ASSISTANT || !Array.isArray(msg.toolCalls)) continue;
      for (const call of msg.toolCalls) {
        const id = typeof call.id === 'string' ? call.id : '';
        const name = this._toolCallName(call);
        if (id && name) toolNames.set(id, name);
      }
    }

    const lines: string[] = [];
    for (const msg of messages) {
      const content = (msg.content ?? '').trim();
      const media = this._mediaPlaceholders(msg, lang);

      if (msg.role === MessageRole.USER) {
        if (content) lines.push(`${labels.user} ${content}`);
        for (const item of media) lines.push(item);
        continue;
      }

      if (msg.role === MessageRole.ASSISTANT) {
        if (content) lines.push(`${labels.assistant} ${content}`);
        for (const call of msg.toolCalls ?? []) {
          const name = this._toolCallName(call) || 'tool';
          const args = this._toolCallArguments(call);
          lines.push(`${labels.toolCall} ${name}(${this._truncate(args, caps.argCap)})`);
        }
        for (const item of media) lines.push(item);
        continue;
      }

      if (msg.role === MessageRole.TOOL) {
        const name = (typeof msg.metadata?.tool_name === 'string' ? msg.metadata.tool_name : undefined)
          ?? (msg.toolCallId ? toolNames.get(msg.toolCallId) : undefined)
          ?? 'tool';
        const isError = this._isToolError(msg);
        if (mode === 'compaction') {
          const body = content.length > 0
            ? this._truncate(content, caps.resultCap)
            : labels.empty;
          lines.push(`${labels.toolResult} ${name}: ${isError ? 'error' : 'ok'} — ${body}`);
        } else if (isError) {
          // Ошибки важны — сохраняем до resultCap.
          const body = content.length > 0
            ? this._truncate(content, caps.resultCap)
            : labels.empty;
          lines.push(`${labels.toolResult} ${name}: error — ${body}`);
        } else {
          // m1: успешный tool-результат — без дословного тела.
          const firstLine = content.split('\n')[0]?.trim() ?? '';
          const body = !firstLine || firstLine.length > caps.successCap
            ? `(${content.length} ${labels.chars})`
            : firstLine;
          lines.push(`${labels.toolResult} ${name}: ok — ${body}`);
        }
        for (const item of media) lines.push(item);
        continue;
      }

      if (content) lines.push(`[${msg.role}] ${content}`);
      for (const item of media) lines.push(item);
    }
    return lines.join('\n\n');
  }

  /** Капы рендера по уровню сжатия (M8). */
  private _compressionCaps(mode: CompressionMode, level: number): TranscriptCaps {
    const index = Math.min(Math.max(level, 0), 3);
    if (mode === 'compaction') {
      const cap = [2000, 1000, 500, 200][index]!;
      return { argCap: cap, resultCap: cap, successCap: cap };
    }
    // m1: args — до 120; успешный результат — первая строка ≤120 либо счётчик;
    // ошибки — до 300 (и ниже по уровням).
    const resultCap = [300, 200, 120, 80][index]!;
    return {
      argCap: index >= 3 ? 80 : 120,
      resultCap,
      successCap: Math.min(120, resultCap),
    };
  }

  /**
   * M8: рендер транскрипта с бюджетом. Уровни 1–3 уменьшают капы на сообщение;
   * уровень 4 выбрасывает самые старые сообщения (маркер), но никогда не
   * трогает последний user-ход и всё после него. Если даже так не влезает —
   * возвращается максимально сжатый вариант (лучше потерять детали, чем не
   * сделать сжатие).
   */
  private _renderCompressionTranscriptBounded(
    messages: Message[],
    mode: CompressionMode,
    lang: string,
    maxChars: number,
  ): string {
    const full = this._renderCompressionTranscript(messages, mode, lang, this._compressionCaps(mode, 0));
    if (!Number.isFinite(maxChars) || full.length <= maxChars) return full;

    for (let level = 1; level <= 3; level++) {
      const rendered = this._renderCompressionTranscript(
        messages,
        mode,
        lang,
        this._compressionCaps(mode, level),
      );
      if (rendered.length <= maxChars) return rendered;
    }

    const lastUserPos = this._findLastPosWithRole(
      messages.map((msg, index) => ({ index, msg })),
      MessageRole.USER,
    );
    const protectStart = lastUserPos >= 0 ? lastUserPos : messages.length;

    const renderDropped = (drop: number): string => {
      const marker = drop > 0 ? `${compressionOmittedMarker(drop, lang)}\n\n` : '';
      return marker + this._renderCompressionTranscript(
        messages.slice(drop),
        mode,
        lang,
        this._compressionCaps(mode, 3),
      );
    };

    if (protectStart <= 0) return renderDropped(0);

    // Бинарный поиск минимального числа выброшенных старых сообщений.
    let low = 0;
    let high = protectStart;
    let best = protectStart;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (renderDropped(mid).length <= maxChars) {
        best = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return renderDropped(best);
  }

  private _toolCallName(call: Record<string, unknown>): string {
    const fn = call.function as { name?: unknown } | undefined;
    if (fn && typeof fn.name === 'string') return fn.name;
    if (typeof call.name === 'string') return call.name;
    return '';
  }

  private _toolCallArguments(call: Record<string, unknown>): string {
    const fn = call.function as { arguments?: unknown } | undefined;
    const raw = fn?.arguments ?? call.arguments;
    if (typeof raw === 'string') return raw;
    if (raw === undefined || raw === null) return '{}';
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }

  private _isToolError(msg: Message): boolean {
    if (msg.metadata?.is_error === true || msg.metadata?.error === true) return true;
    return /^(?:\[?error|❌|Error:)/i.test((msg.content ?? '').trim());
  }

  private _mediaPlaceholders(msg: Message, lang = 'ru'): string[] {
    const labels = compressionTranscriptLabels(lang);
    const out: string[] = [];
    for (const part of msg.parts ?? []) {
      if (part.type !== 'image' && part.type !== 'audio' && part.type !== 'video' && part.type !== 'file') {
        continue;
      }
      const mime = typeof (part.data as { mime?: unknown } | undefined)?.mime === 'string'
        ? ((part.data as { mime: string }).mime)
        : part.type;
      out.push(`${labels.attachment}${mime}]`);
    }
    return out;
  }

  private _truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
  }

  /**
   * Влезает ли `covered + хвост + промпт` в окно за вычетом резерва на вывод.
   * Неизвестное окно (`0`) — не влезает (хвост не добавляем).
   */
  private _tailFits(
    session: Session,
    baseText: string,
    tailText: string,
    promptText: string,
  ): boolean {
    const window = this.getContextWindow(session.settings.model);
    if (!(window > 0)) return false;
    const reserve = resolveMaxOutputTokens({ sessionMax: session.settings.maxTokens });
    const tokens = Math.ceil(
      (baseText.length + tailText.length + promptText.length) / ContextOptimizer.CHARS_PER_TOKEN,
    );
    return tokens + reserve <= window;
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
    // Резюме — чекпоинт в начале контекста, затем **все** активные сообщения
    // в исходном порядке. Хвост и pinned могут лежать до SUMMARY (SUMMARY
    // дописывается в конец истории) — они обязаны остаться в контексте.
    const result: Message[] = [];
    const lastSummaryIdx = this._findLastSummaryIndex(session.messages);

    if (lastSummaryIdx >= 0) {
      result.push(session.messages[lastSummaryIdx]!);
    }

    for (let i = 0; i < session.messages.length; i++) {
      if (i === lastSummaryIdx) continue;
      const msg = session.messages[i]!;
      if (msg.disabled || msg.hidden || msg.ephemeral) continue;
      if (msg.role === MessageRole.INFO) continue;
      if (msg.role === MessageRole.SUMMARY) continue;
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
   * Можно ли сжимать сессию: есть что покрывать — минимум один полный ход до
   * хвоста (user-реплика + её продолжение) для обоих профилей.
   */
  /**
   * Есть ли что покрывать (без вызова LLM). Строит границу хвоста для
   * эффективного режима; ошибки/отсутствие режима → `false`.
   */
  canCompress(session: Session): boolean {
    try {
      const mode = this.effectiveMode(session);
      if (!mode) return false;
      return this._buildCompressionBoundary(session, mode).coveredIndices.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Можно ли сжимать сессию: есть что покрывать — минимум один полный ход до
   * хвоста (user-реплика + её продолжение) для обоих профилей.
   */
  canSummarize(session: Session): boolean {
    if (!session.settings.provider || !session.settings.model) return false;
    return this.canCompress(session);
  }
}
