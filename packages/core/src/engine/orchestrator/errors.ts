/**
 * ADR-095 (шаг 6a): ошибки LLM-стрима оркестратора.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегации `_formatLlmError`, `_errorTypeI18n`,
 * `_handleLlmFailure`; тип `LlmFailureContext` перенесён сюда.
 */
import type { PromptMeta, TokenUsage } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { DebugCollector } from '../../debug.js';
import { ContextLengthExceededError } from '../../providers/exceptions.js';
import { classifyLlmError, isLlmErrorRecoverable, LLM_MAX_ATTEMPTS } from '../llm-error.js';
import { WorktreeDirectoryMissingError } from '../worktree/errors.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { warning } from '../../logger.js';
import { estimateUsage } from './usage.js';
import type { SaveAssistantMessageFn } from './persistence.js';

/**
 * ADR-070 §2.6: контекст для сохранения assistant-сообщения об ошибке LLM.
 * Заполняется на месте сбоя (там доступны накопленные usage/контент/debug).
 */
export interface LlmFailureContext {
  debugCollector: DebugCollector;
  /** Длительность прогона до сбоя (metadata.duration_ms). */
  durationMs: number;
  /** Фактический usage, если провайдер успел его отдать (иначе — оценка). */
  usage?: TokenUsage;
  model?: string;
  providerName?: string;
  agentRole?: string;
  /** Частичный ответ до сбоя — база для оценки output-токенов. */
  content?: string;
  /** Размер отправленного промпта в символах — база для оценки input-токенов. */
  promptChars?: number;
  toolResults?: Array<Record<string, unknown>>;
  promptMeta?: PromptMeta;
  /**
   * Явный тип ошибки (ADR-041). Нужен там, где сообщение локализовано и
   * `classifyLlmError` не может определить тип по тексту (например
   * `provider_not_found`): при переданном значении приоритетнее классификации.
   */
  errorType?: string;
}

/**
 * Человекочитаемое описание ошибки LLM (таймаут/обрыв соединения, сетевая
 * ошибка). Для остальных ошибок — исходный текст. `i18n` — ключ ADR-041 для
 * metadata (UI локализует сам).
 */
export function formatLlmError(error: unknown): { text: string; i18n?: ReturnType<typeof i18nMeta> } {
  // ADR-114 §3.2: исчезнувший каталог worktree — fail-closed с i18n-ключом
  // (`worktree.directory_missing`), а не текстом ошибки в лог-формате.
  if (error instanceof WorktreeDirectoryMissingError) {
    const params = { path: error.directory };
    return {
      text: sm('worktree.directory_missing', params),
      i18n: i18nMeta('worktree.directory_missing', params),
    };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (lower.includes('abort') || lower.includes('operation was aborted') || lower.includes('timed out') || lower.includes('timeout')) {
    return { text: sm('router.timeout'), i18n: i18nMeta('router.timeout') };
  }
  if (lower.includes('fetch failed') || lower.includes('network') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('eai_again')) {
    return { text: sm('router.network_error'), i18n: i18nMeta('router.network_error') };
  }
  return { text: raw };
}

/** i18n-ключ по типу ошибки (ADR-041) для metadata assistant-сообщения об ошибке. */
export function errorTypeI18n(errorType: string): ReturnType<typeof i18nMeta> | undefined {
  switch (errorType) {
    case 'timeout': return i18nMeta('router.timeout');
    case 'network_error': return i18nMeta('router.network_error');
    case 'rate_limit': return i18nMeta('router.rate_limit_exceeded');
    case 'context_length': return i18nMeta('router.context_length_exceeded');
    case 'no_user_query': return i18nMeta('router.no_user_query');
    case 'provider_not_found': return i18nMeta('router.provider_not_found');
    default: return undefined;
  }
}

/** Зависимости `handleLlmFailure` (персистентность assistant-сообщения об ошибке). */
export interface HandleLlmFailureDeps {
  sessionManager: SessionManager;
  saveAssistantMessage: SaveAssistantMessageFn;
}

/**
 * Единая обработка ошибки LLM-стрима: пишет last_error в user-сообщение
 * сессии (по stream_id), сохраняет assistant-сообщение об ошибке (только
 * когда повтор невозможен/исчерпан — см. `attempt`) и возвращает
 * ProcessMessageResult. Публикация финального исхода (stream.retry для
 * recoverable / stream.error для non-recoverable) — зона ответственности
 * QueueProcessor, чтобы не было двойной публикации stream.error. Если ошибка
 * recoverable — session разблокируется на уровне QueueProcessor после
 * исчерпания попыток; сессия не остаётся заблокированной навсегда.
 */
export async function handleLlmFailure(
  sessionId: string,
  streamId: string,
  error: unknown,
  attempt: number | undefined,
  ctx: LlmFailureContext | undefined,
  deps: HandleLlmFailureDeps,
): Promise<{ error?: string; errorType?: string; canRetry?: boolean }> {
  const rawError = error instanceof Error ? error.message : String(error);
  const formatted = formatLlmError(error);
  const humanError = formatted.text;
  // ADR-114 §3.2: каталог worktree исчез — повтор не поможет (фоллбек в
  // `project.workspace` запрещён), поэтому ход невосстановим.
  const worktreeMissing = error instanceof WorktreeDirectoryMissingError;
  // ContextLengthExceededError несёт русское сообщение («Контекстное окно
  // превышено») — текстовый классификатор его не распознаёт, поэтому тип
  // определяем по классу ошибки, чтобы UI показал дружелюбное сообщение.
  const errorType = ctx?.errorType
    ?? (worktreeMissing
      ? 'worktree_directory_missing'
      : error instanceof ContextLengthExceededError
        ? 'context_length'
        : classifyLlmError(rawError));
  const canRetry = worktreeMissing ? false : isLlmErrorRecoverable(error, rawError, errorType);

  // ADR-070 §2.6 (Bug 1): assistant-сообщение об ошибке пишем только тогда,
  // когда повтора уже не будет (unrecoverable / последняя попытка / прямой
  // вызов без QueueProcessor). Иначе на каждый recoverable-ретрай в истории
  // появлялся бы дубль, а `message.added` мигал бы в UI.
  const isTerminal = !canRetry || attempt === undefined || attempt > LLM_MAX_ATTEMPTS;

  if (isTerminal && ctx) {
    try {
      const estimated = estimateUsage(
        ctx.usage,
        ctx.promptChars ?? 0,
        (ctx.content ?? '').length,
      );
      const i18n = formatted.i18n ?? errorTypeI18n(errorType);
      await deps.saveAssistantMessage(
        sessionId, humanError, streamId, ctx.agentRole,
        estimated.usage, ctx.model, undefined, ctx.debugCollector, false, ctx.providerName,
        MessageRole.ASSISTANT, undefined, false, ctx.toolResults, undefined,
        undefined, undefined,
        {
          duration_ms: ctx.durationMs,
          status: 'error',
          ...(i18n ? { i18n } : {}),
          ...(estimated.estimated ? { usage_estimated: true } : {}),
        },
        ctx.promptMeta,
      );
    } catch (err) {
      warning('ORCHESTRATOR', `Не удалось сохранить assistant-сообщение об ошибке: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    await deps.sessionManager.withLock(sessionId, async (s) => {
      const userMsg = s.messages.find(
        (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
      );
      if (userMsg) {
        userMsg.metadata = { ...userMsg.metadata, last_error: humanError };
        await deps.sessionManager.saveSession(s);
      }
    });
  } catch (err) {
    warning('ORCHESTRATOR', `Не удалось записать last_error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { error: humanError, errorType, canRetry };
}
