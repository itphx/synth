/**
 * ADR-101 (Pipeline Engine): общие помощники гейтов пайплайна.
 *
 * Гейт (ADR-101 §6) — пауза прогона, ожидающая решения человека. Два вида:
 * `human` (вопрос human-шага) и `tool_approval` (эскалация `ask`-политики
 * permission-слоя). Здесь — то, что одинаково для движка и исполнителей:
 *
 * - результат шага при отклонении гейта (`pipeline.gate_rejected`);
 * - результат шага при истечении таймаута гейта (`pipeline.gate_timeout`);
 * - **активный таймаут** — таймер в процессе (`unref`), по истечении шаг
 *   проваливается, а движок продолжает прогон по условиям перехода;
 * - перевод решения оператора в результат шага.
 */
import type { PipelineNode, StepResult } from '@itphx/synth-shared';

import { t } from '../system-messages.js';
import type { PipelineGate, PipelineGateDecision } from './types.js';

/** Результат шага при отклонении гейта человеком. */
export function gateRejectedResult(node: PipelineNode, attempt: number): StepResult {
  return {
    status: 'failed',
    attempt,
    error: {
      code: 'pipeline.gate_rejected',
      message: t('pipeline.gate_rejected', { node: node.id }),
    },
  };
}

/** Результат шага при истечении таймаута ожидания оператора. */
export function gateTimeoutResult(node: PipelineNode, attempt: number): StepResult {
  return {
    status: 'failed',
    attempt,
    error: {
      code: 'pipeline.gate_timeout',
      message: t('pipeline.gate_timeout', {
        node: node.id,
        timeoutSec: String(node.timeoutSec ?? ''),
      }),
    },
  };
}

/**
 * Результат шага по решению оператора: одобрение — `ok` (выход гейта — в
 * `output`), отклонение — `failed` (`pipeline.gate_rejected`).
 */
export function gateDecisionResult(
  decision: PipelineGateDecision,
  node: PipelineNode,
  attempt: number,
): StepResult {
  if (!decision.approved) return gateRejectedResult(node, attempt);
  const output: Record<string, unknown> = { ...(decision.output ?? {}) };
  if (decision.comment !== undefined && output.comment === undefined) {
    output.comment = decision.comment;
  }
  return { status: 'ok', attempt, output };
}

/**
 * Активный таймаут гейта: таймер живёт в процессе (ядро), `unref` — не держит
 * процесс живым. По истечении вызывается колбэк: шаг проваливается с
 * `pipeline.gate_timeout`, движок продолжает прогон по условиям перехода.
 *
 * Таймер намеренно **не отменяется** по месту: гейт может быть закрыт
 * `resume` раньше, и тогда сработавший таймер должен быть проигнорирован
 * движком (проверка по токену гейта) — иначе он провалил бы уже завершённый
 * прогон.
 */
export function startGateTimeout(timeoutSec: number, onTimeout: () => void): void {
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return;
  const timer = setTimeout(onTimeout, timeoutSec * 1000);
  // `unref` есть у таймеров Node; в тестовых средах может отсутствовать.
  if (typeof timer.unref === 'function') timer.unref();
}

/** Данные гейта human-шага: вопрос оператору + таймаут ожидания. */
export function humanGate(node: PipelineNode): PipelineGate {
  return {
    kind: 'human',
    nodeId: node.id,
    ...(node.prompt ? { question: node.prompt } : {}),
    ...(node.title ? { title: node.title } : {}),
    ...(node.timeoutSec !== undefined ? { timeoutSec: node.timeoutSec } : {}),
  };
}
