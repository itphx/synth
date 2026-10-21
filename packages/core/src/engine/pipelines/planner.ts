/**
 * ADR-101 (Pipeline Engine): выбор следующего узла (правила переходов).
 *
 * Правила (документированы в docs/PIPELINES.md §2.13):
 *
 * 1. **Узел с `on`** — переходы проверяются **по порядку**; первый, чьё
 *    условие выполнено, — победитель (остальные не проверяются). Если ни одно
 *    условие не выполнено — перехода нет (`null`).
 * 2. **Узел без `on`** — линейный переход к следующему по порядку узлу
 *    `spec.nodes`; последний узел → перехода нет.
 * 3. **Провал шага** (`prev.status === 'failed'`) — линейного перехода нет:
 *    продолжить прогон после ошибки можно только **явным** переходом по
 *    условию (обычно — на узел «починки»). Если такого перехода нет, прогон
 *    падает (`pipeline.step_failed`): неявного «проглотить ошибку» нет.
 * 4. Перехода нет (`null`) при **успешном** шаге → прогон завершается штатно
 *    (`done`) и срабатывают выходы `spec.exits`. Спецификация без выходов
 *    невалидна (`pipeline.invalid_spec`), поэтому «перехода нет» = «дошли до
 *    выходов», а не «упали».
 *
 * Циклы ограничены **лимитом переходов** на прогон
 * (`MAX_PIPELINE_TRANSITIONS`): при его превышении прогон падает с понятной
 * ошибкой `pipeline.loop_limit` (защита от бесконечного цикла в графе).
 */
import type { PipelineNode, PipelineSpec, PipelineRunTrigger, StepResult } from '@itphx/synth-shared';

import { evaluateCondition } from './condition.js';
import type { PipelinePathContext } from './types.js';

/** Максимум переходов на один прогон (защита от бесконечного цикла). */
export const MAX_PIPELINE_TRANSITIONS = 100;

/** Контекст выбора следующего узла. */
export interface PlannerContext {
  /** Узел, переходы из которого выбираются. */
  node: PipelineNode;
  /** Результат шага этого узла (для условий и правила «провал → нет перехода»). */
  prev?: StepResult;
  /** Триггер прогона. */
  trigger: PipelineRunTrigger;
  /** Разрешённые переменные спецификации. */
  vars: Record<string, unknown>;
}

/**
 * Идентификатор следующего узла или `null` (перехода нет).
 *
 * Чистая функция: ни IO, ни состояния — только спецификация и результат шага.
 */
export function nextNodeId(spec: PipelineSpec, ctx: PlannerContext): string | null {
  const transitions = ctx.node.on ?? [];

  if (transitions.length > 0) {
    const pathCtx: PipelinePathContext = {
      ...(ctx.prev ? { prev: ctx.prev } : {}),
      trigger: ctx.trigger,
      vars: ctx.vars ?? {},
    };
    for (const transition of transitions) {
      if (!transition?.when) continue;
      if (evaluateCondition(transition.when, pathCtx)) {
        return transition.then;
      }
    }
    return null;
  }

  // Провал шага без явного перехода — прогон падает (см. правило 3).
  if (ctx.prev?.status === 'failed') return null;

  const index = spec.nodes.findIndex((node) => node.id === ctx.node.id);
  if (index === -1) return null;
  const next = spec.nodes[index + 1];
  return next ? next.id : null;
}
