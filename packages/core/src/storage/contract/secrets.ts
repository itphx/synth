import { describe, expect, it } from 'vitest';
import type {
  SSHKeyRepository,
  ServiceKeyRepository,
  WebhookDeliveryRepository,
  WebhookRepository,
} from '../ports/index.js';
import type { WebhookDelivery } from '@itphx/synth-shared';

function delivery(id: string, subscriptionId: string): WebhookDelivery {
  return {
    id,
    subscriptionId,
    eventType: 'webhook.test',
    status: 'ok',
    attempts: 1,
    createdAt: new Date().toISOString(),
  };
}

/** Паспорт порта `ServiceKeyRepository`: уникальность label и резолв секрета. */
export function describeServiceKeyRepository(
  name: string,
  make: () => Promise<{ repo: ServiceKeyRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('create/list/get/remove; list пустого — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('none')).toBeNull();

      const created = await repo.create({ label: 'installer', scopes: ['events:ingest'] }, 'admin');
      expect(created.key.startsWith('synth_svc_')).toBe(true);
      expect((await repo.list()).map((k) => k.id)).toEqual([created.id]);
      expect(await repo.remove(created.id)).toBe(true);
      expect(await repo.remove(created.id)).toBe(false);
    });

    it('label уникальна (регистронезависимо) → ошибка; resolveBySecret и revoke', async () => {
      const { repo } = await make();
      const created = await repo.create({ label: 'Ki', scopes: [] }, 'admin');
      await expect(repo.create({ label: 'ki', scopes: [] }, 'admin')).rejects.toThrow();

      const resolved = await repo.resolveBySecret(created.key);
      expect(resolved?.credential.label).toBe('Ki');
      await repo.revoke(created.id);
      expect(await repo.resolveBySecret(created.key)).toBeNull();
    });

    it('importExisting: id/prefix/hash сохраняются, секрет резолвится, повтор не дублирует', async () => {
      const source = await make();
      const target = await make();
      const created = await source.repo.create(
        { label: 'legacy', scopes: ['events:read'] },
        'admin',
      );
      const records = await source.repo.exportAll();
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.hash).toMatch(/^[0-9a-f]{64}$/);

      const imported = await target.repo.importExisting(record);
      expect(imported.id).toBe(created.id);
      expect(imported.prefix).toBe(created.prefix);
      expect(imported.label).toBe('legacy');
      expect(imported.scopes).toEqual(['events:read']);
      expect(imported.createdBy).toBe('admin');
      expect(imported.createdAt).toBe(created.createdAt);
      expect((await target.repo.exportAll())[0]?.hash).toBe(record.hash);

      // Ключ, выданный до переноса, продолжает работать (регрессия 401).
      const resolved = await target.repo.resolveBySecret(created.key);
      expect(resolved?.key.id).toBe(created.id);

      // Повторный импорт — идемпотентно.
      const again = await target.repo.importExisting(record);
      expect(again.id).toBe(created.id);
      expect(await target.repo.list()).toHaveLength(1);
    });

    it('importExisting сохраняет revokedAt (импортированный ключ не резолвится)', async () => {
      const source = await make();
      const target = await make();
      const created = await source.repo.create({ label: 'revoked', scopes: [] }, 'admin');
      await source.repo.revoke(created.id);
      const record = (await source.repo.exportAll())[0]!;

      const imported = await target.repo.importExisting(record);
      expect(imported.revokedAt).toBeDefined();
      expect(await target.repo.resolveBySecret(created.key)).toBeNull();
    });
  });
}

/** Паспорт порта `SSHKeyRepository`: секстеты не отдаются, reveal только по запросу. */
export function describeSSHKeyRepository(
  name: string,
  make: () => Promise<{ repo: SSHKeyRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('create/get/list/delete; неизвестный — null/false; list пустого — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('none')).toBeNull();
      expect(await repo.delete('none')).toBe(false);

      const meta = await repo.create({ name: 'deploy', privateKey: 'PRIVATE' });
      expect(meta.name).toBe('deploy');
      expect((meta as Record<string, unknown>).privateKey).toBeUndefined();
      expect((await repo.list()).map((k) => k.id)).toEqual([meta.id]);

      const revealed = await repo.reveal(meta.id);
      expect(revealed?.privateKey).toBe('PRIVATE');

      expect(await repo.delete(meta.id)).toBe(true);
      expect(await repo.get(meta.id)).toBeNull();
    });

    it('уникальность имени (регистронезависимо) → ошибка', async () => {
      const { repo } = await make();
      await repo.create({ name: 'Key', privateKey: 'X' });
      await expect(repo.create({ name: 'key', privateKey: 'Y' })).rejects.toThrow();
    });
  });
}

/** Паспорт порта `WebhookRepository`: уникальность label, ротация секрета. */
export function describeWebhookRepository(
  name: string,
  make: () => Promise<{ repo: WebhookRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('create/get/list/setEnabled/remove; неизвестный — null/false; list пустого — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('none')).toBeNull();
      expect(await repo.remove('none')).toBe(false);

      const created = await repo.create(
        { label: 'hook', url: 'https://example.com/hook', events: ['event.*'] },
        'admin',
      );
      expect(created.secret.startsWith('whsec_')).toBe(true);
      expect(created.enabled).toBe(true);

      const disabled = await repo.setEnabled(created.id, false);
      expect(disabled?.enabled).toBe(false);
      expect(await repo.remove(created.id)).toBe(true);
    });

    it('label уникальна (регистронезависимо); regenerateSecret меняет секрет', async () => {
      const { repo } = await make();
      const created = await repo.create({ label: 'H', url: 'https://example.com/a' }, 'admin');
      await expect(
        repo.create({ label: 'h', url: 'https://example.com/b' }, 'admin'),
      ).rejects.toThrow();

      const rotated = await repo.regenerateSecret(created.id);
      expect(rotated?.secret).not.toBe(created.secret);
      expect(await repo.getSecret(created.id)).toBe(rotated?.secret);
    });
  });
}

/** Паспорт порта `WebhookDeliveryRepository`. */
export function describeWebhookDeliveryRepository(
  name: string,
  make: () => Promise<{ repo: WebhookDeliveryRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('record/list/listBySubscription(limit); пустой журнал — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.record(delivery('d1', 's1'));
      await repo.record(delivery('d2', 's1'));
      await repo.record(delivery('d3', 's2'));

      expect((await repo.list()).map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
      expect((await repo.listBySubscription('s1')).map((d) => d.id)).toEqual(['d1', 'd2']);
      expect((await repo.list(1)).map((d) => d.id)).toEqual(['d3']);
    });
  });
}
