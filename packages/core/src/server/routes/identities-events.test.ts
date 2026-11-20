/**
 * Событие шины `identities.updated` на HTTP-путях идентичностей пользователя.
 *
 * Баг: «идентичность, привязанная подтверждением кода в другой вкладке или на
 * другом устройстве, и отвязка в соседнем клиенте видны в панели профиля только
 * после перезагрузки страницы»: `ProfileSettings` грузит список
 * (`GET /api/v2/me/identities`) один раз при монтировании и обновляет его только
 * после **своих** действий, а сервер о чужих молчал.
 *
 * Контракт проверяется целиком:
 * - `POST /identities/claim` (успешное подтверждение) → `action: 'claim'`;
 * - `DELETE /identities/:provider/:externalId` (отвязка) → `action: 'delete'`;
 * - **не** публикуется при ошибке: 400 (нет кода/битое тело), 401 (профиль не
 *   определён — код при этом не сжигается), 404 (неизвестный код, нет
 *   идентичности), 409 (пара занята другим профилем);
 * - payload — только вид мутации: **`provider`/`externalId` (персональные
 *   данные), claim-код и токены в событие не попадают** (инвариант 13).
 *
 * Хук подменён фейком (`onIdentitiesChanged` — тот же хук, что у
 * `identitiesChangedPublisher`): тест про контракт фабрики, а не про EventBus
 * (сам шов — `src/events/identities-events.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, Next } from 'hono';
import type { ProfileData } from '@itphx/synth-shared';
import { createIdentityRoutes } from './identities.js';
import type { IdentityRoutesOptions } from './identities.js';
import { FileProfileStore } from '../../storage/profile-store.js';
import { IdentityClaimStore } from '../../storage/identity-claim-store.js';
import { publishIdentitiesUpdated } from '../../events/identities-events.js';
import type { IdentitiesChangedInfo } from '../../events/identities-events.js';

/** Записанное событие (канал + тип + payload). */
interface PublishedEvent {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: инстансные события. */
function makeBus(published: PublishedEvent[]) {
  return {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel: 'instance', type, data });
    },
  };
}

/** Тот же путь публикации, что у точки сборки: `identitiesChangedPublisher(eventBus)`. */
function identitiesHook(published: PublishedEvent[]) {
  const bus = makeBus(published);
  return (info: IdentitiesChangedInfo) => publishIdentitiesUpdated(bus, info);
}

const auth = {
  requireAuth: async (_c: Context, next: Next) => {
    await next();
  },
};

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

describe('createIdentityRoutes — событие identities.updated на write-путях', () => {
  let tmpDir: string;
  let store: FileProfileStore;
  let claimStore: IdentityClaimStore;
  let published: PublishedEvent[];

  const makeApp = (profileId = 'u1', opts: IdentityRoutesOptions = {}) => {
    const app = new Hono();
    app.route(
      '/api/v2/me',
      createIdentityRoutes(auth, store, {
        resolveProfileId: () => profileId,
        claimStore,
        onIdentitiesChanged: identitiesHook(published),
        ...opts,
      }),
    );
    return app;
  };

  const postClaim = (app: Hono, body: unknown) =>
    app.request('/api/v2/me/identities/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    published = [];
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-identities-events-'));
    store = new FileProfileStore({ dataDir: tmpDir });
    claimStore = new IdentityClaimStore({ dataDir: tmpDir });
    await store.saveProfile(makeProfile({ id: 'u1' }));
    await store.saveProfile(makeProfile({ id: 'u2', username: 'jane' }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST /identities/claim — успех публикует { action: claim } без идентификаторов и кода', async () => {
    const created = await claimStore.create({
      provider: 'tg',
      externalId: '450316139',
      chatKey: 'chat:telegram:450316139',
      principalId: 'tg:450316139',
    });

    const res = await postClaim(makeApp(), { code: created.code });

    expect(res.status).toBe(201);
    expect(published).toEqual([
      { channel: 'instance', type: 'identities.updated', data: { action: 'claim' } },
    ]);
    // Персональные данные и одноразовый код в событие не попадают.
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain('450316139');
    expect(serialized).not.toContain(created.code);
    expect(serialized).not.toContain('tg:');
    expect(serialized).not.toContain('chat:telegram');
  });

  it('DELETE /identities/:provider/:externalId — отвязка публикует { action: delete }', async () => {
    await store.linkIdentity('u1', {
      provider: 'tg',
      externalId: '777',
      linkedAt: '2026-03-01T10:00:00.000Z',
    });

    const res = await makeApp().request('/api/v2/me/identities/tg/777', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'identities.updated', data: { action: 'delete' } },
    ]);
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain('777');
    expect(serialized).not.toContain('provider');
  });

  it('ошибки молчат: 400 (нет кода), 401 (нет профиля), 404 (код/идентичность), 409 (конфликт)', async () => {
    const app = makeApp();

    // 400 — кода нет или тело битое.
    expect((await postClaim(app, {})).status).toBe(400);
    expect((await postClaim(app, { code: '   ' })).status).toBe(400);
    expect(
      (
        await app.request('/api/v2/me/identities/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{oops',
        })
      ).status,
    ).toBe(400);
    // 404 — неизвестный код и отсутствующая идентичность.
    expect((await postClaim(app, { code: 'ZZZZZZ' })).status).toBe(404);
    expect((await app.request('/api/v2/me/identities/tg/nope', { method: 'DELETE' })).status).toBe(404);
    // 401 — профиль не определён (код при этом не сжигается).
    const noProfile = makeApp('');
    const created = await claimStore.create({ provider: 'tg', externalId: '1', principalId: 'tg:1' });
    expect((await postClaim(noProfile, { code: created.code })).status).toBe(401);
    expect((await noProfile.request('/api/v2/me/identities/tg/1', { method: 'DELETE' })).status).toBe(401);
    // 409 — пара уже привязана к другому профилю.
    await store.linkIdentity('u2', {
      provider: 'tg',
      externalId: '555',
      linkedAt: '2026-03-01T10:00:00.000Z',
    });
    const conflict = await claimStore.create({ provider: 'tg', externalId: '555', principalId: 'tg:555' });
    expect((await postClaim(makeApp('u1'), { code: conflict.code })).status).toBe(409);

    expect(published).toEqual([]);

    // Контроль: после ошибок исправная отвязка событие всё же публикует —
    // claim-код, не сожжённый на 401, остался живым.
    expect((await postClaim(app, { code: created.code })).status).toBe(201);
    expect(published.map((e) => e.data.action)).toEqual(['claim']);
  });

  it('каждый запрос — ровно одно событие', async () => {
    const first = await claimStore.create({ provider: 'tg', externalId: '1', principalId: 'tg:1' });
    const second = await claimStore.create({ provider: 'tg', externalId: '2', principalId: 'tg:2' });
    const app = makeApp();

    expect((await postClaim(app, { code: first.code })).status).toBe(201);
    expect((await postClaim(app, { code: second.code })).status).toBe(201);

    expect(published).toHaveLength(2);
    expect(published.every((e) => e.channel === 'instance')).toBe(true);
    expect(published.every((e) => e.type === 'identities.updated')).toBe(true);
    expect(published.map((e) => e.data)).toEqual([{ action: 'claim' }, { action: 'claim' }]);
  });

  it('без хука (onIdentitiesChanged не передан) фабрика работает как раньше', async () => {
    const app = new Hono();
    app.route(
      '/api/v2/me',
      createIdentityRoutes(auth, store, { resolveProfileId: () => 'u1', claimStore }),
    );
    const created = await claimStore.create({ provider: 'tg', externalId: '9', principalId: 'tg:9' });

    expect((await postClaim(app, { code: created.code })).status).toBe(201);
    expect(published).toEqual([]);
  });
});
