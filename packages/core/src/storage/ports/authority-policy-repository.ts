/**
 * ADR-106 Ф0: порт политики полномочий инстанса (ADR-096).
 *
 * Политика — **одна на инстанс** (не на проект/сессию): потолок инстанса —
 * верхняя граница для всех осей (ADR-106 §«Права только сужаются»).
 * Контент (`provides.authority` пакета) активируется **только** после одобрения
 * ADMIN и всегда пересекается с этой политикой — «пакет не может выдать себе
 * права» (ADR-106 §«Пересечение, не дарование»).
 *
 * Файловая реализация — `packages/core/src/storage/file-authority-policy-store.ts`,
 * in-memory — `packages/core/src/storage/memory/authority-policy.ts`.
 */
import type { AuthorityPolicy } from '@itphx/synth-shared';

export interface AuthorityPolicyRepository {
  /**
   * Политика инстанца; `null` — документ не задан (оси нет).
   * @future-backend — `SELECT document FROM authority_policy WHERE id = 'instance'`.
   */
  getPolicy(): Promise<AuthorityPolicy | null>;
  /** Полная замена политики инстанца (атомарная запись). */
  savePolicy(policy: AuthorityPolicy): Promise<void>;
}
