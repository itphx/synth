/**
 * ADR-095 (шаг 6a): ошибки LLM-стрима оркестратора.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегации `_formatLlmError`, `_errorTypeI18n`,
 * `_handleLlmFailure`; тип `LlmFailureContext` перенесён сюда.
 *
 * Решение владельца 2026-11-06: терминальная ошибка **основной** сессии больше
 * **не создаёт assistant-сообщение** (в истории/ленте ничего не остаётся);
 * фиксируются `last_error` на user-реплике и aux-расход `llm-error`.
 */
import type { TokenUsage } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import { ContextLengthExceededError, RemoteAuthExpiredError } from '../../providers/exceptions.js';
import { RemoteError } from '../../remote/types.js';
import { classifyLlmErrorFor, isLlmErrorRecoverable, LLM_MAX_ATTEMPTS } from '../llm-error.js';
import { WorktreeDirectoryMissingError } from '../worktree/errors.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { warning } from '../../logger.js';
import { estimateUsage, addTokenUsage } from './usage.js';
import type { AuxUsageRecorder } from '../usage-accounting.js';

/**
 * Контекст терминальной ошибки LLM основной сессии. Заполняется на месте
 * сбоя (там доступны накопленные usage/контент). Сообщение об ошибке больше не
 * пишется — значения нужны только для учёта расхода и `last_error`.
 */
export interface LlmFailureContext {
  /** Длительность прогона до сбоя (роллап аналитики `usage`). */
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
  /**
   * Явный тип ошибки (ADR-041). Нужен там, где сообщение локализовано и
   * `classifyLlmError` не может определить тип по тексту (например
   * `provider_not_found`): при переданном значении приоритетнее классификации.
   */
  errorType?: string;
  /**
   * ADR-102: расход **предыдущих** шагов хода (без текущего вызова). Счётчики
   * сессии и аналитика получают `turnUsage + оценка этого вызова` — без потерь
   * и без двойного счёта.
   */
  turnUsage?: TokenUsage;
}

/**
 * Человекочитаемое описание ошибки LLM (таймаут/обрыв соединения, сетевая
 * ошибка). Для остальных ошибок — исходный текст. `i18n` — ключ ADR-041 для
 * metadata (UI локализует сам).
 */
export function formatLlmError(error: unknown): { text: string; i18n?: ReturnType<typeof i18nMeta> } {
  // Гибрид (ADR-042): нет токена к серверу — единый понятный текст и i18n-ключ
  // **только** для этой ошибки (прочие auth_error остаются с сырым текстом).
  if (error instanceof RemoteAuthExpiredError) {
    return {
      text: sm('router.remote_auth_expired'),
      i18n: i18nMeta('router.remote_auth_expired'),
    };
  }
  // Гибрид: сетевой сбой обновления токена — это сетевая ошибка, а не ошибка
  // провайдера. Иначе UI показал бы русский текст «Сервер авторизации
  // недоступен…» как ошибку модели (и без i18n-ключа).
  if (error instanceof RemoteError && error.code === 'OFFLINE') {
    return { text: sm('router.network_error'), i18n: i18nMeta('router.network_error') };
  }
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

/**
 * i18n-ключ по типу ошибки (ADR-041). Ранее писался в metadata
 * assistant-сообщения об ошибке; теперь основная сессия сообщения не создаёт,
 * хелпер оставлен для диагностики/внешних потребителей.
 *
 * `ctx.providerName` нужен ключу `router.provider_not_found` (в en-шаблоне есть
 * `{provider}`): без параметра UI показал бы сырой плейсхолдер.
 */
export function errorTypeI18n(
  errorType: string,
  ctx?: { providerName?: string },
): ReturnType<typeof i18nMeta> | undefined {
  switch (errorType) {
    case 'timeout': return i18nMeta('router.timeout');
    case 'network_error': return i18nMeta('router.network_error');
    case 'rate_limit': return i18nMeta('router.rate_limit_exceeded');
    case 'context_length': return i18nMeta('router.context_length_exceeded');
    case 'no_user_query': return i18nMeta('router.no_user_query');
    case 'remote_auth_expired': return i18nMeta('router.remote_auth_expired');
    case 'provider_not_found': return ctx?.providerName
      ? i18nMeta('router.provider_not_found', { provider: ctx.providerName })
      : i18nMeta('router.provider_not_found');
    default: return undefined;
  }
}

/**
 * Зависимости `handleLlmFailure`.
 *
 * `recordUsage` — шов aux-учёта (ADR-102): терминальная ошибка основной сессии
 * сообщением не становится, но её расход попадает в счётчики/аналитику с
 * `source: 'llm-error'` (`engine/usage-accounting.ts`, best-effort).
 */
export interface HandleLlmFailureDeps {
  sessionManager: SessionManager;
  recordUsage?: AuxUsageRecorder;
}

/**
 * Единая обработка ошибки LLM-стрима основной сессии.
 *
 * Ошибка **не создаёт сообщение** (решение владельца 2026-11-06): в истории и
 * ленте после reload ничего не остаётся, пользователю показывается временная
 * плашка `stream.error` (UI). Здесь фиксируются:
 *  - `last_error` в user-сообщение сессии (по `stream_id`);
 *  - расход неудавшегося вызова как **aux-вызов** `llm-error` (счётчики сессии
 *    + роллап `usage`, без `messages`) — только когда повтор невозможен/исчерпан
 *    (`attempt`); на recoverable-ретраях ничего не пишется, иначе расход
 *    считался бы многократно.
 *
 * Возвращает ProcessMessageResult. Публикация финального исхода (stream.retry
 * для recoverable / stream.error для non-recoverable) — зона ответственности
 * QueueProcessor, чтобы не было двойной публикации stream.error. Если ошибка
 * recoverable — session разблокируется на уровне QueueProcessor после
 * исчерпания попыток; сессия не остаётся заблокированной навсегда.
 *
 * Дочерние сессии (саб-агенты) сохраняют ошибку сообщением `role: 'error'` в
 * своём цикле (`engine/tools/task/run-cycle.ts`) — основной агент должен видеть,
 * что была проблема.
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
        // Объект, а не только текст: RemoteError(OFFLINE) → network_error
        // (recoverable), RemoteError(AUTH)/RemoteAuthExpiredError →
        // remote_auth_expired (терминально, нужен повторный вход в гибрид).
        : classifyLlmErrorFor(error));
  const canRetry = worktreeMissing ? false : isLlmErrorRecoverable(error, rawError, errorType);

  // Расход неудавшегося вызова пишем один раз — когда повтора уже не будет
  // (unrecoverable / последняя попытка / прямой вызов без QueueProcessor).
  // Иначе на каждый recoverable-ретрай счётчики/аналитика получали бы дубль.
  const isTerminal = !canRetry || attempt === undefined || attempt > LLM_MAX_ATTEMPTS;

  if (isTerminal && ctx && deps.recordUsage) {
    try {
      const estimated = estimateUsage(
        ctx.usage,
        ctx.promptChars ?? 0,
        (ctx.content ?? '').length,
      );
      // ADR-102: расход хода — предыдущие шаги + этот (оценённый) вызов.
      const turnUsage = ctx.turnUsage !== undefined
        ? addTokenUsage(ctx.turnUsage, estimated.usage)
        : estimated.usage;
      // Сообщения нет — aux-запись без `messages`; сессия/аналитика получают
      // расход как обычный вызов провайдера.
      await deps.recordUsage({
        sessionId,
        usage: turnUsage,
        ...(ctx.model !== undefined ? { model: ctx.model } : {}),
        ...(ctx.providerName !== undefined ? { provider: ctx.providerName } : {}),
        ...(ctx.agentRole !== undefined ? { agent: ctx.agentRole } : {}),
        durationMs: ctx.durationMs,
        source: 'llm-error',
      });
    } catch (err) {
      // `recordAuxUsage` сам глотает ошибки хранилища/аналитики; здесь — на
      // случай нестандартного рекордера.
      warning('ORCHESTRATOR', `Не удалось учесть расход ошибки LLM: ${err instanceof Error ? err.message : String(err)}`);
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
