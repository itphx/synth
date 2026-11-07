/**
 * Сжатие контекста: общие операции применения плана.
 *
 * `prepareCompression` (ContextOptimizer) только строит план; здесь —
 * единственная точка **отключения** покрытых сообщений и принудительного
 * сжатия для overflow (pre-flight и повтор шага после `context_length`).
 */
import type { Message, Session } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { LLMResponse } from '@itphx/synth-shared';
import type { CancellationToken } from '../../providers/base.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { CompressionPlan, ContextOptimizer } from '../context/optimizer.js';
import type { SaveAssistantMessageFn } from './persistence.js';
import { DebugCollector } from '../../debug.js';
import { info, warning } from '../../logger.js';
import { t as sm } from '../system-messages.js';
// ADR-119: занятость контекста «прямо сейчас» — тот же счётчик и то же окно,
// что у триггера сжатия и у индикатора в UI.
import { computeContextUsage } from '../context/context-usage.js';

/** Причина сжатия (диагностика/событие). */
export type CompressionReason = 'overflow' | 'auto' | 'manual';

/** Минимальный набор зависимостей применения плана. */
export interface CompressionApplyDeps {
  sessionManager: Pick<SessionManager, 'withLock' | 'getSession' | 'saveSession'>;
  eventBus: EventBus;
}

/**
 * Отключить ровно покрытые резюме сообщения. `pinned` не трогаем, хвост не
 * трогаем; каждому отключённому ставим `metadata.compactedBy = mode`.
 */
export async function disableCompressedMessages(
  deps: CompressionApplyDeps,
  sessionId: string,
  plan: CompressionPlan,
): Promise<void> {
  await deps.sessionManager.withLock(sessionId, async (session) => {
    let changed = false;
    for (const index of plan.coveredIndices) {
      const msg = session.messages[index];
      if (!msg || msg.disabled || msg.pinned) continue;
      msg.disabled = true;
      msg.metadata = { ...(msg.metadata ?? {}), compactedBy: plan.mode };
      changed = true;
    }
    if (changed) await deps.sessionManager.saveSession(session);
  });
}

/** Зависимости принудительного сжатия (нужен способ сохранить резюме). */
export interface ForceCompressionDeps extends CompressionApplyDeps {
  optimizer: ContextOptimizer;
  /**
   * Сохранить сообщение-резюме в историю (роль SUMMARY, `summaryOf`,
   * metadata `{type:'auto_summary', mode, keepFrom}`) и учесть расход.
   */
  saveSummary(input: {
    session: Session;
    content: string;
    plan: CompressionPlan;
    response: LLMResponse;
    reason: CompressionReason;
  }): Promise<void>;
}

export interface ForceCompressionResult {
  session: Session;
  summary: string;
  plan: CompressionPlan;
}

/**
 * Сохранение SUMMARY-сообщения принудительного сжатия через общий
 * `saveAssistantMessage` (usage/cost/счётчики сессии — тот же путь, что у
 * обычной суммаризации). Без step/turn-привязки: forced compression не
 * является ходом пользователя.
 */
export function createCompressionSummarySaver(
  saveAssistantMessage: SaveAssistantMessageFn,
): ForceCompressionDeps['saveSummary'] {
  return async (input) => {
    await saveAssistantMessage(
      input.session.id,
      input.content,
      '',
      'summary',
      input.response.usage,
      input.response.model,
      undefined,
      new DebugCollector(input.session.settings.debugEnabled),
      false,
      input.session.settings.provider || '',
      MessageRole.SUMMARY,
      input.plan.coveredIndices,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        type: 'auto_summary',
        mode: input.plan.mode,
        ...(input.plan.keepFromId ? { keepFrom: input.plan.keepFromId } : {}),
        reason: input.reason,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  };
}

/**
 * Принудительно сжать сессию один раз (overflow). Бросает, если сжимать
 * нечего/провайдер недоступен/ответ не прошёл валидацию — вызывающий решает,
 * деградировать или завершить ход ошибкой.
 *
 * `opts.cancelToken` — отменяемый вызов сжатия (ход остановлен «Стопом»):
 * отмена бросает `CompressionCancelledError`, вызывающий трактует её как
 * «сжатие не состоялось».
 * `opts.phase` — фаза сжатия (`mid_turn` — посреди хода, на границе шага);
 * аддитивно попадает в событие `context.summarization_applied`.
 */
export async function forceCompression(
  session: Session,
  deps: ForceCompressionDeps,
  opts: {
    reason: CompressionReason;
    /** Нижняя граница хвоста: текущий ход/реплику не покрываем. */
    minKeepFromIndex?: number;
    cancelToken?: CancellationToken;
    phase?: 'mid_turn';
  },
): Promise<ForceCompressionResult> {
  const lang = session.settings.language || 'ru';
  // M4: выключенное сжатие не запускаем даже при force/overflow.
  if (!deps.optimizer.effectiveMode(session)) {
    throw new Error(
      sm('context.compression_failed', { mode: 'none', reason: 'mode_disabled' }),
    );
  }
  const plan = deps.optimizer.prepareCompression(session, lang, {
    ...(opts.minKeepFromIndex !== undefined ? { minKeepFromIndex: opts.minKeepFromIndex } : {}),
  });

  const { content, response } = await deps.optimizer.completeCompression(plan, {
    ...(opts.cancelToken ? { cancelToken: opts.cancelToken } : {}),
  });

  await deps.saveSummary({
    session,
    content,
    plan,
    response,
    reason: opts.reason,
  });

  await disableCompressedMessages(deps, session.id, plan);

  const updated = await deps.sessionManager.getSession(session.id);
  if (!updated) throw new Error(`Session ${session.id} not found after compression`);

  // Прогресс-гард: сжатие обязано снять порог триггера. Если порог остался —
  // сжатие не помогло: включаем cooldown, чтобы авто-триггер не звал LLM
  // по кругу (иначе очередь упирается в то же сжатие). Cooldown игнорируем:
  // иначе активный cooldown маскировал бы «сжатие не помогло».
  if (
    typeof deps.optimizer.shouldCompress === 'function'
    && deps.optimizer.shouldCompress(updated, { ignoreCooldown: true }).triggered
  ) {
    if (typeof deps.optimizer.noteCompressionFailure === 'function') {
      deps.optimizer.noteCompressionFailure(session.id);
    }
    warning(
      'CONTEXT',
      `Forced compression (${plan.mode}) did not reduce context below the threshold: `
        + `session ${session.id}`,
    );
  } else if (typeof deps.optimizer.clearCompressionFailure === 'function') {
    deps.optimizer.clearCompressionFailure(session.id);
  }

  // ADR-119: занятость контекста ПОСЛЕ сжатия (покрытые сообщения уже
  // отключены) — иначе индикатор остался бы на до-сжатом уровне.
  const contextUsage = computeContextUsage(deps.optimizer, updated);

  deps.eventBus.publish(session.id, 'context.summarization_applied', {
    session_id: session.id,
    reason: opts.reason,
    mode: plan.mode,
    covered_indices: plan.coveredIndices,
    keep_from: plan.keepFromId ?? null,
    ...(response.usage ? { usage: response.usage } : {}),
    /**
     * ADR-119: занятость контекста после сжатия (аддитивно). `usage` выше —
     * расход вызова сжатия, а не занятость окна.
     */
    context_tokens: contextUsage.tokens,
    context_limit: contextUsage.limit,
    /**
     * Аддитивно: фаза сжатия (`mid_turn` — посреди хода, на границе шага).
     */
    ...(opts.phase ? { phase: opts.phase } : {}),
  });

  info(
    'CONTEXT',
    `Forced compression (${plan.mode}, ${opts.reason}): ${plan.coveredIndices.length} messages covered, `
      + `keep from ${plan.keepFromIndex}, session ${session.id}`,
  );

  return { session: updated, summary: content, plan };
}

/** Индекс последнего активного user-сообщения (`-1` — нет). */
export function findLastUserMessageIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'user') continue;
    if (msg.disabled || msg.hidden || msg.ephemeral) continue;
    return i;
  }
  return -1;
}
