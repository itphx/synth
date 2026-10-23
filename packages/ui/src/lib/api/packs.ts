// packs: домен API v2 (ADR-095) — реестр установок пакетов расширений (ADR-086 §5).
//
// Типы объявлены локально (как в соседних доменах): тянуть core в браузерный
// бандл нельзя (см. `packages/ui/AGENTS.md`).
//
// Правда чтения: в core — `requireAuth`, в managed (backend) — **ADMIN**
// (реестр инстанса, как service-keys/webhooks). Одобрение и снятие установки —
// только ADMIN (guard сервера); UI лишь прячет недоступное.

import { BASE_URL, fetchJSON } from './base'

/** Статус установки пакета в инстансе. */
export type PackInstallationStatus = 'active' | 'pending_approval' | 'disabled'

/**
 * Что именно пакет поставил в инстанс (id'ы установленных сущностей) —
 * нужно для снятия установки.
 */
export interface PackProvides {
  /** id установленных агентов. */
  agents: string[]
  /** id установленных скиллов. */
  skills: string[]
  /** id зарегистрированных MCP-серверов. */
  mcp: string[]
  /** id установленных пайплайнов. */
  pipelines: string[]
}

/**
 * ADR-106 Ф5: сводка контента полномочий пакета (`provides.authority`) —
 * роли/действия/цели/агенты, которые пакет приносит инстанцу.
 */
export interface PackAuthoritySummaryRole {
  /** id роли (уникален в пределах пакета). */
  id: string
  /** Отображаемое имя роли (если объявлено). */
  displayName?: string
  /** Домен роли. */
  domain: string
  /** Число грантов роли. */
  grants: number
  /** Число мутирующих грантов роли. */
  mutatingGrants: number
}

/** Доменное действие, объявленное пакетом. */
export interface PackAuthoritySummaryAction {
  /** id доменного действия. */
  id: string
  /** Признак мутирующего действия (информационный). */
  mutating: boolean
}

/** Вид цели, объявленный пакетом. */
export interface PackAuthoritySummaryTarget {
  /** Вид цели (`kind`). */
  kind: string
  /** Имя резолвера цели (если объявлен). */
  resolver?: string
}

/** Агент пакета с ролями и потолком. */
export interface PackAuthoritySummaryAgent {
  /** id агента. */
  id: string
  /** Роли агента (id из `provides.authority.roles[]`). */
  roles: string[]
  /** Потолок агента (id действий). */
  ceiling: string[]
}

/** Сводка контента полномочий пакета. */
export interface PackAuthoritySummary {
  roles: PackAuthoritySummaryRole[]
  actions: PackAuthoritySummaryAction[]
  targets: PackAuthoritySummaryTarget[]
  agents: PackAuthoritySummaryAgent[]
  totals: {
    roles: number
    actions: number
    targets: number
    agents: number
    grants: number
    mutatingGrants: number
  }
}

/** Запись реестра установок пакетов расширений (ADR-086 §5). */
export interface PackInstallation {
  /** Имя пакета — уникально в инстансе, ключ записи. */
  name: string
  /** Версия пакета (semver). */
  version: string
  /** Класс расширения: `plugin`/`gateway`/`addon`/`pack`/`storage`. */
  kind: string
  /** Тип контент-пака (только для `kind: 'pack'`). */
  packType?: string
  /** Краткое описание. */
  description?: string
  /** Статус установки. */
  status: PackInstallationStatus
  /** Требуется ли подтверждение администратора. */
  requiresApproval: boolean
  /** Что пакет поставил в инстанс. */
  provides: PackProvides
  /**
   * ADR-106 Ф5: сводка контента полномочий пакета — есть у пакетов, которые
   * приносят `provides.authority`. Поля нет, если пакет полномочий не приносит.
   */
  authority?: PackAuthoritySummary
  /**
   * Сырой манифест пакета (есть в ответе `GET /packs/:name`) — источник
   * подробного состава ролей и грантов (`provides.authority.roles[].grants`).
   */
  manifest?: unknown
  /** ISO-время установки. */
  installedAt: string
  /** ISO-время последней записи. */
  updatedAt: string
  /** Кто установил (userId/keyId установщика). */
  installedBy?: string
}

/** Ответ `GET /api/v2/packs` — реестр установок. */
export interface PacksListResponse {
  packs: PackInstallation[]
}

/** Ответ `POST /api/v2/packs/:name/approve` — результат фактической установки. */
export interface PackApprovalResult {
  installed: boolean
  requiresApproval: boolean
  name: string
  version: string
  provides: PackProvides
  /** Проблемы установки (не блокирующие), если сервер их вернул. */
  problems?: string[]
}

export const packsApi = {
  // --- ADR-086 §5: реестр установок пакетов расширений ---
  /** GET /packs — реестр установок пакета. */
  async getPacks(): Promise<PackInstallation[]> {
    const response = await fetchJSON<PacksListResponse>(`${BASE_URL}/packs`)
    return response.packs ?? []
  },

  /** GET /packs/:name — одна установка. */
  async getPack(name: string): Promise<PackInstallation> {
    return fetchJSON<PackInstallation>(`${BASE_URL}/packs/${encodeURIComponent(name)}`)
  },

  /** POST /packs/:name/approve — одобрение пакета, ждущего подтверждения (ADMIN). */
  async approvePack(name: string): Promise<PackApprovalResult> {
    return fetchJSON<PackApprovalResult>(
      `${BASE_URL}/packs/${encodeURIComponent(name)}/approve`,
      { method: 'POST' },
    )
  },

  /** DELETE /packs/:name — снятие установки вместе с поставленными артефактами (ADMIN). */
  async uninstallPack(name: string): Promise<void> {
    await fetchJSON<void>(`${BASE_URL}/packs/${encodeURIComponent(name)}`, { method: 'DELETE' })
  },
}
