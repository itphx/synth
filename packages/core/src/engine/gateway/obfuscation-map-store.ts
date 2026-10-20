/**
 * ObfuscationMapStore (ADR-036) — доступ к карте обфускации сессии через SessionManager.
 * Карта живёт в Session.obfuscationMap; read-modify-write — атомарно через withLock.
 */

import type { SessionManager } from '../../sessions/manager.js';
import { deobfuscateSecrets, restoreSecrets } from './obfuscator.js';

export class ObfuscationMapStore {
  constructor(private _sessionManager: SessionManager) {}

  async get(sessionId: string): Promise<Record<string, string>> {
    const session = await this._sessionManager.getSession(sessionId);
    return session?.obfuscationMap ?? {};
  }

  async set(sessionId: string, map: Record<string, string>): Promise<void> {
    await this._sessionManager.withLock(sessionId, async (session) => {
      session.obfuscationMap = map;
      await this._sessionManager.saveSession(session);
    });
  }

  async restoreForText(sessionId: string, text: string): Promise<string> {
    const map = await this.get(sessionId);
    return deobfuscateSecrets(text, map);
  }

  async restoreForArgs(sessionId: string, args: unknown): Promise<unknown> {
    const map = await this.get(sessionId);
    return restoreSecrets(args, map);
  }
}

/**
 * security-фикс 0.11.3: копия сессии/переносимого payload **без секретов**.
 *
 * Убираются оба носителя:
 * - `obfuscationMap` — карта обфускации LLM Gateway (плейсхолдер → РЕАЛЬНЫЙ
 *   секрет), ADR-036;
 * - `messages[].metadata.secrets` — реальные значения плейсхолдеров, которые
 *   оркестратор кладёт в metadata сообщения (ADR-036, «раскрытие секретов в UI»).
 *
 * Исходный объект НЕ мутируется: копируются только те узлы, которые меняются
 * (сам объект, массив сообщений, `metadata` сообщения). Остальное (история,
 * todos, настройки, ссылки) сохраняется — результат остаётся валидным payload'ом
 * переноса (publish/fork).
 */
export function stripSessionSecrets<T>(session: T): T {
  const src = session as { obfuscationMap?: unknown; messages?: unknown };
  const out = { ...(session as object) } as T;
  delete (out as { obfuscationMap?: unknown }).obfuscationMap;
  if (Array.isArray(src.messages)) {
    (out as { messages?: unknown }).messages = src.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      const metadata = (message as { metadata?: unknown }).metadata;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || !('secrets' in (metadata as Record<string, unknown>))) {
        return message;
      }
      const rest: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };
      delete rest.secrets;
      return { ...(message as object), metadata: rest };
    });
  }
  return out;
}
