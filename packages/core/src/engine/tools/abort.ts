/**
 * Обработка «Стоп» для тулов (консистентно с task.ts):
 * ctx.abortSignal абортируется оркестратором при POST /sessions/:id/abort.
 * Тулы проверяют сигнал на входе (isAborted) и/или передают его в I/O-вызовы,
 * а при прерывании возвращают единый tool_result (abortedResult).
 */

import type { ToolContext, ToolResult } from '@itphx/synth-shared';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/** Проверить, абортирован ли сигнал отмены (быстрые тулы — проверка на входе). */
export function isAborted(ctx: ToolContext): boolean {
  return ctx.abortSignal?.aborted === true;
}

/** Проверка произвольного сигнала (для вспомогательных функций без ToolContext). */
export function signalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Отличить прерывание пользователем от других причин (например таймаут). */
export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: string };
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
}

/**
 * Единый tool_result прерывания (формат task.ts: <status>stopped_by_user</status>,
 * metadata.stopped_by='user', metadata.interrupted=true).
 * @param toolName     имя тула — попадает в metadata.tool
 * @param partialOutput частичный вывод до момента прерывания (stdout, блоки URL и т.п.)
 */
export function abortedResult(toolName: string, partialOutput?: string): ToolResult {
  const parts = [
    '<status>stopped_by_user</status>',
    ...(partialOutput ? [`<partial_output>\n${partialOutput}\n</partial_output>`] : []),
    sm('tool.aborted'),
  ];
  return {
    content: parts.join('\n'),
    metadata: {
      tool: toolName,
      stopped_by: 'user',
      interrupted: true,
      partial_output: partialOutput || undefined,
      i18n: i18nMeta('tool.aborted'),
    },
  };
}
