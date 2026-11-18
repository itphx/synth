/**
 * Деобфускация в точках потребления (ADR-036).
 * Тулы вызывают deobfuscateText/deobfuscateArgs перед внешним I/O
 * (shell, файл, веб, git, grep, MCP).
 * Безопасно: если сессия/карта обфускации недоступна — данные не меняются.
 */

import type { ToolContext } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import { ObfuscationMapStore } from '../gateway/obfuscation-map-store.js';
import { obfuscationSessionId } from './session-scope.js';

/**
 * Карта обфускации берётся у **сессии LLM-вызова** (`extra.sessionId`), а не у
 * сессии-владельца прогона (`ctx.sessionId`): плейсхолдеры `⟦SYNTH_SECRET_N⟧`
 * ставит GatewayProvider, привязанный к сессии хода, и карта живёт в ней. У
 * саб-агента `ctx.sessionId` — его собственная сессия (реестр прогонов/логи/
 * audit), а карта — родительская: без этого правила плейсхолдер уходил бы в
 * shell/файл нерасшифрованным (секрет — наружу вместо подстановки).
 */

/** Деобфусцирует строку через карту обфускации сессии (если сессия доступна). */
export async function deobfuscateText(ctx: ToolContext, text: string): Promise<string> {
  const sessionManager = ctx.extra?.sessionManager as SessionManager | undefined;
  if (!sessionManager) return text;
  const store = new ObfuscationMapStore(sessionManager);
  return store.restoreForText(obfuscationSessionId(ctx), text);
}

/** Рекурсивно деобфусцирует аргументы через карту обфускации сессии (если сессия доступна). */
export async function deobfuscateArgs(ctx: ToolContext, args: unknown): Promise<unknown> {
  const sessionManager = ctx.extra?.sessionManager as SessionManager | undefined;
  if (!sessionManager) return args;
  const store = new ObfuscationMapStore(sessionManager);
  return store.restoreForArgs(obfuscationSessionId(ctx), args);
}
