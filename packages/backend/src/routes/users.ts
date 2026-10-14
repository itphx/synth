import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { ProfileStore, ProfileData } from '@itphx/synth-shared';
import { nowISO } from '@itphx/synth-shared';
import { randomUUID } from 'node:crypto';
import { t } from '../lib/i18n.js';
import { requireAdminOrScope } from '../auth/guards.js';

export function createUserRoutes(kit: AuthKit, profiles: ProfileStore): Hono {
  const app = new Hono();

  // GET /api/v2/users — список всех пользователей (ADMIN или scope `users:read`).
  // Идентичности сознательно не включаются: список не раздувается (детали — в /:id).
  app.get('/', requireAdminOrScope('users:read'), async (c) => {
    const all = await profiles.listProfiles();
    return c.json({
      users: all.map((p) => ({
        id: p.id,
        username: p.username,
        email: p.email || null,
        phone: p.phone || null,
        roles: p.roles,
        team_roles: p.teamRoles,
        display_name: p.displayName || null,
        is_active: p.isActive,
        notes: p.notes,
        preferences: p.preferences,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
        last_login: p.lastLogin || null,
      })),
    });
  });

  // GET /api/v2/users/:id — детали пользователя (ADMIN или scope `users:read`).
  // AD-089/O1: отдаёт `identities` профиля (snake_case) — нужно аддонам для
  // адресации внешних идентичностей машинной кредой.
  app.get('/:id', requireAdminOrScope('users:read'), async (c) => {
    const id = c.req.param('id');
    const p = await profiles.loadProfile(id);
    if (!p) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.user', undefined, c) } }, 404);
    }
    return c.json({
      id: p.id,
      username: p.username,
      email: p.email || null,
      phone: p.phone || null,
      roles: p.roles,
      team_roles: p.teamRoles,
      display_name: p.displayName || null,
      is_active: p.isActive,
      notes: p.notes,
      identities: (p.identities ?? []).map((identity) => ({
        provider: identity.provider,
        external_id: identity.externalId,
        ...(identity.username !== undefined ? { username: identity.username } : {}),
        ...(identity.displayName !== undefined ? { display_name: identity.displayName } : {}),
        linked_at: identity.linkedAt,
        ...(identity.linkedBy !== undefined ? { linked_by: identity.linkedBy } : {}),
      })),
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      last_login: p.lastLogin || null,
    });
  });

  // POST /api/v2/users — создать пользователя (admin)
  app.post('/', kit.requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const username = body.username?.trim();
    if (!username) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.usernameRequired', undefined, c) } }, 400);
    }

    const existing = await profiles.getProfileByUsername(username);
    if (existing) {
      return c.json({ error: { code: 'CONFLICT', message: t('errors.conflict.usernameExists', undefined, c) } }, 409);
    }

    if (body.email) {
      const byEmail = await profiles.getProfileByEmail(body.email);
      if (byEmail) {
        return c.json({ error: { code: 'CONFLICT', message: t('errors.conflict.emailExists', undefined, c) } }, 409);
      }
    }

    const now = nowISO();
    const profile: ProfileData = {
      id: randomUUID(),
      username,
      email: body.email || undefined,
      roles: Array.isArray(body.roles) ? body.roles : ['USER'],
      teamRoles: Array.isArray(body.team_roles) ? body.team_roles : [],
      isActive: body.is_active ?? true,
      preferences: {},
      notes: body.notes || '',
      interviewCompleted: false,
      displayName: body.display_name || undefined,
      createdAt: now,
      updatedAt: now,
    };

    await profiles.saveProfile(profile);
    return c.json(profile, 201);
  });

  // PUT /api/v2/users/:id — обновить пользователя (admin)
  app.put('/:id', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const p = await profiles.loadProfile(id);

    if (!p) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.user', undefined, c) } }, 404);
    }

    if (body.username !== undefined && body.username !== p.username) {
      const byUser = await profiles.getProfileByUsername(body.username);
      if (byUser && byUser.id !== id) {
        return c.json({ error: { code: 'CONFLICT', message: t('errors.conflict.usernameTaken', undefined, c) } }, 409);
      }
    }
    if (body.email !== undefined && body.email !== p.email) {
      const byEmail = await profiles.getProfileByEmail(body.email);
      if (byEmail && byEmail.id !== id) {
        return c.json({ error: { code: 'CONFLICT', message: t('errors.conflict.emailTaken', undefined, c) } }, 409);
      }
    }

    p.username = body.username ?? p.username;
    p.email = body.email !== undefined ? body.email : p.email;
    p.roles = Array.isArray(body.roles) ? body.roles : p.roles;
    p.teamRoles = Array.isArray(body.team_roles) ? body.team_roles : p.teamRoles;
    p.displayName = body.display_name !== undefined ? body.display_name : p.displayName;
    p.isActive = body.is_active ?? p.isActive;
    p.notes = body.notes !== undefined ? body.notes : p.notes;
    p.preferences = body.preferences !== undefined ? { ...p.preferences, ...body.preferences } : p.preferences;
    p.updatedAt = nowISO();

    await profiles.saveProfile(p);
    return c.json(p);
  });

  // DELETE /api/v2/users/:id — удалить пользователя (admin)
  app.delete('/:id', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    const deleted = await profiles.deleteProfile(id);
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.user', undefined, c) } }, 404);
    }
    return c.json({ status: 'deleted' });
  });

  return app;
}
