/**
 * Порт `projects` PostgreSQL-драйвера (ADR-097, волна 3b).
 *
 * Эталон семантики — `ProjectStore`/`MemoryProjectRepository`:
 *   - `create()` — синхронная чистая фабрика (id, `members`, 4 дефолтные колонки
 *     плана, пустые `statusMessages`/`log`, `version: 1`, таймстемпы);
 *   - `list(viewer)` — владелец, участник, грант по группе или режим «всем
 *     пользователям» (PROP-133); без `viewer` — все проекты, сортировка
 *     `updated_at DESC`;
 *   - `delete` отсутствующего — не ошибка; `load` отсутствующего — `null`.
 *
 * `members` — child-таблица `project_members` (PK `(project_id,user_id)`,
 * индекс `(user_id)`): `save` заменяет набор участий в той же транзакции, что и
 * строку проекта. `plan`/`log`/`status_messages`/`repos`/`mcp`/`skills` — `jsonb`.
 * PROP-133: `group_members` (`jsonb`) и `everyone_role` (`text`) — состояние
 * списка доступа; `list` сначала сужает выборку SQL'ем (оптимизация), затем
 * **обязательно** проверяет каждую строку резолвером `resolveProjectAccess`
 * (истина — резолвер, не SQL).
 */

import { randomUUID } from 'node:crypto';
import {
  ProjectRole,
  normalizeColorKey,
  normalizeIconKey,
  normalizeProjectEveryoneRole,
  normalizeProjectMemberRoles,
  resolveProjectAccess,
} from '@itphx/synth-shared';
import type { ProjectViewer } from '@itphx/synth-shared';
import type { StorageContext } from '@itphx/synth-core';
import type { PostgresConnection, PostgresExecutor } from '../pool.js';
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
  memory: unknown;
  members: Record<string, string> | null;
  // PROP-133: состояние списка доступа (гранты группам, режим «всем»).
  group_members: Record<string, string> | null;
  everyone_role: string | null;
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
  // PROP-133: нормализация состояния доступа при чтении (битые роли →
  // `viewer`, `everyone_role` — только `owner|editor|viewer`/`null`).
  //
  // Паритет с `ProjectStore`/`MemoryProjectRepository`: «нет грантов» — это
  // **отсутствие поля**, а не пустой объект/`null`:
  //   - `group_members` в БД — `jsonb`, «нет грантов» записан как `{}`
  //     (нормальное представление в БД) → наружу поле не отдаём;
  //   - `everyone_role` в БД — `text`, «не опубликован» записан как `NULL` →
  //     `null` → `undefined` (поле отсутствует), потому что в БД `NULL` и
  //     «явный `null`» неразличимы, а эталон (file/memory) при создании
  //     оставляет поле **отсутствующим**;
  //   - DTO всё равно отдаёт `?? null`, поэтому наружу контракт не меняется.
  const groupMembers = normalizeProjectMemberRoles(row.group_members);
  const everyoneRole = normalizeProjectEveryoneRole(row.everyone_role ?? undefined);
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    members: normalizeProjectMemberRoles(row.members),
    ...(Object.keys(groupMembers).length > 0 ? { groupMembers } : {}),
    ...(everyoneRole !== undefined && everyoneRole !== null ? { everyoneRole } : {}),
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
    memory: (row.memory ?? undefined) as ProjectEntity['memory'],
    statusMessages: (row.status_messages ?? []) as ProjectEntity['statusMessages'],
    plan: (row.plan ?? undefined) as ProjectEntity['plan'],
    log: (row.log ?? undefined) as ProjectEntity['log'],
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

/**
 * Запись проекта в БД (строка + набор участий) **тем же соединением/транзакцией**,
 * что и вызывающий: `save` и `mutate` не дублируют SQL и не открывают вложенную
 * транзакцию.
 */
async function writeProject(tx: PostgresExecutor, project: ProjectEntity): Promise<void> {
  await tx.query(
    `INSERT INTO projects (
       id, name, owner_id, description, current_task, invariants, icon, color,
       workspace, plan, log, status_messages, repos, mcp, skills, memory,
       group_members, everyone_role, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
       $17::jsonb, $18, $19, $20
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
       memory = EXCLUDED.memory,
       group_members = EXCLUDED.group_members,
       everyone_role = EXCLUDED.everyone_role,
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
      jsonbParam(project.memory ?? null),
      // PROP-133: состояние списка доступа (гранты группам, режим «всем»).
      jsonbParam(project.groupMembers ?? {}),
      project.everyoneRole ?? null,
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
        await writeProject(tx, project);
      });
    },

    /**
     * Атомарный read-modify-write (порт `ProjectRepository.mutate`): блокировка
     * строки `projects` и запись в **одной** транзакции, поэтому параллельные
     * мутации одного проекта сериализуются и не теряют правки друг друга.
     *
     * `FOR UPDATE OF p` — обязательный: `SELECT_PROJECT` содержит
     * `LEFT JOIN LATERAL`, а `FOR UPDATE` без `OF` PostgreSQL отвергает
     * («cannot be applied to the nullable side of an outer join»). `OF p`
     * блокирует только строку проекта (строка агрегата `members` — подзапрос,
     * её lock не нужен: чтение участий идёт в той же транзакции-снимке, а запись
     * заменяет набор под той же блокировкой).
     */
    async mutate(id: string, mutator: (project: ProjectEntity) => void): Promise<ProjectEntity | null> {
      return conn.withTransaction(async (tx) => {
        const rows = await tx.query<ProjectRow>(
          `${SELECT_PROJECT} WHERE p.id = $1 FOR UPDATE OF p`,
          [id],
        );
        const row = rows[0];
        if (!row) return null;
        const project = rowToProject(row);
        mutator(project);
        await writeProject(tx, project);
        return project;
      });
    },

    async delete(id: string): Promise<void> {
      await conn.query('DELETE FROM projects WHERE id = $1', [id]);
    },

    /**
     * Список проектов (PROP-133).
     *
     * Без `viewer` — все проекты (ADMIN/LEAD и внутренние задачи). С
     * `viewer` — SQL сужает выборку (владелец/участник/«всем»/грант по
     * группе) — это **оптимизация**; истина — резолвер `resolveProjectAccess`,
     * поэтому каждая загруженная строка проверяется им (битая роль в данных не
     * выдаёт лишний доступ).
     */
    async list(viewer?: ProjectViewer): Promise<ProjectEntity[]> {
      const rows = viewer
        ? await conn.query<ProjectRow>(
            `${SELECT_PROJECT}
             WHERE p.owner_id = $1
                OR EXISTS (
                  SELECT 1 FROM project_members pm2
                  WHERE pm2.project_id = p.id AND pm2.user_id = $1
                )
                OR p.everyone_role IS NOT NULL
                OR (
                  jsonb_typeof(p.group_members) = 'object'
                  AND p.group_members ?| $2::text[]
                )
             ORDER BY p.updated_at DESC`,
            [viewer.userId, viewer.groups ?? []],
          )
        : await conn.query<ProjectRow>(`${SELECT_PROJECT} ORDER BY p.updated_at DESC`);
      const projects = rows.map(rowToProject);
      if (!viewer) return projects;
      return projects.filter((project) => resolveProjectAccess(project, viewer).read);
    },

    create(name, ownerId, data): ProjectEntity {
      const now = new Date().toISOString();
      // PROP-133: роль владельца всегда `owner` (понизить её нельзя).
      const members = normalizeProjectMemberRoles(data?.members);
      members[ownerId] = ProjectRole.OWNER;
      const groupMembers = data?.groupMembers
        ? normalizeProjectMemberRoles(data.groupMembers)
        : undefined;
      const everyoneRole = normalizeProjectEveryoneRole(data?.everyoneRole);
      return {
        id: randomUUID(),
        name,
        ownerId,
        members,
        ...(groupMembers ? { groupMembers } : {}),
        ...(everyoneRole !== undefined ? { everyoneRole } : {}),
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
