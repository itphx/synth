/**
 * ADR-101 (Pipeline Engine): разрешение **точечных путей** данных прогона.
 *
 * Пути — единственный способ условию или маппингу увидеть данные прогона
 * (ADR-101 §5): никакого `eval`, никаких вычислений по регулярным выражениям —
 * только разбор по `.` и обход объектов/массивов.
 *
 * Поддерживаемые корни (контракт для условий и маппинга, docs/PIPELINES.md
 * §2.6.1):
 *
 * | Путь            | Что означает                                    |
 * |-----------------|-------------------------------------------------|
 * | `prev.output.*` | Выход предыдущего шага (`StepResult.output`)     |
 * | `prev.status`   | Статус предыдущего шага (`ok`/`failed`/…)        |
 * | `prev.error.code` | Код ошибки предыдущего шага                    |
 * | `prev.artifacts`  | Артефакты предыдущего шага (ADR-116; `kind:'blob'` — ссылка на объект) |
 * | `trigger.payload.*` | Payload триггера прогона                     |
 * | `trigger.kind` / `trigger.source` / `trigger.type` | Атрибуты триггера   |
 * | `vars.*`        | Переменные спецификации (`spec.vars`)            |
 *
 * Всё, что не попало в таблицу, — **неизвестный путь**: значение не
 * определяется (fail-soft), условие не выполняется, шаг падает.
 */
import type { StepResult } from '@itphx/synth-shared';

import type { PipelinePathContext } from './types.js';

/** Ключи, запрещённые при обходе объектов (защита от прототипа). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Обход объекта/массива по точечному пути.
 *
 * Возвращает `undefined`, если путь не существует, ведёт в скаляр или в
 * не-объект: **без исключений** (fail-soft, ADR-101 §5).
 */
export function resolvePathValue(root: unknown, path: string): unknown {
  if (typeof path !== 'string') return undefined;
  const parts = path.split('.').filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;

  let current: unknown = root;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      // Индекс массива — только целое число в границах.
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    if (FORBIDDEN_KEYS.has(part)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Корни данных прогона, доступные по пути.
 *
 * Собирается «плоский» объект: `prev`/`trigger`/`vars`. Значение `prev` —
 * **результат шага** (до или текущего — в зависимости от момента вызова).
 */
function buildRoot(ctx: PipelinePathContext): Record<string, unknown> {
  const prev: StepResult | undefined = ctx.prev;
  return {
    prev: prev
      ? {
          status: prev.status,
          output: prev.output ?? {},
          // ADR-116: артефакты шага доступны маппингу (`prev.artifacts`):
          // агентский шаг прикладывает объекты `kind:'blob'` как вложения.
          // Пустой список не подставляется — иначе `exists` на `prev.artifacts`
          // стал бы истинным там, где артефактов нет (fail-soft семантика путей).
          ...(prev.artifacts && prev.artifacts.length > 0 ? { artifacts: prev.artifacts } : {}),
          error: prev.error ? { code: prev.error.code, message: prev.error.message } : undefined,
        }
      : undefined,
    trigger: {
      kind: ctx.trigger?.kind,
      source: ctx.trigger?.source,
      type: ctx.trigger?.type,
      payload: ctx.trigger?.payload ?? {},
    },
    vars: ctx.vars ?? {},
  };
}

/**
 * Значение по пути прогона (`prev.output.x`, `trigger.payload.y`, `vars.z`).
 *
 * Неизвестный путь → `undefined` (без исключения): вызывающая сторона решает,
 * что это значит (условие не выполнено / путь пропущен в маппинге).
 */
export function resolvePipelinePath(path: string, ctx: PipelinePathContext): unknown {
  return resolvePathValue(buildRoot(ctx), path);
}
