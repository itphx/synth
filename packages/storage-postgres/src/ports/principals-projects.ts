/**
 * Порт `projects` PostgreSQL-драйвера (ADR-097, волна 3b).
 *
 * Эталон семантики — `ProjectStore`/`MemoryProjectRepository`:
 *   - `create()` — синхронная чистая фабрика (id, `members`, 4 дефолтные колонки
 *     плана, пустые `statusMessages`/`log`, `version: 1`, таймстемпы);
 *   - `list(userId)` — владелец **или** участник, сортировка `updated_at DESC`;
 *   - `delete` отсутствующего — не ошибка; `load` отсутствующего — `null`.
 *
 * `members` — child-таблица `project_members` (PK `(project_id,user_id)`,
 * индекс `(user_id)`): `save` заменяет набор участий в той же транзакции, что и
 * строку проекта. `plan`/`log`/`status_messages`/`repos`/`mcp`/`skills` — `jsonb`.
 */

import { randomUUID } from 'node:crypto';
import { normalizeColorKey, normalizeIconKey } from '@itphx/synth-shared';
import type { StorageContext } from '@itphx/synth-core';
import type { PostgresConnection } from '../pool.js';
import { jsonbParam, requiredIso, type ProjectEntity } from './principals-shared.js';

type ProjectsPort = StorageContext['projects'];

/** Строка `projects` + агрегированные участия (`members`). */
type ProjectRow = {
  id: string;
  name: string;
  owner_id: string;
  description: string;
  current_task: string;
  invariants: string;
  icon: string | null;
  color: string | null;
  workspace: string | null;
  plan: unknown;
  log: unknown;
  status_messages: unknown;
  repos: unknown;
  mcp: unknown;
  skills: unknown;
  members: Record<string, string> | null;
  created_at: Date | string;
  updated_at: Date | string;
};

/** Проекции проекта + json-агрегация участий одним запросом (без N+1). */
const SELECT_PROJECT = `
  SELECT p.*, COALESCE(m.members, '{}'::jsonb) AS members
  FROM projects p
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(pm.user_id, pm.role) AS members
    FROM project_members pm
    WHERE pm.project_id = p.id
  ) m ON true`;

function rowToProject(row: ProjectRow): ProjectEntity {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    members: (row.members ?? {}) as ProjectEntity['members'],
    description: row.description ?? '',
    currentTask: row.current_task ?? '',
    invariants: row.invariants ?? '',
    // Нормализация метаданных при чтении (паритет с `ProjectStore.load`):
    // невалидные/legacy-ключи → `undefined`.
    icon: normalizeIconKey(row.icon),
    color: normalizeColorKey(row.color),
    workspace: row.workspace ?? undefined,
    repos: (row.repos ?? undefined) as ProjectEntity['repos'],
    mcp: (row.mcp ?? undefined) as ProjectEntity['mcp'],
    skills: (row.skills ?? undefined) as ProjectEntity['skills'],
    statusMessages: (row.status_messages ?? []) as ProjectEntity['statusMessages'],
    plan: (row.plan ?? undefined) as ProjectEntity['plan'],
    log: (row.log ?? undefined) as ProjectEntity['log'],
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

/** Собрать порт проектов поверх SQL. */
export function createPrincipalProjectsPort(conn: PostgresConnection): ProjectsPort {
  return {
    async load(id: string): Promise<ProjectEntity | null> {
      const rows = await conn.query<ProjectRow>(`${SELECT_PROJECT} WHERE p.id = $1`, [id]);
      const row = rows[0];
      return row ? rowToProject(row) : null;
    },

    async save(project: ProjectEntity): Promise<void> {
      await conn.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO projects (
             id, name, owner_id, description, current_task, invariants, icon, color,
             workspace, plan, log, status_messages, repos, mcp, skills, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17
           )
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             owner_id = EXCLUDED.owner_id,
             description = EXCLUDED.description,
             current_task = EXCLUDED.current_task,
             invariants = EXCLUDED.invariants,
             icon = EXCLUDED.icon,
             color = EXCLUDED.color,
             workspace = EXCLUDED.workspace,
             plan = EXCLUDED.plan,
             log = EXCLUDED.log,
             status_messages = EXCLUDED.status_messages,
             repos = EXCLUDED.repos,
             mcp = EXCLUDED.mcp,
             skills = EXCLUDED.skills,
             updated_at = EXCLUDED.updated_at`,
          [
            project.id,
            project.name,
            project.ownerId,
            project.description ?? '',
            project.currentTask ?? '',
            project.invariants ?? '',
            project.icon ?? null,
            project.color ?? null,
            project.workspace ?? null,
            jsonbParam(project.plan ?? null),
            jsonbParam(project.log ?? null),
            jsonbParam(project.statusMessages ?? []),
            jsonbParam(project.repos ?? null),
            jsonbParam(project.mcp ?? null),
            jsonbParam(project.skills ?? null),
            project.createdAt,
            project.updatedAt,
          ],
        );

        // Набор участий — источник истины в самом проекте: заменяем целиком.
        await tx.query('DELETE FROM project_members WHERE project_id = $1', [project.id]);
        for (const [userId, role] of Object.entries(project.members ?? {})) {
          await tx.query(
            'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
            [project.id, userId, role],
          );
        }
      });
    },

    async delete(id: string): Promise<void> {
      await conn.query('DELETE FROM projects WHERE id = $1', [id]);
    },

    async list(userId?: string): Promise<ProjectEntity[]> {
      const rows = userId
        ? await conn.query<ProjectRow>(
            `${SELECT_PROJECT}
             WHERE p.owner_id = $1
                OR EXISTS (
                  SELECT 1 FROM project_members pm2
                  WHERE pm2.project_id = p.id AND pm2.user_id = $1
                )
             ORDER BY p.updated_at DESC`,
            [userId],
          )
        : await conn.query<ProjectRow>(`${SELECT_PROJECT} ORDER BY p.updated_at DESC`);
      return rows.map(rowToProject);
    },

    create(name, ownerId, data): ProjectEntity {
      const now = new Date().toISOString();
      return {
        id: randomUUID(),
        name,
        ownerId,
        members: { [ownerId]: 'owner' as ProjectEntity['members'][string] },
        description: data?.description || '',
        currentTask: '',
        invariants: '',
        icon: data?.icon,
        color: data?.color,
        workspace: data?.workspace,
        repos: data?.repos,
        // ADR-071 §2.4 / ADR-046 §4.5: сид скоупа новых проектов (снимок системных дефолтов).
        ...(data?.mcp ? { mcp: data.mcp } : {}),
        ...(data?.skills ? { skills: data.skills } : {}),
        statusMessages: [],
        plan: {
          version: 1,
          updatedAt: now,
          columns: [
            { id: 'backlog', name: 'Бэклог', order: 0 },
            { id: 'todo', name: 'К выполнению', order: 1 },
            { id: 'in_progress', name: 'В работе', order: 2 },
            { id: 'done', name: 'Готово', order: 3 },
          ],
          items: [],
        },
        log: [],
        createdAt: now,
        updatedAt: now,
      };
    },
  };
}
