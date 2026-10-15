/**
 * Деобфускация в точках потребления (ADR-036).
 * Тулы вызывают deobfuscateText/deobfuscateArgs перед внешним I/O
 * (shell, файл, веб, git, grep, MCP).
 * Безопасно: если сессия/карта обфускации недоступна — данные не меняются.
 */

import type { ToolContext } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import { ObfuscationMapStore } from '../gateway/obfuscation-map-store.js';

/** Деобфусцирует строку через карту обфускации сессии (если сессия доступна). */
export async function deobfuscateText(ctx: ToolContext, text: string): Promise<string> {
  const sessionManager = ctx.extra?.sessionManager as SessionManager | undefined;
  if (!sessionManager) return text;
  const store = new ObfuscationMapStore(sessionManager);
  return store.restoreForText(ctx.sessionId, text);
}

/** Рекурсивно деобфусцирует аргументы через карту обфускации сессии (если сессия доступна). */
export async function deobfuscateArgs(ctx: ToolContext, args: unknown): Promise<unknown> {
  const sessionManager = ctx.extra?.sessionManager as SessionManager | undefined;
  if (!sessionManager) return args;
  const store = new ObfuscationMapStore(sessionManager);
  return store.restoreForArgs(ctx.sessionId, args);
}
