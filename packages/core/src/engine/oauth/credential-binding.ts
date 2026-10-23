/**
 * ADR-105 (Ф3): право привязать внешний доступ к коннектору.
 *
 * Коннектор ссылается на доступ **по id** (`auth: { kind: 'credential',
 * credentialId }`) — сам токен в реестре не лежит. Привязка выдаёт коннектору
 * право действовать от имени доступа, поэтому она проверяется **на границе**
 * (инвариант 16): правило живёт здесь, а в обработчике — только вызов.
 *
 * Правило (fail-closed):
 *
 * | Доступ | Кто может привязать |
 * |---|---|
 * | `owner.kind='user'`/`'local'` (свой) | владелец доступа |
 * | `owner.kind='instance'` (инстансный) | `ADMIN`/`LEAD` |
 * | `projectId` задан (уровень проекта) | участник проекта с правом изменения содержимого (`OWNER`/`EDITOR`, а также `LEAD`/`ADMIN`) |
 * | остальное | никто (403) |
 *
 * Доступа нет — 404 (единый стиль проекта: «чужой/несуществующий» не смешивается).
 * Личное (`user`/`local`) право `ADMIN`/`LEAD` **не** расширяет: инстансный
 * доступ выдаёт инстанс, личный — его владелец.
 */
import { GlobalRole } from '@itphx/synth-shared';
import type { ExternalCredentialMeta } from '@itphx/synth-shared';

/** Актор запроса: пользователь инстанса или service-key (ADR-052). */
export interface CredentialBindActor {
  /**
   * id актора: пользователя инстанса (standalone — `local`) либо синтетический
   * `service:<keyId>` для service-key.
   */
  userId: string;
  /** Глобальные роли актора (`ADMIN`, `LEAD`, …). */
  roles: readonly string[];
}

/** Решение по привязке: разрешено или код отказа. */
export type CredentialBindDecision =
  | { allowed: true }
  | { allowed: false; code: 'NOT_FOUND' | 'FORBIDDEN'; reason: string };

/** Вход проверки права привязки. */
export interface CredentialBindInput {
  /** Доступ (метаданные) либо `null`, если записи нет. */
  credential: ExternalCredentialMeta | null;
  /** Актор запроса. */
  actor: CredentialBindActor;
  /**
   * Право участника проекта **изменять содержимое** проекта (`OWNER`/`EDITOR`,
   * а также `LEAD`/`ADMIN` — их право даёт `canManageProject`). Граница
   * (backend — `createProjectAccess`) передаёт готовую проверку; не задана —
   * проектный доступ привязать нельзя (fail-closed).
   */
  canEditProject?: (projectId: string) => boolean | Promise<boolean>;
}

/** `ADMIN`/`LEAD` — инстансный уровень (ADR-089, ADR-052). */
function isElevated(actor: CredentialBindActor): boolean {
  return actor.roles.includes(GlobalRole.ADMIN) || actor.roles.includes(GlobalRole.LEAD);
}

/**
 * Право привязать доступ к коннектору.
 *
 * Возвращает решение, а не HTTP-ответ: маппинг в код ответа делает вызывающий
 * слой (backend — `mcp-registry.ts`, Ф4 — `createOAuthRoutes`).
 */
export async function evaluateCredentialBind(
  input: CredentialBindInput,
): Promise<CredentialBindDecision> {
  const { credential, actor } = input;

  // Нет записи — 404 (стиль проекта: «не найдено» ≠ «нет доступа»).
  if (!credential) {
    return { allowed: false, code: 'NOT_FOUND', reason: 'Внешний доступ не найден' };
  }

  // 1. Владелец привязывает свой доступ (пользовательский или локальный).
  const owner = credential.owner;
  if ((owner.kind === 'user' || owner.kind === 'local') && owner.id === actor.userId) {
    return { allowed: true };
  }

  // 2. Инстансный доступ — только ADMIN/LEAD.
  if (owner.kind === 'instance') {
    return isElevated(actor)
      ? { allowed: true }
      : {
        allowed: false,
        code: 'FORBIDDEN',
        reason: 'Инстансный доступ может привязать только ADMIN или LEAD',
      };
  }

  // 3. Доступ уровня проекта — участник проекта с правом изменения содержимого.
  if (credential.projectId) {
    const canEdit = input.canEditProject
      ? await input.canEditProject(credential.projectId)
      : false;
    return canEdit
      ? { allowed: true }
      : {
        allowed: false,
        code: 'FORBIDDEN',
        reason: 'Проектный доступ может привязать только участник проекта с правом изменения',
      };
  }

  // 4. Чужой личный доступ — нельзя (fail-closed).
  return { allowed: false, code: 'FORBIDDEN', reason: 'Привязать чужой доступ нельзя' };
}
