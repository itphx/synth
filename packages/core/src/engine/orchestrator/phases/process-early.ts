/**
 * ADR-095 (шаг 6b-1): ранние выходы `_processMessage` — системные сообщения
 * (суммаризация/отладка), `/`-команды и micro-first.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения: порядок
 * проверок, условия, тексты, события и порядок side-effect'ов сохранены
 * дословно. `_processMessage` вызывает фазу до `try` и при непустом результате
 * возвращает его как есть (в т.ч. `{}` от micro-first). Внутренние `this._X`
 * заменены явными зависимостями (`ProcessEarlyDeps`).
 */
import type {
  DecisionConfig,
  Message,
  PlanMode,
  ReasoningLevel,
  Session,
  SessionMode,
  TokenUsage,
} from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { DebugCollector } from '../../../debug.js';
import type { SessionManager } from '../../../sessions/manager.js';
import type { PermissionEvaluator } from '../../permission/evaluator.js';
import type { MicroPipeline } from '../../router/micro/index.js';
import { info } from '../../../logger.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';

/** Результат фаз `_processMessage` (структурно = `ProcessMessageResult`). */
export interface ProcessEarlyResult {
  error?: string;
  errorType?: string;
  canRetry?: boolean;
}

/** Аргументы раннего резолвинга `/`-команды (ADR-046 §7). */
export interface ProcessCommandArgs {
  session: Session;
  message: Message;
  signal: AbortSignal;
  publishChunk: (event: string, data: Record<string, unknown>) => void;
  debugCollector: DebugCollector;
  streamId: string;
  effectiveAgentRole: string | undefined;
  workingDir: string;
  permissionEvaluator: PermissionEvaluator;
  sessionMode: SessionMode;
  planMode: PlanMode;
  planApproved: boolean;
  attempt?: number;
}

/** Зависимости `runProcessEarly`. */
export interface ProcessEarlyDeps {
  handleSummarization: (
    session: Session,
    message: Message,
    signal: AbortSignal,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    debugCollector: DebugCollector,
    streamId: string,
    attempt: number | undefined,
  ) => Promise<ProcessEarlyResult>;
  handleDebugSystemMessage: (
    session: Session,
    message: Message,
    signal: AbortSignal,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    debugCollector: DebugCollector,
    streamId: string,
    reasoningLevel: ReasoningLevel | undefined,
    attempt: number | undefined,
  ) => Promise<ProcessEarlyResult>;
  handleCommand: (args: ProcessCommandArgs) => Promise<ProcessEarlyResult | null>;
  microPipeline: MicroPipeline | null;
  decisionConfig: DecisionConfig | null;
  publishLocalCompletion: (
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    streamId: string,
    content: string,
    opts?: {
      model?: string;
      provider?: string;
      usage?: TokenUsage;
      durationMs?: number;
      metadata?: Record<string, unknown>;
      messageIndex?: number;
      messageId?: string;
    },
  ) => void;
  sessionManager: SessionManager;
}

/** Аргументы `runProcessEarly` (пролог `_processMessage` до LLM). */
export interface ProcessEarlyArgs {
  session: Session;
  message: Message;
  signal: AbortSignal;
  publishChunk: (event: string, data: Record<string, unknown>) => void;
  debugCollector: DebugCollector;
  streamId: string;
  effectiveAgentRole: string | undefined;
  effectiveReasoningLevel: ReasoningLevel | undefined;
  workingDir: string;
  attempt: number | undefined;
  permissionEvaluator: PermissionEvaluator;
  sessionMode: SessionMode;
  planMode: PlanMode;
  planApproved: boolean;
  /** ADR-070 §2.6: старт прогона (для `duration_ms` локального ответа). */
  streamStartedAt: number;
}

/**
 * Ранние ответы без основного LLM-цикла: системные сообщения, `/`-команды,
 * micro-first. Возвращает результат хода (в т.ч. `{}`) — вызывающий обязан
 * вернуть его; `null` — продолжаем обычный путь (router → LLM).
 */
export async function runProcessEarly(
  args: ProcessEarlyArgs,
  deps: ProcessEarlyDeps,
): Promise<ProcessEarlyResult | null> {
  const {
    session, message, signal, publishChunk, debugCollector, streamId,
    effectiveAgentRole, effectiveReasoningLevel, workingDir, attempt,
    permissionEvaluator, sessionMode, planMode, planApproved, streamStartedAt,
  } = args;

  // --- Обработка системных сообщений (суммаризация, шедулер, etc.) ---
  if (message.role === MessageRole.SYSTEM && message.metadata?.type === 'summarization_request') {
    return deps.handleSummarization(session, message, signal, publishChunk, debugCollector, streamId, attempt);
  }
  if (message.role === MessageRole.SYSTEM && message.metadata?.type === 'debug_system_message') {
    return deps.handleDebugSystemMessage(session, message, signal, publishChunk, debugCollector, streamId, effectiveReasoningLevel, attempt);
  }

  // --- ADR-046 §7: резолвинг `/`-команд в core, до LLM ---
  if (message.role === MessageRole.USER && (message.content ?? '').trimStart().startsWith('/')) {
    const commandResult = await deps.handleCommand({
      session, message, signal, publishChunk, debugCollector, streamId,
      effectiveAgentRole, workingDir, attempt,
      permissionEvaluator, sessionMode, planMode, planApproved,
    });
    if (commandResult) return commandResult;
    // prompt-команда (template/skill/bundle): сообщение заменено, идём в LLM.
  }

  // --- ADR-035: Micro-first — пробуем ответить без LLM ---
  if (deps.microPipeline && session.settings.microFirst) {
    const microResult = await deps.microPipeline.handle({
      userMessage: message.content,
      language: session.settings.language,
      sessionSettings: session.settings,
      embedProvider: session.settings.embedProvider,
      embedModel: session.settings.embedModel,
    });
    if (microResult.handled && microResult.microResult?.answer) {
      // Микрослой уверен — возвращаем ответ без вызова LLM
      const finalContent = microResult.microResult.answer;
      const finalModel = `micro:${microResult.microResult.taskClass}`;

      // ADR-084: метрики decision-уровня. Если победил decision-сигнал
      // (`decision:<label>`) — фиксируем его в debug-контексте (`extra_context`)
      // и дополняем `metadata.micro_first` (не дублируя сам `micro_first`).
      const decisionSignal = microResult.microResult.signals.find((s) => s.startsWith('decision:'));
      const microDecision = decisionSignal
        ? {
            label: decisionSignal.slice('decision:'.length),
            confidence: microResult.microResult.confidence,
            ...(deps.decisionConfig?.model ? { model: deps.decisionConfig.model } : {}),
          }
        : null;
      if (microDecision) {
        debugCollector.addContext('decision', {
          where: 'micro',
          ...microDecision,
          latencyMs: microResult.microResult.latencyMs,
          taskClass: microResult.microResult.taskClass,
        });
      }
      const finalUsage = {
        inputTokens: microResult.microResult.usage?.inputTokens ?? 0,
        outputTokens: microResult.microResult.usage?.outputTokens ?? 0,
        totalTokens: (microResult.microResult.usage?.inputTokens ?? 0) + (microResult.microResult.usage?.outputTokens ?? 0),
      };

      deps.publishLocalCompletion(publishChunk, streamId, finalContent, {
        model: finalModel,
        provider: 'micro',
        usage: finalUsage,
        durationMs: Date.now() - streamStartedAt,
      });

      // Сохраняем сообщение ассистента
      const microMetadata: Record<string, unknown> = {
        stream_id: streamId,
        duration_ms: Date.now() - streamStartedAt,
        ...(microResult.microResult.i18nKey
          ? { i18n: i18nMeta(microResult.microResult.i18nKey) }
          : {}),
        micro_first: {
          label: microResult.microResult.label,
          confidence: microResult.microResult.confidence,
          latencyMs: microResult.microResult.latencyMs,
          signals: microResult.microResult.signals,
          taskClass: microResult.microResult.taskClass,
          ...(microDecision ? { decision: microDecision } : {}),
        },
      };

      const assistantMsg: Message = {
        id: generateId(),
        role: MessageRole.ASSISTANT,
        seq: 0,
        origin: 'local',
        parts: [makeTextPart(finalContent)],
        content: finalContent,
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        model: finalModel,
        provider: 'micro',
        usage: finalUsage,
        agentRole: effectiveAgentRole,
        metadata: microMetadata,
        // ADR-084: debug-контекст (в т.ч. `extra_context.decision`) виден в
        // `GET /messages/:id/:index/debug`; микро-путь сохраняет сообщение
        // напрямую, минуя `_saveAssistantMessage`, поэтому ставим здесь.
        debugData: debugCollector.getDebugInfo() ?? undefined,
      };

      await deps.sessionManager.addMessage(session.id, assistantMsg);

      // Обновляем токены сессии
      session.inputTokens += finalUsage.inputTokens;
      session.outputTokens += finalUsage.outputTokens;
      session.totalTokens += finalUsage.totalTokens;

      // Авто-тайтл если это первое сообщение
      if (session.messages.filter((m) => m.role === MessageRole.USER && !m.ephemeral).length <= 1) {
        try {
          session.title = sm('session.dialog_title', { id: session.id.slice(0, 8) });
          await deps.sessionManager.saveSession(session);
        } catch {
          // ok
        }
      }

      info('MICRO', `Ответ через микро-слой: ${microResult.microResult.taskClass} (${microResult.microResult.latencyMs}ms, confidence=${microResult.microResult.confidence.toFixed(2)})`);
      return {};
    }

    // Если handled=false — продолжаем обычный путь (router → LLM)
    if (microResult.fallbackSignals?.length) {
      debugCollector.addContext('micro_first', {
        status: 'fallback',
        signals: microResult.fallbackSignals,
        taskClass: microResult.microResult?.taskClass ?? 'llm_task',
      });

      // ADR-084: метрики decision-уровня на фоллбеке. `decision_disabled`
      // исключаем, чтобы выключенный (или незаданный) decision-слой не
      // засорял метрики. Остальные сигналы (`decision:<label>` при отсечении
      // по порогу микро-слоя, `decision_low_confidence`, `decision_error:*`, …)
      // показывают реальное участие decision-модели.
      const decisionFallbackSignals = microResult.fallbackSignals.filter(
        (s) => /^decision[:_]/.test(s) && s !== 'decision_disabled',
      );
      if (decisionFallbackSignals.length) {
        debugCollector.addContext('decision', {
          where: 'micro',
          status: 'fallback',
          signals: decisionFallbackSignals,
        });
      }
    }
  }

  return null;
}
