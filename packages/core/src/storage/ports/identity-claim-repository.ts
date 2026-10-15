import type { IdentityClaimRecord } from '../identity-claim-store.js';

/**
 * Порт хранилища одноразовых claim-кодов подтверждения владения внешней
 * идентичностью (ADR-089 claim-flow, реализация — `IdentityClaimStore`).
 *
 * Инварианты любой реализации: код одноразовый (`consume` помечает `consumedAt`),
 * `provider`/`externalId` берутся из серверной записи, гонка `consume`
 * сериализуется. @future-backend — `UPDATE … WHERE consumed_at IS NULL` (атомарно).
 */
export interface IdentityClaimRepository {
  create(input: {
    provider: string;
    externalId: string;
    chatKey?: string;
    principalId: string;
    ttlSec?: number;
  }): Promise<IdentityClaimRecord>;
  consume(
    code: string,
    opts: { userId: string; provider?: string; externalId?: string },
  ): Promise<IdentityClaimRecord | null>;
  /** Удаление мёртвых записей (истёкшие/потреблённые); число удалённых. */
  cleanup(now?: number): Promise<number>;
  /** Все записи; `activeOnly` — только живые. */
  list(activeOnly?: boolean): Promise<IdentityClaimRecord[]>;
}
