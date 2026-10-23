/**
 * In-memory реализация порта политики полномочий инстанса (ADR-096, ADR-106 Ф0).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): политика — в памяти
 * процесса. Семантика повторяет файловую (`FileAuthorityPolicyStore`):
 * документа нет → `null` («политика не задана»), документ — полная замена.
 */

import type { AuthorityPolicy } from '@itphx/synth-shared';
import { authorityPolicySchema } from '@itphx/synth-shared';
import type { AuthorityPolicyRepository } from '../ports/index.js';

/** Порт политики полномочий поверх состояния в памяти. */
export class MemoryAuthorityPolicyRepository implements AuthorityPolicyRepository {
  private _policy: AuthorityPolicy | null = null;

  async getPolicy(): Promise<AuthorityPolicy | null> {
    return this._policy === null ? null : structuredClone(this._policy);
  }

  async savePolicy(policy: AuthorityPolicy): Promise<void> {
    this._policy = structuredClone(authorityPolicySchema.parse(policy));
  }
}
