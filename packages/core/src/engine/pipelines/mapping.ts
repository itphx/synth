/**
 * ADR-101 (Pipeline Engine): маппинг входа шага.
 *
 * В запрос к модели/тулу шага попадает **не** вся история, а только то, что
 * отображено маппингом (ADR-101 §1):
 * - `node.input` — массив путей (`prev.output.report`, `trigger.payload.issue`);
 *   в объекте входа ключ = **путь**, значение = разобранное значение;
 * - `spec.vars` — карта «имя → путь»; в объекте входа ключ = **имя
 *   переменной**, значение = разобранное значение.
 *
 * Пропущенные (неопределённые) пути в результат **не попадают**: шаг не должен
 * получать «пустые» значения под видом существующих.
 */
import type { PipelineNode, PipelineSpec, PipelineRunTrigger, StepResult } from '@itphx/synth-shared';

import { resolvePipelinePath } from './paths.js';
import type { PipelinePathContext } from './types.js';

/**
 * Разрешение переменных спецификации (`spec.vars`: имя → путь).
 *
 * Переменные разрешаются по данным прогона (`prev`/`trigger`); ссылка на
 * другую переменную (`vars.*`) не разрешается — рекурсии нет (fail-soft:
 * значение просто не определяется).
 */
export function resolveSpecVars(
  spec: PipelineSpec,
  ctx: { prev?: StepResult; trigger: PipelineRunTrigger },
): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  const declared = spec.vars;
  if (!declared) return vars;
  for (const [name, path] of Object.entries(declared)) {
    const value = resolvePipelinePath(path, {
      ...(ctx.prev ? { prev: ctx.prev } : {}),
      trigger: ctx.trigger,
      vars: {},
    });
    if (value !== undefined) vars[name] = value;
  }
  return vars;
}

/**
 * Маппинг входа шага — объект «ключ → значение».
 *
 * Ключи: переменные спецификации (по именам) и пути из `node.input` (по
 * самим путям). Явный путь шага приоритетнее одноимённой переменной.
 */
export function resolveStepInput(node: PipelineNode, ctx: PipelinePathContext): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(ctx.vars ?? {})) {
    if (value !== undefined) input[name] = value;
  }

  for (const path of node.input ?? []) {
    const value = resolvePipelinePath(path, ctx);
    if (value !== undefined) input[path] = value;
  }

  return input;
}
