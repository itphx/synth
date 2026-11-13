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
import { isExecutionRouter, type ExecutionRouter } from './router.js';
import { warning } from '../logger.js';

/** Ключ порта исполнения в `ToolContext.extra`. */
export const EXECUTION_PORT_KEY = 'executionPort';

/** Ключ роутера портов в `ToolContext.extra` (PROP-135 слайс 5a). */
export const EXECUTION_ROUTER_KEY = 'executionRouter';

/**
 * Порт исполнения для тула: внедрённый (`ctx.extra.executionPort`) либо
 * inline-фоллбэк (исполнение в процессе — прежнее поведение).
 */
export function resolveExecutionPort(ctx: ToolContext): ExecutionPort {
  const extra = ctx.extra as Record<string, unknown> | undefined;
  const port = extra?.[EXECUTION_PORT_KEY];
  // Порт есть и умеет FS — используем его. Порт без FS (inline-фоллбэк или
  // старая реализация) при наличии роутера заменяем портом профиля хода:
  // иначе файловые тулы отвечают «Filesystem operations are unavailable»,
  // а shell молча исполняется в control plane.
  if (isExecutionPort(port) && (port.fs || !isExecutionRouter(extra?.[EXECUTION_ROUTER_KEY]))) {
    return port;
  }
  if (isExecutionPort(port)) {
    warning(
      'EXECUTION',
      `executionPort has no fs (isRemote=${String((port as { isRemote?: boolean }).isRemote)}, ` +
      `session=${ctx.sessionId ?? '?'}); selecting port via router`,
    );
  }

  const router = extra?.[EXECUTION_ROUTER_KEY];
  if (isExecutionRouter(router)) {
    try {
      const profile = typeof extra?.executionProfile === 'string' ? extra.executionProfile : undefined;
      const subPath = typeof extra?.executionWorkspaceSubPath === 'string'
        ? extra.executionWorkspaceSubPath
        : undefined;
      const routed = router.portFor({
        ...(profile ? { profile } : {}),
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(subPath ? { workspaceSubPath: subPath } : {}),
      });
      if (isExecutionPort(routed)) return routed;
    } catch (err) {
      warning(
        'EXECUTION',
        `executionPort missing; router.portFor failed (session=${ctx.sessionId ?? '?'}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  warning(
    'EXECUTION',
    `executionPort missing in tool context (session=${ctx.sessionId ?? '?'}); falling back to inline`,
  );
  return new InlineExecutionPort();
}

/**
 * Роутер портов исполнения для тула (`ctx.extra.executionRouter`).
 *
 * Нужен тулам, которые выбирают порт **не по профилю сессии**, а по
 * собственному классу пула (`sandbox_exec` → класс `sandbox`). Роутер
 * кладёт оркестратор; не задан (прямые вызовы тулов в тестах,
 * standalone-сборка без опции, шаги пайплайнов) — `undefined`: тул, которому
 * роутер обязателен, отказывает понятной ошибкой, а не тихо уходит в
 * inline-исполнение (иначе «песочница» исполнилась бы в процессе control
 * plane).
 */
export function resolveExecutionRouter(ctx: ToolContext): ExecutionRouter | undefined {
  const extra = ctx.extra as Record<string, unknown> | undefined;
  const router = extra?.[EXECUTION_ROUTER_KEY];
  return isExecutionRouter(router) ? router : undefined;
}
