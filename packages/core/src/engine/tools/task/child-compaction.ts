/**
 * ADR-119: авто-компактизация дочерней сессии саб-агента (граница шага —
 * ADR-128, решение о сжатии на границе шага).
 *
 * У ребёнка свой режим оптимизации контекста (`compaction`) — длинный прогон
 * саб-агента иначе упирается в окно модели (или в предохранитель
 * `agents.subagentMaxInputTokens`, который завершает прогон отчётом).
 *
 * Сжатие применяется к живой сессии ребёнка (покрытые сообщения
 * отключаются, резюме сохраняется), а в текущий запрос подставляется
 * **пересобранная** выборка: `[CONTEXT CHECKPOINT] + живой хвост` — тот же
 * приём, что у основного цикла сессии
 * (`engine/orchestrator.ts` → `_tryMidTurnCompression`).
 *
 * Особенности ребёнка:
 * - текущий ход **не защищён** (`minKeepFromIndex` не передаётся) — иначе
 *   длинный прогон не сжать;
 * - система промпта не пересобирается — резюме едет чекпоинтом;
 * - предохранитель бюджета (`subagentMaxInputTokens`) остаётся страховкой:
 *   он срабатывает уже по сокращённому контексту.
 *
 * Модуль вынесен отдельно от цикла (`run-cycle.ts`), чтобы поведение
 * можно было проверить без полного прогона саб-агента.
 */
import { MessageRole } from '@itphx/synth-shared';
import type { BaseProvider, CancellationToken, LLMMessage } from '../../../providers/base.js';
import { forceCompression, compressionFailureReason, publishCompressionFailure } from '../../orchestrator/compression.js';
import { buildOverflowRetryMessages } from '../../orchestrator/overflow.js';
import { warning } from '../../../logger.js';
import { messageToLLMMessage } from './prompt.js';
import type { TaskExtra } from './types.js';

/**
 * Потолок авто-компактификаций за один прогон саб-агента. Сжатие — не шаг:
 * лимит шагов агента оно не расходует, но и злоупотреблять им нельзя
 * (каждый вызов — отдельный LLM-вызов суммаризатора).
 */
export const MAX_SUBAGENT_MID_TURN_COMPRESSIONS = 2;

export interface ChildCompactionOptions {
  /** Зависимости прогона (оптимизатор/менеджер сессий/шина/сохранение резюме). */
  extra: TaskExtra;
  /** Дочерняя сессия саб-агента (не задана — сжимать нечего). */
  childSessionId?: string;
  /** Роль ребёнка (роль агента — для thinking-блоков в LLM-сообщениях). */
  subagentType: string;
  /** Провайдер прогона (пара provider/model — для thinking-блоков). */
  provider: BaseProvider;
  /** Токен отмены прогона (сжатие уважает «Стоп»). */
  cancelToken: CancellationToken;
  /** Сколько сжатий уже было за прогон (потолок — см. константу выше). */
  attempts: number;
  /** Проверка отмены прогона (родительский сигнал «Стоп»). */
  isAborted?: () => boolean;
}

/**
 * Имя провайдера прогона (для thinking-блоков). У стабов провайдера метода
 * может не быть — берём `name` провайдера.
 */
function providerNameOf(provider: BaseProvider): string | undefined {
  if (typeof provider.getProviderName === 'function') {
    try {
      return provider.getProviderName();
    } catch {
      // стаб без реализации — молча, как и в остальных местах цикла
    }
  }
  return provider.name || undefined;
}

/**
 * Попытаться сжать контекст дочерней сессии на границе шага.
 *
 * Возвращает **пересобранный** LLM-контекст (`[CONTEXT CHECKPOINT]` + живой
 * хвост) или `null`, если сжатия не было (нет триггера / cooldown / потолок /
 * отмена / ошибка). `null` — прогон продолжается как обычно.
 */
export async function tryCompactChildSession(
  opts: ChildCompactionOptions,
): Promise<LLMMessage[] | null> {
  const { extra, childSessionId, subagentType, provider, cancelToken, attempts } = opts;
  const optimizer = extra.contextOptimizer;
  const sessionManager = extra.sessionManager;
  const eventBus = extra.eventBus;
  const saveSummary = extra.saveSummary;

  // Fail-open: без полного набора зависимостей сжатие ребёнка пропускается —
  // прогон идёт как раньше (предохранитель бюджета остаётся страховкой).
  if (!childSessionId || !sessionManager || !optimizer || !eventBus || !saveSummary) {
    return null;
  }
  if (attempts >= MAX_SUBAGENT_MID_TURN_COMPRESSIONS) return null;
  if (
    typeof optimizer.isCompressionCoolingDown === 'function'
    && optimizer.isCompressionCoolingDown(childSessionId)
  ) {
    return null;
  }

  // Профиль сжатия ребёнка — для payload провала (`mode`).
  let childMode: string | null = null;

  try {
    const child = await sessionManager.getSession(childSessionId);
    if (!child) return null;
    childMode = optimizer.effectiveMode(child);
    if (!optimizer.shouldCompress(child).triggered) return null;
    if (typeof optimizer.canCompress === 'function' && !optimizer.canCompress(child)) {
      return null;
    }

    const result = await forceCompression(
      child,
      { optimizer, sessionManager, eventBus, saveSummary },
      // `minKeepFromIndex` не передаём: сжимаем и текущий прогон ребёнка —
      // иначе длинный прогон не сжать.
      { reason: 'auto', cancelToken, phase: 'mid_turn' },
    );
    const updated = result.session;

    const summary = [...updated.messages]
      .reverse()
      .find((m) => m.role === MessageRole.SUMMARY && !m.disabled)
      ?.content ?? '';
    if (!summary.trim()) {
      warning('CONTEXT', `Subagent compression: пустое резюме, сессия ${childSessionId}`);
      return null;
    }

    const pair = {
      provider: providerNameOf(provider),
      model: provider.model,
    };
    const tail = optimizer
      .getMessagesForLlm(updated)
      .filter((m) => m.role !== MessageRole.SUMMARY)
      .map((m) => messageToLLMMessage(m, subagentType, pair));

    const rebuilt = buildOverflowRetryMessages({ summary, tail, currentTurn: [] });
    if (!rebuilt) {
      warning(
        'CONTEXT',
        `Subagent compression: не удалось пересобрать контекст (разорваны tool-пары), сессия ${childSessionId}`,
      );
      return null;
    }

    // Прогресс-гард: сжатие обязано снять порог триггера. Если порог остался —
    // сжатие не помогло: cooldown, чтобы авто-триггер не звал LLM по кругу.
    if (optimizer.shouldCompress(updated, { ignoreCooldown: true }).triggered) {
      if (typeof optimizer.noteCompressionFailure === 'function') {
        optimizer.noteCompressionFailure(childSessionId);
      }
      warning(
        'CONTEXT',
        `Subagent compression не снял порог триггера, сессия ${childSessionId}`,
      );
    } else if (typeof optimizer.clearCompressionFailure === 'function') {
      optimizer.clearCompressionFailure(childSessionId);
    }

    return rebuilt;
  } catch (e) {
    // Отмена прогона — не провал сжатия: cooldown не ставим (иначе следующий
    // прогон не сможет сжаться ещё 10 минут).
    if (cancelToken.cancelled || opts.isAborted?.()) return null;
    if (typeof optimizer.noteCompressionFailure === 'function') {
      optimizer.noteCompressionFailure(childSessionId);
    }
    warning(
      'CONTEXT',
      `Subagent compression failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    // Провал виден пользователю: сжатие ребёнка на границе шага не состоялось
    // — событие `context.summarization_failed` в канале child-сессии.
    publishCompressionFailure(eventBus, childSessionId, {
      reason: compressionFailureReason(e),
      message: e instanceof Error ? e.message : String(e),
      mode: childMode ?? 'compaction',
      phase: 'mid_turn',
    });
    return null;
  }
}
