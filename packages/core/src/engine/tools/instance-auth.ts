/**
 * Полномочия ADMIN инстанса для self-help тулов (`synth_mcp_*`/`synth_agent_*`).
 *
 * ## Зачем отдельный модуль
 *
 * До этого каждый тул считал ADMIN сам по `extra.principal.roles` — и в
 * **standalone** это давало ложный отказ: локальный владелец инстанса приходит
 * в тул принципалом с `roles: []` (`engine/authority/principal.ts` →
 * `sessionOwnerPrincipal`), потому что ролей у него нет — их негде взять.
 * При этом единственный админ инстанса (он же человек за консолью) не мог
 * добавить доверенный локальный MCP-сервер из чата: `Error: this MCP operation
 * requires ADMIN`.
 *
 * ## Правило (паритет с HTTP-аутентификацией)
 *
 * `ADMIN` — это либо явная роль принципала (`roles` содержит `ADMIN`, регистр
 * не важен), либо **локальный владелец standalone-инстанса** (`principal.id ===
 * 'local'` при `instanceMeta.mode === 'standalone'`): локальный API-ключ в
 * standalone даёт ровно ADMIN, поэтому тот же человек из чата получает те же
 * права. В managed/hybrid локальный литерал `local` админом **не** считается —
 * там роли приходят с сервера.
 *
 * Fail-closed: нет принципала (`extra.principal`) — нет ADMIN. `USER`/`LEAD`
 * не проходят: `LEAD` остаётся elevated для видимости/проектов, но не получает
 * ADMIN-прав над инстансом (ADR-071).
 */
import type { ToolContext } from '@itphx/synth-shared';
import { LOCAL_USER_ID } from '../../server/local-owner.js';
import type { InstanceRuntimeMeta } from '../instance/meta.js';
import type { ToolPrincipal } from './project-resolve.js';

/** Поля `extra`, нужные проверке ADMIN (минимум зависимостей). */
export interface InstanceAuthExtra {
  principal?: ToolPrincipal;
  /** Снимок метаданных инстанса: режим (`standalone`/`managed`/`hybrid`). */
  instanceMeta?: InstanceRuntimeMeta;
}

/** Принципал хода из `ctx.extra` (нет — `undefined`, fail-closed). */
export function principalOf(ctx: ToolContext): ToolPrincipal | undefined {
  const extra = (ctx.extra ?? {}) as InstanceAuthExtra;
  return extra.principal;
}

/**
 * Является ли вызывающий ADMIN инстанса: явная роль `ADMIN` **или** локальный
 * владелец standalone-инстанса (см. шапку модуля). Нет принципала → `false`.
 */
export function isInstanceAdmin(ctx: ToolContext): boolean {
  const extra = (ctx.extra ?? {}) as InstanceAuthExtra;
  const principal = extra.principal;
  if (!principal) return false;
  if ((principal.roles ?? []).some((role) => role.toUpperCase() === 'ADMIN')) return true;
  // Standalone: человек за консолью = владелец инстанса (паритет с локальным
  // API-ключом, который в standalone даёт ADMIN).
  return extra.instanceMeta?.mode === 'standalone'
    && principal.userId === LOCAL_USER_ID;
}
