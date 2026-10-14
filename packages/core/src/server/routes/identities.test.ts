import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { ProfileData } from '@itphx/synth-shared';
import { createIdentityRoutes } from './identities.js';
import type { IdentityRoutesAuth } from './identities.js';
import { FileProfileStore } from '../../storage/profile-store.js';
import { IdentityClaimStore } from '../../storage/identity-claim-store.js';

const auth = {
  requireAuth: async (_c: Context, next: Next) => {
    await next();
  },
} as unknown as IdentityRoutesAuth;

function makeProfile(overrides: Partial<ProfileData> = {}): ProfileData {
  const now = new Date().toISOString();
  return {
    id: 'u1',
    username: 'john',
    roles: ['USER'],
    teamRoles: [],
    isActive: true,
    preferences: {},
    notes: '',
    interviewCompleted: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Identity routes (AD-089)', () => {
  let tmpDir: string;
  let store: FileProfileStore;
  let claimStore: IdentityClaimStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-identity-routes-'));
    store = new FileProfileStore({ dataDir: tmpDir });
    claimStore = new IdentityClaimStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Приложение с фиксированным id профиля (изоляция по resolveProfileId). */
  const makeApp = (profileId = 'u1') => {
    const app = new Hono();
    app.route('/api/v2/me', createIdentityRoutes(auth, store, {
      resolveProfileId: () => profileId,
      claimStore,
    }));
    return app;
  };

  /** Приложение с кастомным резолвером id профиля (напр. поиск по username). */
  const makeAppWithResolver = (resolve: () => string | Promise<string>) => {
    const app = new Hono();
    app.route('/api/v2/me', createIdentityRoutes(auth, store, {
      resolveProfileId: resolve,
      claimStore,
    }));
    return app;
  };

  const postClaim = (app: Hono, body: unknown) =>
    app.request('/api/v2/me/identities/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET /me/identities — пустой список, если профиля нет', async () => {
    const res = await makeApp().request('/api/v2/me/identities');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identities: [] });
  });

  it('GET /me/identities — список привязок текущего пользователя', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    await store.linkIdentity('u1', {
      provider: 'tg',
      externalId: '450316139',
      displayName: 'John Doe',
      linkedAt: '2026-03-01T10:00:00.000Z',
    });

    const res = await makeApp().request('/api/v2/me/identities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identities: Array<{ provider: string; externalId: string }> };
    expect(body.identities).toHaveLength(1);
    expect(body.identities[0]).toMatchObject({ provider: 'tg', externalId: '450316139' });
  });

  it('DELETE /me/identities/:provider/:externalId — 200 и привязка исчезает', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    await store.linkIdentity('u1', {
      provider: 'tg',
      externalId: '1',
      linkedAt: '2026-03-01T10:00:00.000Z',
    });

    const del = await makeApp().request('/api/v2/me/identities/tg/1', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { identities: unknown[] }).identities).toEqual([]);

    const after = await makeApp().request('/api/v2/me/identities');
    expect(((await after.json()) as { identities: unknown[] }).identities).toEqual([]);
  });

  it('DELETE — 404, если идентичности нет', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    const res = await makeApp().request('/api/v2/me/identities/tg/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('изоляция: пользователь A не видит и не удаляет идентичности B', async () => {
    await store.saveProfile(makeProfile({ id: 'uA', username: 'a' }));
    await store.saveProfile(makeProfile({ id: 'uB', username: 'b' }));
    await store.linkIdentity('uB', {
      provider: 'tg',
      externalId: '2',
      linkedAt: '2026-03-01T10:00:00.000Z',
    });

    // A не видит привязку B.
    const listA = await makeApp('uA').request('/api/v2/me/identities');
    expect(((await listA.json()) as { identities: unknown[] }).identities).toEqual([]);

    // A не может удалить привязку B (профиля A с такой парой нет → 404).
    const delA = await makeApp('uA').request('/api/v2/me/identities/tg/2', { method: 'DELETE' });
    expect(delA.status).toBe(404);

    // Привязка B на месте.
    expect(await store.findProfileByExternalId('tg', '2')).not.toBeNull();
  });

  // --- AD-089 (claim-flow): POST /me/identities/claim ---

  it('POST /claim — успех: 201, identity привязана, linkedBy = текущий пользователь', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    const created = await claimStore.create({
      provider: 'tg',
      externalId: '450316139',
      chatKey: 'chat:telegram:450316139',
      principalId: 'tg:450316139',
    });
    // Ввод «как в чате»: нижний регистр, дефисы/пробелы — consume нормализует.
    const messy = ` ${created.code.toLowerCase()} `;

    const res = await postClaim(makeApp('u1'), { code: messy });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { identity: { provider: string; externalId: string; linkedBy?: string } };
    expect(body.identity).toMatchObject({ provider: 'tg', externalId: '450316139', linkedBy: 'u1' });

    const profile = await store.loadProfile('u1');
    expect(profile?.identities).toHaveLength(1);
    expect(profile?.identities?.[0]).toMatchObject({
      provider: 'tg',
      externalId: '450316139',
      linkedBy: 'u1',
    });
  });

  it('POST /claim — регресс: профиль резолвится по username, а user.id ≠ profile.id', async () => {
    // Профиль хранится под сгенерированным id; пользователь аутентификации имеет
    // другой id. Резолвер повторяет backend: ищет профиль по username.
    await store.saveProfile(makeProfile({ id: 'profile-uuid-1', username: 'developer' }));
    const created = await claimStore.create({
      provider: 'tg',
      externalId: '777',
      principalId: 'tg:777',
    });

    const app = makeAppWithResolver(async () => {
      const p = await store.getProfileByUsername('developer');
      return p?.id ?? '';
    });

    const res = await postClaim(app, { code: created.code });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { identity: { linkedBy?: string } };
    expect(body.identity.linkedBy).toBe('profile-uuid-1');

    const profile = await store.loadProfile('profile-uuid-1');
    expect(profile?.identities?.[0]).toMatchObject({
      provider: 'tg',
      externalId: '777',
      linkedBy: 'profile-uuid-1',
    });
  });

  it('POST /claim — core (standalone): дефолтный resolveProfileId резолвит профиль local', async () => {
    // Резолвер не передан — фабрика использует профиль `local` (id генерируется).
    const app = new Hono();
    app.route('/api/v2/me', createIdentityRoutes(auth, store, { claimStore }));
    const created = await claimStore.create({
      provider: 'tg',
      externalId: '999',
      principalId: 'tg:999',
    });

    const res = await postClaim(app, { code: created.code });
    expect(res.status).toBe(201);

    const local = await store.getProfileByUsername('local');
    expect(local).not.toBeNull();
    expect(local?.id).not.toBe('local');
    expect(local?.identities?.[0]).toMatchObject({ provider: 'tg', externalId: '999' });
  });

  it('GET /me/identities — пустой resolveProfileId → 401 UNAUTHORIZED', async () => {
    const res = await makeAppWithResolver(() => '').request('/api/v2/me/identities');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('DELETE /me/identities/:provider/:externalId — пустой resolveProfileId → 401', async () => {
    const res = await makeAppWithResolver(() => '   ').request('/api/v2/me/identities/tg/1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('POST /claim — пустой resolveProfileId → 401, код остаётся живым (не потреблён)', async () => {
    const created = await claimStore.create({
      provider: 'tg',
      externalId: '1',
      principalId: 'tg:1',
    });

    const res = await postClaim(makeAppWithResolver(() => ''), { code: created.code });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');

    // 401 отдаётся до consume — код не сожжён и может быть использован после входа.
    const active = await claimStore.list(true);
    expect(active.some((c) => c.code === created.code)).toBe(true);
  });

  it('POST /claim — одноразовость: повторное использование кода → 404', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    const created = await claimStore.create({
      provider: 'tg',
      externalId: '1',
      principalId: 'tg:1',
    });

    const first = await postClaim(makeApp('u1'), { code: created.code });
    expect(first.status).toBe(201);

    const second = await postClaim(makeApp('u1'), { code: created.code });
    expect(second.status).toBe(404);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('POST /claim — неизвестный код → 404', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    const res = await postClaim(makeApp('u1'), { code: 'ZZZ-ZZZ' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('POST /claim — истёкший код → 404', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    const created = await claimStore.create({
      provider: 'tg',
      externalId: '1',
      principalId: 'tg:1',
      ttlSec: -1,
    });
    const res = await postClaim(makeApp('u1'), { code: created.code });
    expect(res.status).toBe(404);
  });

  it('POST /claim — пустой/отсутствующий код → 400 VALIDATION_ERROR', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    for (const body of [{ code: '' }, { code: '   ' }, {}, { code: 42 }]) {
      const res = await postClaim(makeApp('u1'), body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('POST /claim — невалидный JSON → 400 VALIDATION_ERROR', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    const res = await makeApp('u1').request('/api/v2/me/identities/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('POST /claim — идентичность занята другим профилем → 409 CONFLICT', async () => {
    await store.saveProfile(makeProfile({ id: 'uA', username: 'a' }));
    await store.saveProfile(makeProfile({ id: 'uB', username: 'b' }));
    // Пара уже привязана к uA.
    await store.linkIdentity('uA', {
      provider: 'tg',
      externalId: '450316139',
      linkedAt: '2026-03-01T10:00:00.000Z',
    });
    const created = await claimStore.create({
      provider: 'tg',
      externalId: '450316139',
      principalId: 'tg:450316139',
    });

    const res = await postClaim(makeApp('uB'), { code: created.code });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
    // Привязка A не перезаписана.
    expect((await store.findProfileByExternalId('tg', '450316139'))?.id).toBe('uA');
  });

  it('POST /claim — provider/externalId берутся из записи claim, поля в теле игнорируются', async () => {
    await store.saveProfile(makeProfile({ id: 'u1' }));
    const created = await claimStore.create({
      provider: 'tg',
      externalId: '111',
      principalId: 'tg:111',
    });

    // Попытка подставить чужую пару в теле — сервер её не читает.
    const res = await postClaim(makeApp('u1'), {
      code: created.code,
      provider: 'web',
      externalId: 'evil',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { identity: { provider: string; externalId: string } };
    expect(body.identity).toMatchObject({ provider: 'tg', externalId: '111' });

    const profile = await store.loadProfile('u1');
    expect(profile?.identities?.[0]).toMatchObject({ provider: 'tg', externalId: '111' });
    expect(await store.findProfileByExternalId('web', 'evil')).toBeNull();
  });

  it('POST /claim — без claimStore роут не смонтирован (404)', async () => {
    const app = new Hono();
    app.route('/api/v2/me', createIdentityRoutes(auth, store, { resolveProfileId: () => 'u1' }));
    const created = await claimStore.create({ provider: 'tg', externalId: '1', principalId: 'tg:1' });
    const res = await postClaim(app, { code: created.code });
    expect(res.status).toBe(404);
  });
});
