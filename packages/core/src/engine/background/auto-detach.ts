/**
 * Авто-перевод блокирующих прогонов в фон при **вмешательстве пользователя** —
 * ADR-111 §detach.
 *
 * Повод — только вмешательство в занятую сессию (`POST /sessions/:id/prompt`:
 * `steer`/`interrupt`, в т.ч. прерывание без текста): блокирующий прогон
 * (`execute_shell` foreground или `task`) держит ход модели, поэтому
 * сообщение дошло бы до модели только после завершения команды/саб-агента.
 * Перевод в фон освобождает ход, а работа продолжается уже фоновым прогоном.
 *
 * Сообщение в **очередь** занятой сессии (`mode=queue`) перевод НЕ делает: оно
 * и так ждёт завершения хода — вмешательства нет, детачировать нечего.
 *
 * Имя `autoDetachOnSteer` сохранено как публичный шов (тесты/роут), хотя
 * семантика шире steer: `interrupt` тоже переводит прогоны.
 *
 * Причина перевода — `'message'` (новое сообщение пользователя): текст
 * результата, который увидит модель, объясняет, что сообщение обработается
 * следом (`background.detached.*_message`).
 *
 * Инварианты:
 * 1. **Мастер-выключатель.** `background.enabled === false` — авто-detach не
 *    выполняется: он создаёт ровно такую же фоновую работу, которую инстанс
 *    запретил. Значение — **живой** геттер оркестратора, не снимок конфига.
 * 2. **Вмешательство важнее перевода.** Ошибка detach не пробрасывается:
 *    сообщение пользователя всё равно должно быть принято (причина — в лог).
 * 3. **Событие — только по факту.** `background.auto_detached` публикуется
 *    лишь когда хоть один прогон действительно переведён: пустой снимок не
 *    должен будить UI.
 * 4. **Не HTTP.** Решение вынесено из роута, чтобы его можно было проверить
 *    без транспорта (юнит-тест).
 */
import type { EventBus } from '../../events/bus.js';
import type { ChatOrchestrator } from '../orchestrator.js';
import type { ActiveRunDetachReason, ActiveRunDetachResult } from './active-runs.js';

/** Минимальный контракт оркестратора, нужный авто-detach. */
export interface AutoDetachOrchestrator {
  /** Реестр активных прогонов сессии (ADR-111 §detach). */
  activeRuns: Pick<ChatOrchestrator['activeRuns'], 'detachAll'>;
  /** Живой мастер-выключатель фоновой работы (`background.enabled`). */
  isBackgroundEnabled?: () => boolean;
}

/** Параметры авто-detach при вмешательстве пользователя. */
export interface AutoDetachOnSteerOptions {
  /** Оркестратор (реестр активных прогонов + живой тумблер). */
  orchestrator: AutoDetachOrchestrator;
  /** Сессия, в которую вмешивается пользователь. */
  sessionId: string;
  /**
   * Мастер-выключатель фоновой работы. Не задан — читается живой геттер
   * оркестратора (иначе — «включено»).
   */
  enabled?: boolean;
  /** Шина событий — публикация `background.auto_detached` в канал сессии. */
  eventBus?: Pick<EventBus, 'publish'>;
  /** Куда писать причину неудачи (по умолчанию — `console.warn`). */
  logger?: { warn(message: string): void };
  /**
   * Причина перевода (попадает в текст результата). По умолчанию `'message'` —
   * авто-detach из-за нового сообщения пользователя.
   */
  reason?: ActiveRunDetachReason;
}

/** Пустой итог (нечего переводить/авто-detach выключен). */
const EMPTY_RESULT: ActiveRunDetachResult = { detached: [], failed: [] };

/**
 * Перевести блокирующие прогоны сессии в фон перед обработкой пользовательского
 * вмешательства (steer, interrupt).
 *
 * Возвращает итог `detachAll` (для тестов/диагностики); исключений не бросает.
 */
export async function autoDetachOnSteer(
  opts: AutoDetachOnSteerOptions,
): Promise<ActiveRunDetachResult> {
  const enabled = opts.enabled
    ?? opts.orchestrator.isBackgroundEnabled?.()
    ?? true;
  if (!enabled) return EMPTY_RESULT;

  const reason = opts.reason ?? 'message';

  let result: ActiveRunDetachResult;
  try {
    result = await opts.orchestrator.activeRuns.detachAll(opts.sessionId, { reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (opts.logger ?? console).warn(
      `[background] авто-detach при вмешательстве не удался (${opts.sessionId}): ${message}`,
    );
    return EMPTY_RESULT;
  }

  // Ошибки отдельных прогонов уже собраны в `failed` — сообщение всё равно
  // ставится; причина видна в логе, а не в ответе на вмешательство.
  if (result.failed.length > 0) {
    const ids = result.failed.map((run) => `${run.id} (${run.code})`).join(', ');
    (opts.logger ?? console).warn(
      `[background] авто-detach при вмешательстве: не переведены ${ids}`,
    );
  }

  if (result.detached.length === 0) return result;

  opts.eventBus?.publish(opts.sessionId, 'background.auto_detached', {
    session_id: opts.sessionId,
    detached: result.detached.map((run) => ({
      id: run.id,
      kind: run.kind,
      ...(run.title ? { title: run.title } : {}),
    })),
    ...(result.failed.length > 0
      ? { failed: result.failed.map((run) => ({ id: run.id, kind: run.kind, code: run.code })) }
      : {}),
  });

  return result;
}
