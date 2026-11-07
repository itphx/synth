// Права изменения содержимого сессии в UI (PROP-054, инвариант 21).
//
// Зеркалит серверный prefix-guard сессий
// (`packages/core/src/server/session-access-guard.ts`): вид доступа выводится
// из HTTP-метода (read/write), а write-доступ к сессии даёт:
//
//   - владелец сессии (`owner_id ?? user_id`);
//   - глобальные роли `ADMIN`/`LEAD`;
//   - участник проекта с правом изменения содержимого (OWNER/EDITOR).
//
// VIEWER читает, но не мутирует (инвариант 21). Enforcement остаётся на
// сервере — UI лишь прячет недоступные действия (как `canEditProjectContent`).

import type { ProjectData, SessionData } from '@/lib/api/synthApi'
import type { User } from '@/lib/api/client'
import { canEditProjectContent } from './projectAccess'

/** Контекст развёртывания, в котором UI показывает права. */
export interface SessionAccessOptions {
  /** UI работает с локальным core (standalone/гибрид) — `deployment === 'standalone'`. */
  standalone?: boolean
}

/** Минимальный набор полей сессии, нужный для решения о доступе. */
export type SessionAccessSubject = Pick<
  SessionData,
  'owner_id' | 'user_id' | 'project_id' | 'origin'
>

/**
 * Есть ли право **изменять** содержимое сессии (ToDo и прочее).
 *
 * Зеркалит серверное правило write-доступа к сессии: владелец → роль →
 * участие в проекте (OWNER/EDITOR). В **локальном мире** (standalone/гибрид)
 * правило шире — личность инстанса и есть владелец локальных сессий (см.
 * комментарий в `projectAccess.ts`); удалённые сущности (`origin: 'remote'`)
 * проверяет удалённая сторона.
 */
export function canEditSessionContent(
  session: SessionAccessSubject | undefined | null,
  user: User | null | undefined,
  project?: Pick<ProjectData, 'owner_id' | 'members' | 'origin'> | undefined | null,
  options?: SessionAccessOptions,
): boolean {
  if (!session || !user) return false
  const roles = user.roles ?? []
  if (roles.includes('ADMIN') || roles.includes('LEAD')) return true

  const owner = session.owner_id ?? session.user_id
  if (owner && owner === user.id) return true

  // Локальный мир однопользовательский: сессии без владельца (легаси) и
  // сессии локального пользователя доступны всегда. Удалённые сущности
  // (`remote:<uuid>`) живут на сервере — доступ проверяет он.
  if (options?.standalone === true && session.origin !== 'remote') return true

  if (!session.project_id) return false
  return canEditProjectContent(project ?? null, user, options)
}
