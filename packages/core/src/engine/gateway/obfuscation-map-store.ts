/**
 * ObfuscationMapStore (AD-036) — доступ к карте обфускации сессии через SessionManager.
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
