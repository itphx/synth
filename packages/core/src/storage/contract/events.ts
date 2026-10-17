import { describe, expect, it } from 'vitest';
import type {
  DedupRepository,
  EventApiKeyRepository,
  EventBindingRepository,
  EventJournalRepository,
  EventRouteRepository,
  IdentityClaimRepository,
} from '../ports/index.js';
import type { EventBinding, EventRouteRule, SynthEvent } from '@itphx/synth-shared';

function binding(over: Partial<EventBinding> = {}): EventBinding {
  return { id: 'bnd-1', source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', ...over };
}

function routeRule(over: Partial<EventRouteRule> = {}): EventRouteRule {
  return {
    id: 'rule-1',
    priority: 1,
    enabled: true,
    match: { source: 'telegram' },
    target: { mode: 'ephemeral' },
    ...over,
  };
}

function synthEvent(id: string): SynthEvent {
  return {
    id,
    source: 'telegram',
    type: 'message',
    payload: {},
    identity: {},
    dedupKey: id,
    ts: new Date().toISOString(),
  };
}

/** Паспорт порта `EventBindingRepository`. */
export function describeEventBindingRepository(
  name: string,
  make: () => Promise<{ repo: EventBindingRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('upsert/get/list; remove отсутствующего — false', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('none')).toBeNull();
      expect(await repo.remove('none')).toBe(false);

      await repo.upsert(binding());
      expect((await repo.get('bnd-1'))?.source).toBe('telegram');
      expect(await repo.remove('bnd-1')).toBe(true);
      expect(await repo.list()).toEqual([]);
    });

    it('findByKey: threadKey приоритетнее chatKey', async () => {
      const { repo } = await make();
      await repo.upsert(binding({ id: 'by-chat', chatKey: 'c1', mode: 'bound' }));
      await repo.upsert(binding({ id: 'by-thread', chatKey: 'c1', threadKey: 't1', mode: 'bound' }));

      const byThread = await repo.findByKey({ source: 'telegram', chatKey: 'c1', threadKey: 't1' });
      expect(byThread?.id).toBe('by-thread');
      const byChat = await repo.findByKey({ source: 'telegram', chatKey: 'c1' });
      expect(byChat?.id).toBe('by-chat');
    });
  });
}

/** Паспорт порта `EventRouteRepository`. */
export function describeEventRouteRepository(
  name: string,
  make: () => Promise<{ repo: EventRouteRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('upsert/get/listEnabled/remove', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.remove('none')).toBe(false);

      await repo.upsert(routeRule({ id: 'r-on', enabled: true }));
      await repo.upsert(routeRule({ id: 'r-off', enabled: false }));
      expect((await repo.list()).map((r) => r.id).sort()).toEqual(['r-off', 'r-on']);
      expect((await repo.listEnabled()).map((r) => r.id)).toEqual(['r-on']);
      expect((await repo.get('r-on'))?.priority).toBe(1);
      expect(await repo.remove('r-on')).toBe(true);
    });
  });
}

/** Паспорт порта `EventJournalRepository`. */
export function describeEventJournalRepository(
  name: string,
  make: () => Promise<{ repo: EventJournalRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('record/list(limit); пустой журнал — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.record({ ts: new Date().toISOString(), event: synthEvent('e1') });
      await repo.record({ ts: new Date().toISOString(), event: synthEvent('e2') });
      expect((await repo.list()).map((e) => e.event.id)).toEqual(['e1', 'e2']);
      expect((await repo.list(1)).map((e) => e.event.id)).toEqual(['e2']);
    });
  });
}

/** Паспорт порта `EventApiKeyRepository`: уникальность label и резолв секрета. */
export function describeEventApiKeyRepository(
  name: string,
  make: () => Promise<{ repo: EventApiKeyRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('create/listByBinding/remove; неизвестный — null', async () => {
      const { repo } = await make();
      const created = await repo.create({ bindingId: 'b1', label: 'prod', createdBy: 'u1' });
      expect(created.key.startsWith('synth_evt_')).toBe(true);
      expect(created.label).toBe('prod');
      expect((await repo.listByBinding('b1')).map((k) => k.id)).toEqual([created.id]);
      expect((await repo.listByBinding('other'))).toEqual([]);
      expect(await repo.get('b1', created.id)).not.toBeNull();
      expect(await repo.get('b1', 'none')).toBeNull();
      expect(await repo.remove('b1', created.id)).toBe(true);
      expect(await repo.remove('b1', created.id)).toBe(false);
    });

    it('label уникальна (регистронезависимо) → ошибка', async () => {
      const { repo } = await make();
      await repo.create({ bindingId: 'b1', label: 'Prod', createdBy: 'u1' });
      await expect(repo.create({ bindingId: 'b2', label: 'prod', createdBy: 'u1' })).rejects.toThrow();
    });

    it('resolveBySecret резолвит корректный секрет и не резолвит отозванный', async () => {
      const { repo } = await make();
      const created = await repo.create({ bindingId: 'b1', label: 'k', createdBy: 'u1' });
      const resolved = await repo.resolveBySecret(created.key);
      expect(resolved?.key.id).toBe(created.id);
      expect(resolved?.credential.bindingId).toBe('b1');

      await repo.revoke('b1', created.id);
      expect(await repo.resolveBySecret(created.key)).toBeNull();
      expect(await repo.resolveBySecret('synth_evt_unknown')).toBeNull();
    });

    it('importExisting: id/prefix/hash/bindingId сохраняются, секрет резолвится, повтор не дублирует', async () => {
      const source = await make();
      const target = await make();
      const created = await source.repo.create({ bindingId: 'b1', label: 'legacy', createdBy: 'u1' });
      const records = await source.repo.exportAll();
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.hash).toMatch(/^[0-9a-f]{64}$/);

      const imported = await target.repo.importExisting(record);
      expect(imported.id).toBe(created.id);
      expect(imported.bindingId).toBe('b1');
      expect(imported.prefix).toBe(created.prefix);
      expect(imported.createdAt).toBe(created.createdAt);
      expect((await target.repo.exportAll())[0]?.hash).toBe(record.hash);

      // Ключ, выданный до переноса, продолжает работать (регрессия 401).
      const resolved = await target.repo.resolveBySecret(created.key);
      expect(resolved?.key.id).toBe(created.id);

      const again = await target.repo.importExisting(record);
      expect(again.id).toBe(created.id);
      expect(await target.repo.listByBinding('b1')).toHaveLength(1);
    });

    it('importExisting сохраняет revokedAt (импортированный ключ не резолвится)', async () => {
      const source = await make();
      const target = await make();
      const created = await source.repo.create({ bindingId: 'b1', label: 'revoked', createdBy: 'u1' });
      await source.repo.revoke('b1', created.id);
      const record = (await source.repo.exportAll())[0]!;

      const imported = await target.repo.importExisting(record);
      expect(imported.revokedAt).toBeDefined();
      expect(await target.repo.resolveBySecret(created.key)).toBeNull();
    });
  });
}

/** Паспорт порта `IdentityClaimRepository`: одноразовость кода. */
export function describeIdentityClaimRepository(
  name: string,
  make: () => Promise<{ repo: IdentityClaimRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('create/consume; повторный consume — null; cleanup', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      const claim = await repo.create({
        provider: 'tg',
        externalId: '42',
        principalId: 'tg:42',
      });
      expect(claim.code).toMatch(/^[A-Z0-9]{2,}-[A-Z0-9]+$/);

      const consumed = await repo.consume(claim.code, { userId: 'alice' });
      expect(consumed?.provider).toBe('tg');
      expect(await repo.consume(claim.code, { userId: 'alice' })).toBeNull();
      expect(await repo.consume('ZZ-ZZZZ', { userId: 'alice' })).toBeNull();
      expect(await repo.list(true)).toEqual([]);
    });
  });
}

/** Паспорт порта `DedupRepository`: атомарный claim одного ключа. */
export function describeDedupRepository(
  name: string,
  make: () => Promise<{ repo: DedupRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('tryClaim: true ровно один раз на ключ', async () => {
      const { repo } = await make();
      expect(await repo.tryClaim('k1')).toBe(true);
      expect(await repo.tryClaim('k1')).toBe(false);
      expect(await repo.tryClaim('k2')).toBe(true);
    });
  });
}
