/**
 * Чья сессия нужна тулу — единые хелперы аудита `ctx.sessionId` (ADR-036/ADR-111).
 *
 * У тула в цикле саб-агента (`engine/tools/task/run-cycle.ts`) две сессии:
 * - `ctx.sessionId` — **сессия-владелец прогона** (ребёнок): реестр блокирующих
 *   и фоновых прогонов, лог процесса, audit исполнений, терминалы, egress;
 * - `extra.sessionId` — **сессия хода/человека** (родитель): события,
 *   `permission.ask/replied`, проектный и automation-скоуп, карта обфускации
 *   Gateway, «текущая сессия» в self-help/проектных тулах.
 *
 * В основной сессии оба значения совпадают, поэтому переход на эти хелперы
 * ничего не меняет; в resume-прогоне (`task-resume.ts`) `extra.sessionId` —
 * тоже дочерняя сессия (поведение прежнее).
 */

import type { ToolContext } from '@itphx/synth-shared';

/** Сессия хода/человека (родитель саб-агента): `extra.sessionId` важнее. */
export function parentSessionIdOf(ctx: ToolContext): string | undefined {
  const extraSessionId = (ctx.extra as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof extraSessionId === 'string' && extraSessionId.length > 0) return extraSessionId;
  return ctx.sessionId;
}

/** Сессия-владелец прогона (ребёнок саб-агента): `ctx.sessionId` важнее. */
export function runSessionIdOf(ctx: ToolContext): string | undefined {
  return ctx.sessionId || parentSessionIdOf(ctx);
}

/**
 * Сессия, в карте обфускации которой лежат плейсхолдеры секретов (ADR-036):
 * её ставит GatewayProvider хода — то есть сессия хода/человека.
 */
export function obfuscationSessionId(ctx: ToolContext): string {
  return parentSessionIdOf(ctx) ?? '';
}
