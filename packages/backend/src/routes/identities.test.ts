// ADR-089 (claim-flow): идентичности на backend — сквозной срез через createBackendApp.
// Регресс: `user.id` (debug/OIDC) ≠ `profile.id` (профили хранятся под
// сгенерированным id и ищутся по username). Раньше роут подставлял `user.id` в
// `loadProfile`/`linkIdentity`, профиль не находился, и `POST /me/identities/claim`
// всегда отвечал 409 (при этом код уже был потреблён). Теперь claim даёт 201 и
// привязывает идентичность к профилю, найденному по username.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProfileStore, IdentityClaimStore } from '@itphx/synth-core';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

// Debug-пользователь `developer`: `user.id === user.username === 'developer'`,
// а id профиля — сгенерированный (≠ 'developer') → точный сценарий бага.
const USER_KEY = 'user-key-456';

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('ADR-089 (claim-flow): идентичности на backend (user.id ≠ profile.id)', () => {
  let rootDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'synth-backend-identities-'));
    backend = await createBackendApp({ dataDir: join(rootDir, 'data'), authDebug: true });
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    backend.stopWebhookService();
    backend.stopWebhookDeliveryPruner();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** Запрос к backend-app с Bearer-токеном. */
  const req = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    backend.app.request(path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  it('POST /me/identities/claim → 201 и привязка к профилю, найденному по username', async () => {
    // Профиль debug-пользователя (idempotent — сид мог не успеть/уже быть).
    const profiles = new FileProfileStore({ dataDir: backend.dataDir });
    const profile = await profiles.getOrCreateProfile({ username: 'developer' });
    // Инвариант сценария: id профиля не совпадает с user.id аутентификации.
    expect(profile.id).not.toBe('developer');

    // Claim-код выдан ingest'ом и живёт в общем файле данных backend.
    const claims = new IdentityClaimStore({ dataDir: backend.dataDir });
    const claim = await claims.create({
      provider: 'tg',
      externalId: '450316139',
      principalId: 'tg:450316139',
    });

    const res = await req(
      '/api/v2/me/identities/claim',
      jsonInit('POST', { code: claim.code }),
      USER_KEY,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      identity: { provider: string; externalId: string; linkedBy?: string };
    };
    expect(body.identity).toMatchObject({ provider: 'tg', externalId: '450316139' });
    expect(body.identity.linkedBy).toBe(profile.id);

    // Идентичность привязана именно к профилю (а не к «пользователю» по user.id).
    const updated = await new FileProfileStore({ dataDir: backend.dataDir }).loadProfile(profile.id);
    expect(updated?.identities?.[0]).toMatchObject({ provider: 'tg', externalId: '450316139' });

    // Список идентичностей того же пользователя отдаёт привязку.
    const list = await req('/api/v2/me/identities', {}, USER_KEY);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { identities: Array<{ provider: string; externalId: string }> };
    expect(listed.identities).toContainEqual(
      expect.objectContaining({ provider: 'tg', externalId: '450316139' }),
    );
  });

  it('POST /me/identities/claim — неаутентифицированный → 401 UNAUTHORIZED', async () => {
    const claims = new IdentityClaimStore({ dataDir: backend.dataDir });
    const claim = await claims.create({
      provider: 'tg',
      externalId: '1',
      principalId: 'tg:1',
    });
    const res = await req('/api/v2/me/identities/claim', jsonInit('POST', { code: claim.code }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('POST /me/identities/claim — превышение лимита попыток → 429 RATE_LIMITED', async () => {
    // Отдельный токен (lead-key-789) — свой rate-limit-ключ, не пересекается с
    // предыдущими тестами. Лимит route — 10 запросов / 60 c.
    const token = 'lead-key-789';
    const send = (): Promise<Response> =>
      req('/api/v2/me/identities/claim', jsonInit('POST', { code: 'ZZZ-ZZZ' }), token);

    // В пределах лимита запрос обрабатывается (неизвестный код → 404, не 429).
    const first = await send();
    expect(first.status).toBe(404);
    for (let i = 1; i < 10; i++) {
      expect((await send()).status).toBe(404);
    }

    // 11-й запрос в окне — превышение лимита.
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });
});
