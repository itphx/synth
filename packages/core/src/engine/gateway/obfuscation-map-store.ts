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
 * - `metadata.secrets` — реальные значения плейсхолдеров, которые оркестратор
 *   кладёт в metadata сообщения (ADR-036, «раскрытие секретов в UI»).
 *
 * `metadata.secrets` вырезается из **всех** коллекций сообщений сессии, а не
 * только из `messages[]`. Аудит типа `Session`
 * (`packages/shared/src/types/session.ts`) — носители сообщений:
 * - `messages[]` — история диалога;
 * - `pendingMessages[]` — runtime-очередь (те же `Message`);
 * - `checkpoints[].messages[]` — снимки истории (`Checkpoint.messages`).
 *
 * Проход РЕКУРСИВНЫЙ и не привязан к именам полей: `metadata.secrets` не
 * остаётся нигде в payload'е — так закрываются и будущие поля с сообщениями
 * (например, `Branch.messages` из shared-типов), и вложенные узлы сообщения
 * (`parts[].data`).
 *
 * Исходный объект НЕ мутируется: копируются только узлы, в которых что-то
 * изменилось (copy-on-write); неизменённые поддеревья остаются теми же
 * объектами. Форма payload'а не меняется — результат остаётся валидным
 * переносимым payload'ом (publish/fork).
 */

/** Предельная глубина обхода payload'а (страховка от циклических структур). */
const STRIP_MAX_DEPTH = 64;

/** `metadata` — обычный объект, у которого есть ключ `secrets`. */
function _hasSecrets(metadata: unknown): boolean {
  return !!metadata
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && Object.hasOwn(metadata, 'secrets');
}

/**
 * Убирает `metadata.secrets` из узла и всех вложенных узлов (copy-on-write).
 * Возвращает исходный узел, если ничего не изменилось.
 */
function _stripSecretsDeep(value: unknown, depth: number): unknown {
  if (depth > STRIP_MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = _stripSecretsDeep(item, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const current = obj[key];
    if (key === 'metadata' && _hasSecrets(current)) {
      const rest: Record<string, unknown> = { ...(current as Record<string, unknown>) };
      delete rest.secrets;
      out[key] = rest;
      changed = true;
      continue;
    }
    const next = _stripSecretsDeep(current, depth + 1);
    if (next !== current) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

export function stripSessionSecrets<T>(session: T): T {
  const out = { ...(session as object) } as Record<string, unknown>;
  delete out.obfuscationMap;
  return _stripSecretsDeep(out, 0) as T;
}
