import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IdentityClaimStore,
  IDENTITY_CLAIM_TTL_SEC,
  IDENTITY_CLAIMS_SCHEMA_VERSION,
} from './identity-claim-store.js';

describe('IdentityClaimStore (ADR-089 claim-flow)', () => {
  let dir: string;
  let store: IdentityClaimStore;

  const base = {
    provider: 'tg',
    externalId: '450316139',
    principalId: 'tg:450316139',
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-identity-claims-'));
    store = new IdentityClaimStore({ dataDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('create: генерирует код XXX-XXX, TTL 10 минут, провайдер/ид из входа', async () => {
    const claim = await store.create(base);

    expect(claim.code).toMatch(/^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/);
    // Без похожих символов 0/O/1/I.
    expect(claim.code).not.toMatch(/[0O1I]/);
    expect(claim.provider).toBe('tg');
    expect(claim.externalId).toBe('450316139');
    expect(claim.principalId).toBe('tg:450316139');
    const ttlMs = Date.parse(claim.expiresAt) - Date.parse(claim.createdAt);
    expect(ttlMs).toBe(IDENTITY_CLAIM_TTL_SEC * 1000);
    expect(claim.consumedAt).toBeUndefined();
  });

  it('create: ttlSec переопределяет срок', async () => {
    const claim = await store.create({ ...base, ttlSec: 30 });
    const ttlMs = Date.parse(claim.expiresAt) - Date.parse(claim.createdAt);
    expect(ttlMs).toBe(30_000);
  });

  it('create: chatKey сохраняется, если задан', async () => {
    const claim = await store.create({ ...base, chatKey: 'chat:telegram:1' });
    expect(claim.chatKey).toBe('chat:telegram:1');
  });

  it('create: коды уникальны (коллизии исключены)', async () => {
    const claims = await Promise.all(Array.from({ length: 20 }, () => store.create(base)));
    expect(new Set(claims.map((c) => c.code)).size).toBe(20);
  });

  it('consume: успех — помечает consumedAt, одноразово', async () => {
    const claim = await store.create(base);
    const consumed = await store.consume(claim.code, { userId: 'u1' });
    expect(consumed?.code).toBe(claim.code);
    expect(consumed?.consumedAt).toBeTruthy();

    // Повторно тот же код использовать нельзя.
    expect(await store.consume(claim.code, { userId: 'u1' })).toBeNull();
  });

  it('consume: регистр, дефисы и пробелы нормализуются', async () => {
    const claim = await store.create(base);
    const messy = ` ${claim.code.toLowerCase().replace('-', '')} `;
    expect(await store.consume(messy, { userId: 'u1' })).not.toBeNull();
  });

  it('consume: неизвестный код → null', async () => {
    expect(await store.consume('ZZZ-ZZZ', { userId: 'u1' })).toBeNull();
  });

  it('consume: пустой код → null', async () => {
    expect(await store.consume('   ', { userId: 'u1' })).toBeNull();
    expect(await store.consume('', { userId: 'u1' })).toBeNull();
  });

  it('consume: истёкший код → null', async () => {
    const expired = await store.create({ ...base, ttlSec: -1 });
    expect(await store.consume(expired.code, { userId: 'u1' })).toBeNull();
  });

  it('consume: не совпадает provider/externalId при заданных ожиданиях → null', async () => {
    const claim = await store.create(base);
    expect(
      await store.consume(claim.code, { userId: 'u1', provider: 'other' }),
    ).toBeNull();
    // Неудачная проверка не должна гасить код — владелец пары всё ещё может им воспользоваться.
    expect(await store.consume(claim.code, { userId: 'u1' })).not.toBeNull();
  });

  it('consume: совпадение provider/externalId → успех', async () => {
    const claim = await store.create(base);
    const res = await store.consume(claim.code, {
      userId: 'u1',
      provider: 'tg',
      externalId: '450316139',
    });
    expect(res?.code).toBe(claim.code);
  });

  it('list: возвращает все записи; activeOnly — только живые', async () => {
    const a = await store.create(base);
    const b = await store.create({ ...base, externalId: '2', principalId: 'tg:2' });
    await store.consume(a.code, { userId: 'u1' });

    expect(await store.list()).toHaveLength(2);
    const active = await store.list(true);
    expect(active.map((c) => c.code)).toEqual([b.code]);
  });

  it('cleanup: удаляет истёкшие и потреблённые старше retention', async () => {
    const live = await store.create({ ...base, ttlSec: 3600 });
    const expired = await store.create({ ...base, externalId: '2', principalId: 'tg:2', ttlSec: -1 });
    const consumed = await store.create({ ...base, externalId: '3', principalId: 'tg:3' });
    await store.consume(consumed.code, { userId: 'u1' });

    // Потреблённый код ещё в retention-окне (свежий) → остаётся.
    let removed = await store.cleanup();
    expect(removed).toBe(1); // только истёкший
    expect((await store.list()).map((c) => c.code).sort()).toEqual([live.code, consumed.code].sort());

    // Сдвигаем время вперёд — потреблённый уходит (живой ещё в TTL 3600 c).
    removed = await store.cleanup(Date.now() + IDENTITY_CLAIM_TTL_SEC * 1000 + 1000);
    expect(removed).toBe(1);
    expect((await store.list()).map((c) => c.code)).toEqual([live.code]);
    void expired;
  });

  it('персистит данные между инстансами', async () => {
    const claim = await store.create(base);
    const reloaded = new IdentityClaimStore({ dataDir: dir });
    expect((await reloaded.list()).map((c) => c.code)).toContain(claim.code);
  });

  it('пишет файл атомарно: нет .tmp-файлов, JSON валиден', async () => {
    await store.create(base);
    const files = await readdir(join(dir, 'events'));
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
    expect(files).toContain('identity-claims.json');
    const raw = JSON.parse(await readFile(join(dir, 'events', 'identity-claims.json'), 'utf-8'));
    expect(raw.schemaVersion).toBe(IDENTITY_CLAIMS_SCHEMA_VERSION);
    expect(raw.claims).toHaveLength(1);
  });

  it('параллельные create не теряют записи (per-file lock)', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      store.create({ ...base, externalId: String(i), principalId: `tg:${i}` }),
    ));
    expect(await store.list()).toHaveLength(10);
  });

  it('одновременный consume одного кода → ровно один успех (гонка сериализуется AsyncLock)', async () => {
    const claim = await store.create(base);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.consume(claim.code, { userId: 'u1' })),
    );

    const won = results.filter((r) => r !== null);
    expect(won).toHaveLength(1);
    expect(won[0]?.consumedAt).toBeTruthy();

    // После гонки код мёртв.
    expect(await store.consume(claim.code, { userId: 'u1' })).toBeNull();
  });
});
