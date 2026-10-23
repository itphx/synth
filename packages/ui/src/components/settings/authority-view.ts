// ADR-106 Ф5: разбор контента полномочий пакета (`provides.authority`) в вид
// для read-only раздела «Полномочия».
//
// Источник — **сырой манифест** пакета (`GET /api/v2/packs/:name` → `manifest`).
// Разбор defensive: неизвестные/битые элементы пропускаются, а не роняют
// раздел (как `summarizePackAuthority` на сервере). Секретов в манифесте нет.

/** Грант «действие × цель» с эффектом. */
export interface AuthorityGrantView {
  /** Доменное действие (`read`/`write`/`execute`/…). */
  action: string
  /** Шаблон цели (`project:*`, `path:src/**`…). */
  targetPattern: string
  /** Эффект гранта: `allow`/`ask`/`deny`. */
  effect: string
}

/** Роль пакета с её грантами. */
export interface AuthorityRoleView {
  /** id роли. */
  id: string
  /** Отображаемое имя роли (если объявлено). */
  displayName?: string
  /** Домен роли. */
  domain: string
  /** Гранты роли. */
  grants: AuthorityGrantView[]
}

/** Объявленное доменное действие. */
export interface AuthorityActionView {
  /** id действия. */
  id: string
  /** Признак мутирующего действия. */
  mutating: boolean
}

/** Объявленный вид цели. */
export interface AuthorityTargetView {
  /** Вид цели (`kind`). */
  kind: string
  /** Имя резолвера цели (если объявлен). */
  resolver?: string
}

/** Привязка агента к ролям и потолку. */
export interface AuthorityAgentView {
  /** id агента. */
  id: string
  /** Роли агента. */
  roles: string[]
  /** Потолок агента (id действий). */
  ceiling: string[]
}

/** Контент полномочий пакета в виде для UI. */
export interface PackAuthorityContentView {
  roles: AuthorityRoleView[]
  actions: AuthorityActionView[]
  targets: AuthorityTargetView[]
  agents: AuthorityAgentView[]
}

/** Значение — объект (не массив, не null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Список строк (только строки, без мусора). */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** Гранты роли — только корректные тройки «действие × цель, эффект». */
function parseGrants(value: unknown): AuthorityGrantView[] {
  if (!Array.isArray(value)) return []
  const grants: AuthorityGrantView[] = []
  for (const raw of value) {
    if (!isPlainObject(raw)) continue
    const action = typeof raw.action === 'string' ? raw.action : ''
    const targetPattern = typeof raw.targetPattern === 'string' ? raw.targetPattern : ''
    const effect = typeof raw.effect === 'string' ? raw.effect : ''
    if (!action || !targetPattern || !effect) continue
    grants.push({ action, targetPattern, effect })
  }
  return grants
}

/**
 * Контент полномочий пакета из сырого манифеста.
 *
 * `null` — манифест не приносит контента полномочий (нет `provides.authority`
 * или в нём пусто). Пустой контент (`roles/actions/targets/agents` пусты) —
 * тоже `null`: показывать нечего.
 */
export function parsePackAuthority(manifest: unknown): PackAuthorityContentView | null {
  if (!isPlainObject(manifest)) return null
  const provides = isPlainObject(manifest.provides) ? manifest.provides : {}
  const authority = isPlainObject(provides.authority) ? provides.authority : null
  if (!authority) return null

  const roles: AuthorityRoleView[] = []
  if (Array.isArray(authority.roles)) {
    for (const raw of authority.roles) {
      if (!isPlainObject(raw)) continue
      const id = typeof raw.id === 'string' ? raw.id : ''
      if (!id) continue
      roles.push({
        id,
        ...(typeof raw.displayName === 'string' ? { displayName: raw.displayName } : {}),
        domain: typeof raw.domain === 'string' ? raw.domain : '',
        grants: parseGrants(raw.grants),
      })
    }
  }

  const actions: AuthorityActionView[] = []
  if (Array.isArray(authority.actions)) {
    for (const raw of authority.actions) {
      if (!isPlainObject(raw)) continue
      const id = typeof raw.id === 'string' ? raw.id : ''
      if (!id) continue
      actions.push({ id, mutating: raw.mutating === true })
    }
  }

  const targets: AuthorityTargetView[] = []
  if (Array.isArray(authority.targets)) {
    for (const raw of authority.targets) {
      if (!isPlainObject(raw)) continue
      const kind = typeof raw.kind === 'string' ? raw.kind : ''
      if (!kind) continue
      targets.push({
        kind,
        ...(typeof raw.resolver === 'string' ? { resolver: raw.resolver } : {}),
      })
    }
  }

  const agents: AuthorityAgentView[] = []
  if (Array.isArray(authority.agents)) {
    for (const raw of authority.agents) {
      if (!isPlainObject(raw)) continue
      const id = typeof raw.id === 'string' ? raw.id : ''
      if (!id) continue
      agents.push({ id, roles: stringList(raw.roles), ceiling: stringList(raw.ceiling) })
    }
  }

  if (roles.length === 0 && actions.length === 0 && targets.length === 0 && agents.length === 0) {
    return null
  }
  return { roles, actions, targets, agents }
}
