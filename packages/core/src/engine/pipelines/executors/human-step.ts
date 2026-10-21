/**
 * ADR-101 (Pipeline Engine): исполнитель шага вида `human` (HITL-гейт).
 *
 * Шаг `human` — **пауза прогона**: движок переводит прогон в `awaiting_human`,
 * пишет в журнал `gate.awaiting` и возвращает управление; решение оператора
 * приходит через `PipelineEngine.resume()`.
 *
 * ## Активный таймаут
 *
 * Таймаут ожидания (`node.timeoutSec`) — **активный**: таймер живёт в процессе
 * ядра (`unref`, `startGateTimeout`), а не проверяется только при `resume`.
 * По истечении шаг проваливается с `pipeline.gate_timeout`, а движок
 * продолжает прогон по условиям перехода (или завершает его, если перехода
 * нет) — ровно как при любом другом провале шага.
 *
 * ## Решение оператора
 *
 * При повторном исполнении узла (после `resume`) исполнитель **не** запрашивает
 * гейт заново, а применяет решение: одобрение — `ok` (выход гейта — в
 * `output`), отклонение — `failed` (`pipeline.gate_rejected`).
 */
import { gateDecisionResult, gateTimeoutResult, humanGate, startGateTimeout } from '../gate.js';
import type { StepExecutionContext, StepExecutor, StepOutcome } from '../types.js';

/**
 * Исполнитель шага вида `human`.
 *
 * Опций нет: таймаут и вопрос берутся из узла (`node.timeoutSec`,
 * `node.prompt`/`node.title`).
 */
export const humanStepExecutor: StepExecutor = {
  kind: 'human',
  async execute(ctx: StepExecutionContext): Promise<StepOutcome> {
    // Решение оператора уже есть — применяем его (шаг не запрашивает гейт заново).
    if (ctx.gateDecision) {
      return gateDecisionResult(ctx.gateDecision, ctx.node, ctx.attempt);
    }

    const gate = humanGate(ctx.node);

    // Активный таймаут ожидания оператора: по истечении шаг проваливается.
    if (ctx.node.timeoutSec !== undefined && ctx.node.timeoutSec > 0) {
      startGateTimeout(ctx.node.timeoutSec, () => {
        ctx.onGateTimeout?.(gate, gateTimeoutResult(ctx.node, ctx.attempt));
      });
    }

    return { kind: 'gate', gate };
  },
};

/** Фабрика исполнителя human-шага (симметрия с остальными видами шага). */
export function createHumanStepExecutor(): StepExecutor {
  return humanStepExecutor;
}
