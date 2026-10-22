/**
 * Доступ тула к порту исполнения (ADR-077, шаг 1).
 *
 * Механизм внедрения — существующий шов зависимостей тулов: `ToolContext.extra`
 * (тем же путём в тул приходят `sessionManager`/`projectStore`/`sshKeyStore`).
 * Оркестратор кладёт в `extra` порт, заданный при сборке приложения
 * (`execution.mode` — параметр запуска, инвариант 24); когда порт не задан
 * (прямые вызовы тулов в тестах, standalone-сборки без явной опции) —
 * fallback на inline-исполнение, то есть на прежнее поведение.
 */

import type { ToolContext } from '@itphx/synth-shared';
import { InlineExecutionPort } from './inline-execution-port.js';
import { isExecutionPort, type ExecutionPort } from './ports/index.js';

/** Ключ порта исполнения в `ToolContext.extra`. */
export const EXECUTION_PORT_KEY = 'executionPort';

/**
 * Порт исполнения для тула: внедрённый (`ctx.extra.executionPort`) либо
 * inline-фоллбэк (исполнение в процессе — прежнее поведение).
 */
export function resolveExecutionPort(ctx: ToolContext): ExecutionPort {
  const extra = ctx.extra as Record<string, unknown> | undefined;
  const port = extra?.[EXECUTION_PORT_KEY];
  return isExecutionPort(port) ? port : new InlineExecutionPort();
}
