import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WEBHOOK_SECRET_PREFIX } from '@itphx/synth-shared';
import { WebhookStore, WebhookConflictError } from './webhook-store.js';

describe('WebhookStore (ADR-052, этап II)', () => {
  let store: WebhookStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-webhooks-'));
    store = new WebhookStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('create: whk_<uuid>, секрет whsec_, prefix, label/url/events', async () => {
    const created = await store.create(
      { label: 'billing', url: 'https://example.com/hooks', events: ['session.created'] },
      'u-1',
    );
    expect(created.id).toMatch(/^whk_/);
    expect(created.label).toBe('billing');
    expect(created.url).toBe('https://example.com/hooks');
    expect(created.events).toEqual(['session.created']);
    expect(created.enabled).toBe(true);
    expect(created.createdBy).toBe('u-1');
    expect(created.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(created.secretPrefix.endsWith('…')).toBe(true);
    expect(created.secret.startsWith(created.secretPrefix.slice(0, -1))).toBe(true);
  });

  it('signing-секрет шифруется at-rest (enc:v1:) и не отдаётся в list/get', async () => {
    const created = await store.create({ label: 'a', url: 'https://example.com/a' }, 'u-1');

    // Файл на диске: только зашифрованный секрет, plaintext отсутствует.
    const raw = await readFile(join(tmpDir, 'webhooks', 'subscriptions.json'), 'utf-8');
    expect(raw).toContain('enc:v1:');
    expect(raw).not.toContain(created.secret);
    expect(raw).not.toContain(created.secret.slice(WEBHOOK_SECRET_PREFIX.length));

    const list = await store.list();
    expect((list[0] as unknown as Record<string, unknown>).secret).toBeUndefined();
    const got = await store.get(created.id);
    expect((got as unknown as Record<string, unknown>).secret).toBeUndefined();

    // getSecret возвращает исходный plaintext.
    expect(await store.getSecret(created.id)).toBe(created.secret);
  });

  it('create: глобальная уникальность label (регистронезависимо); пустой label → исключение', async () => {
    await store.create({ label: 'Hooks', url: 'https://example.com/1' }, 'u-1');
    await expect(
      store.create({ label: '  hooks ', url: 'https://example.com/2' }, 'u-2'),
    ).rejects.toBeInstanceOf(WebhookConflictError);
    await expect(store.create({ label: '   ', url: 'https://example.com/3' }, 'u-1')).rejects.toThrow();
  });

  it('update: смена полей и сброс description/null; конфликт label; отсутствующий → null', async () => {
    const a = await store.create({ label: 'alpha', description: 'd', url: 'https://example.com/a' }, 'u-1');
    await store.create({ label: 'beta', url: 'https://example.com/b' }, 'u-1');

    const updated = await store.update(a.id, {
      label: 'Alpha 2',
      description: null,
      url: 'https://example.com/a2',
      events: ['session.*'],
    });
    expect(updated?.label).toBe('Alpha 2');
    expect(updated?.description).toBeUndefined();
    expect(updated?.url).toBe('https://example.com/a2');
    expect(updated?.events).toEqual(['session.*']);

    await expect(store.update(a.id, { label: 'BETA' })).rejects.toBeInstanceOf(WebhookConflictError);
    expect(await store.update('whk_missing', { label: 'x' })).toBeNull();
  });

  it('setEnabled: отключение проставляет disabledAt, включение — сбрасывает', async () => {
    const a = await store.create({ label: 'toggle', url: 'https://example.com/t' }, 'u-1');
    const off = await store.setEnabled(a.id, false);
    expect(off?.enabled).toBe(false);
    expect(typeof off?.disabledAt).toBe('string');
    const on = await store.setEnabled(a.id, true);
    expect(on?.enabled).toBe(true);
    expect(on?.disabledAt).toBeUndefined();
    expect(await store.setEnabled('whk_missing', false)).toBeNull();
  });

  it('regenerateSecret: новый секрет, старый больше не читается, метаданные сохранены', async () => {
    const a = await store.create({ label: 'rot', url: 'https://example.com/r' }, 'u-1');
    const rotated = await store.regenerateSecret(a.id);
    expect(rotated).not.toBeNull();
    expect(rotated!.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(rotated!.secret).not.toBe(a.secret);
    expect(await store.getSecret(a.id)).toBe(rotated!.secret);
    expect(await store.regenerateSecret('whk_missing')).toBeNull();
  });

  it('remove и touchDelivery', async () => {
    const a = await store.create({ label: 'r', url: 'https://example.com/r' }, 'u-1');
    await store.touchDelivery(a.id, 'failed');
    const after = await store.get(a.id);
    expect(after?.lastStatus).toBe('failed');
    expect(typeof after?.lastDeliveryAt).toBe('string');

    expect(await store.remove(a.id)).toBe(true);
    expect(await store.remove(a.id)).toBe(false);
    expect(await store.get(a.id)).toBeNull();
    expect(await store.getSecret(a.id)).toBeNull();
  });
});
