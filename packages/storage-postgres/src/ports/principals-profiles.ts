/**
 * Порт `profiles` PostgreSQL-драйвера (ADR-097, волна 3b).
 *
 * Эталон семантики — `FileProfileStore`/`MemoryProfileRepository`:
 *   - `saveProfile` проставляет `updatedAt` при записи;
 *   - `listProfiles` — `updated_at DESC`; `deleteProfile` — boolean;
 *   - `getOrCreateProfile` идемпотентен по `username`;
 *   - ADR-089: `identities` — child-таблица `profile_identities` (snake_case
 *     `external_id`/`display_name`/`linked_at`/`linked_by`, UNIQUE
 *     `(provider, external_id)`); `linkIdentity` идемпотентна и **не бросает**
 *     при конфликте пары с другим профилем (`null`), `unlinkIdentity` без записи
 *     возвращает `null`; обе операции атомарны.
 *
 * `roles`/`team_roles`/`preferences` — `jsonb`; `username`/`email` — UNIQUE.
 */

import { randomUUID } from 'node:crypto';
import type { StorageContext } from '@itphx/synth-core';
import type { PostgresConnection, PostgresExecutor } from '../pool.js';
import {
  jsonbParam,
  requiredIso,
  toIso,
  type ExternalIdentityEntity,
  type ProfileEntity,
} from './principals-shared.js';

type ProfilesPort = StorageContext['profiles'];
type CreateProfileParamsEntity = Parameters<ProfilesPort['getOrCreateProfile']>[0];

type ProfileRow = {
  id: string;
  username: string;
  email: string | null;
  phone: string | null;
  roles: string[] | null;
  team_roles: string[] | null;
  is_active: boolean;
  preferences: Record<string, unknown> | null;
  notes: string | null;
  interview_completed: boolean | null;
  interview_completed_at: Date | string | null;
  display_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_login: Date | string | null;
};

type IdentityRow = {
  profile_id: string;
  provider: string;
  external_id: string;
  username: string | null;
  display_name: string | null;
  linked_at: Date | string;
  linked_by: string | null;
};

const PROFILE_COLUMNS = `id, username, email, phone, roles, team_roles, is_active, preferences,
  notes, interview_completed, interview_completed_at, display_name, created_at, updated_at, last_login`;

const IDENTITY_COLUMNS = `profile_id, provider, external_id, username, display_name, linked_at, linked_by`;

function rowToIdentity(row: IdentityRow): ExternalIdentityEntity {
  return {
    provider: row.provider,
    externalId: row.external_id,
    ...(row.username !== null ? { username: row.username } : {}),
    ...(row.display_name !== null ? { displayName: row.display_name } : {}),
    linkedAt: requiredIso(row.linked_at),
    ...(row.linked_by !== null ? { linkedBy: row.linked_by } : {}),
  };
}

function rowToProfile(row: ProfileRow, identities: ExternalIdentityEntity[]): ProfileEntity {
  // Backfill для legacy-профилей (дословно `FileProfileStore._deserialize`): до
  // появления поля статус интервью хранился меткой `[ИНТЕРВЬЮ]` в `notes`.
  // `??`-семантика: `NULL`-колонка (поле отсутствует) → метка; явный `false`
  // метку игнорирует. Время завершения: `interview_completed_at`, иначе для
  // legacy — `updated_at`.
  const notes = row.notes ?? '';
  const legacyInterview = notes.includes('[ИНТЕРВЬЮ]');
  const interviewCompleted = row.interview_completed ?? legacyInterview;
  const interviewCompletedAt = row.interview_completed_at
    ? requiredIso(row.interview_completed_at)
    : legacyInterview
      ? requiredIso(row.updated_at)
      : undefined;

  return {
    id: row.id,
    username: row.username,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    roles: row.roles ?? [],
    teamRoles: row.team_roles ?? [],
    isActive: row.is_active,
    preferences: row.preferences ?? {},
    notes,
    interviewCompleted,
    ...(interviewCompletedAt !== undefined ? { interviewCompletedAt } : {}),
    displayName: row.display_name ?? undefined,
    identities,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    lastLogin: toIso(row.last_login),
  };
}

/** Прочитать внешние идентичности профиля. */
async function loadIdentities(
  exec: PostgresExecutor,
  profileId: string,
): Promise<ExternalIdentityEntity[]> {
  const rows = await exec.query<IdentityRow>(
    `SELECT ${IDENTITY_COLUMNS} FROM profile_identities WHERE profile_id = $1 ORDER BY id`,
    [profileId],
  );
  return rows.map(rowToIdentity);
}

/** Агрегировать идентичности всех профилей одним запросом (без N+1). */
async function loadAllIdentities(
  exec: PostgresExecutor,
): Promise<Map<string, ExternalIdentityEntity[]>> {
  const rows = await exec.query<IdentityRow>(`SELECT ${IDENTITY_COLUMNS} FROM profile_identities ORDER BY id`);
  const byProfile = new Map<string, ExternalIdentityEntity[]>();
  for (const row of rows) {
    const list = byProfile.get(row.profile_id);
    if (list) list.push(rowToIdentity(row));
    else byProfile.set(row.profile_id, [rowToIdentity(row)]);
  }
  return byProfile;
}

async function selectProfileRow(
  exec: PostgresExecutor,
  column: 'id' | 'username' | 'email',
  value: string,
): Promise<ProfileRow | undefined> {
  const rows = await exec.query<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE ${column} = $1`, [
    value,
  ]);
  return rows[0];
}

async function loadProfileById(
  exec: PostgresExecutor,
  id: string,
): Promise<ProfileEntity | null> {
  const row = await selectProfileRow(exec, 'id', id);
  if (!row) return null;
  return rowToProfile(row, await loadIdentities(exec, id));
}

/**
 * Записать профиль и его идентичности атомарно: строка `profiles` — upsert,
 * `profile_identities` — заменяются целиком (как JSON round-trip файловой
 * реализации, где `identities` — часть профиля).
 */
async function saveProfileRow(exec: PostgresExecutor, profile: ProfileEntity): Promise<void> {
  const updatedAt = new Date().toISOString();
  await exec.query(
    `INSERT INTO profiles (${PROFILE_COLUMNS}) VALUES (
       $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15
     )
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       email = EXCLUDED.email,
       phone = EXCLUDED.phone,
       roles = EXCLUDED.roles,
       team_roles = EXCLUDED.team_roles,
       is_active = EXCLUDED.is_active,
       preferences = EXCLUDED.preferences,
       notes = EXCLUDED.notes,
       interview_completed = EXCLUDED.interview_completed,
       interview_completed_at = EXCLUDED.interview_completed_at,
       display_name = EXCLUDED.display_name,
       updated_at = EXCLUDED.updated_at,
       last_login = EXCLUDED.last_login`,
    [
      profile.id,
      profile.username,
      profile.email ?? null,
      profile.phone ?? null,
      jsonbParam(profile.roles ?? []),
      jsonbParam(profile.teamRoles ?? []),
      profile.isActive,
      jsonbParam(profile.preferences ?? {}),
      profile.notes ?? '',
      profile.interviewCompleted,
      profile.interviewCompletedAt ?? null,
      profile.displayName ?? null,
      profile.createdAt,
      updatedAt,
      profile.lastLogin ?? null,
    ],
  );

  await exec.query('DELETE FROM profile_identities WHERE profile_id = $1', [profile.id]);
  for (const identity of profile.identities ?? []) {
    await exec.query(
      `INSERT INTO profile_identities (${IDENTITY_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        profile.id,
        identity.provider,
        identity.externalId,
        identity.username ?? null,
        identity.displayName ?? null,
        identity.linkedAt,
        identity.linkedBy ?? null,
      ],
    );
  }
}

/** Собрать порт профилей поверх SQL. */
export function createPrincipalProfilesPort(conn: PostgresConnection): ProfilesPort {
  return {
    async loadProfile(id: string): Promise<ProfileEntity | null> {
      return loadProfileById(conn, id);
    },

    async saveProfile(profile: ProfileEntity): Promise<void> {
      await conn.withTransaction(async (tx) => {
        await saveProfileRow(tx, profile);
      });
    },

    async listProfiles(): Promise<ProfileEntity[]> {
      const rows = await conn.query<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM profiles ORDER BY updated_at DESC`);
      const identities = await loadAllIdentities(conn);
      return rows.map((row) => rowToProfile(row, identities.get(row.id) ?? []));
    },

    async deleteProfile(id: string): Promise<boolean> {
      const rows = await conn.query<{ id: string }>('DELETE FROM profiles WHERE id = $1 RETURNING id', [id]);
      return rows.length > 0;
    },

    async getProfileByUsername(username: string): Promise<ProfileEntity | null> {
      const row = await selectProfileRow(conn, 'username', username);
      if (!row) return null;
      return rowToProfile(row, await loadIdentities(conn, row.id));
    },

    async getProfileByEmail(email: string): Promise<ProfileEntity | null> {
      const row = await selectProfileRow(conn, 'email', email);
      if (!row) return null;
      return rowToProfile(row, await loadIdentities(conn, row.id));
    },

    async getOrCreateProfile(params: CreateProfileParamsEntity): Promise<ProfileEntity> {
      const existingRow = await selectProfileRow(conn, 'username', params.username);
      if (existingRow) {
        const current = rowToProfile(existingRow, await loadIdentities(conn, existingRow.id));
        const next: ProfileEntity = {
          ...current,
          ...(params.email ? { email: params.email } : {}),
          ...(params.roles ? { roles: params.roles } : {}),
          ...(params.teamRoles ? { teamRoles: params.teamRoles } : {}),
          ...(params.interviewCompleted !== undefined
            ? { interviewCompleted: params.interviewCompleted }
            : {}),
        };
        await conn.withTransaction(async (tx) => {
          await saveProfileRow(tx, next);
        });
        return next;
      }

      const now = new Date().toISOString();
      const profile: ProfileEntity = {
        id: randomUUID(),
        username: params.username,
        email: params.email,
        roles: params.roles ?? ['USER'],
        teamRoles: params.teamRoles ?? [],
        isActive: true,
        preferences: {},
        notes: '',
        interviewCompleted: params.interviewCompleted ?? false,
        displayName: params.username,
        createdAt: now,
        updatedAt: now,
      };
      await conn.withTransaction(async (tx) => {
        await saveProfileRow(tx, profile);
      });
      return profile;
    },

    async updateLastLogin(id: string): Promise<void> {
      await conn.query('UPDATE profiles SET last_login = now(), updated_at = now() WHERE id = $1', [id]);
    },

    async findProfileByExternalId(
      provider: string,
      externalId: string,
    ): Promise<ProfileEntity | null> {
      const rows = await conn.query<{ profile_id: string }>(
        'SELECT profile_id FROM profile_identities WHERE provider = $1 AND external_id = $2 LIMIT 1',
        [provider, externalId],
      );
      const row = rows[0];
      if (!row) return null;
      return loadProfileById(conn, row.profile_id);
    },

    async linkIdentity(userId, identity): Promise<ProfileEntity | null> {
      const exists = await conn.query<{ id: string }>('SELECT id FROM profiles WHERE id = $1', [userId]);
      if (!exists[0]) return null;

      const outcome = await conn.withTransaction(async (tx) => {
        const inserted = await tx.query<{ profile_id: string }>(
          `INSERT INTO profile_identities (${IDENTITY_COLUMNS})
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (provider, external_id) DO NOTHING
           RETURNING profile_id`,
          [
            userId,
            identity.provider,
            identity.externalId,
            identity.username ?? null,
            identity.displayName ?? null,
            identity.linkedAt ?? new Date().toISOString(),
            identity.linkedBy ?? null,
          ],
        );
        if (inserted.length > 0) return 'inserted' as const;

        // Пара уже существует: идемпотентно для своего профиля, конфликт — чужой.
        const owners = await tx.query<{ profile_id: string }>(
          'SELECT profile_id FROM profile_identities WHERE provider = $1 AND external_id = $2',
          [identity.provider, identity.externalId],
        );
        return owners[0]?.profile_id === userId ? ('existing' as const) : ('conflict' as const);
      });

      if (outcome === 'conflict') return null;
      return loadProfileById(conn, userId);
    },

    async unlinkIdentity(userId, provider, externalId): Promise<ProfileEntity | null> {
      const rows = await conn.query<{ profile_id: string }>(
        `DELETE FROM profile_identities
         WHERE profile_id = $1 AND provider = $2 AND external_id = $3
         RETURNING profile_id`,
        [userId, provider, externalId],
      );
      if (rows.length === 0) return null;
      return loadProfileById(conn, userId);
    },
  };
}
