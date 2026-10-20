import { describe, expect, it } from 'vitest';
import type { PackInstallation, PackRepository } from '../ports/index.js';

/** Установка пакета для контрактного прогона. */
function installation(
  name: string,
  overrides: Partial<PackInstallation> = {},
): PackInstallation {
  return {
    name,
    version: '1.0.0',
    kind: 'pack',
    packType: 'skills',
    description: 'контент-пак',
    status: 'active',
    requiresApproval: false,
    provides: { agents: [], skills: [], mcp: [], pipelines: [] },
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Паспорт порта `PackRepository` (ADR-086 §5, ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - upsert по имени пакета (`installedAt` сохраняется, `updatedAt` обновляется);
 * - чтение (`null` для неизвестного), список (детерминированный порядок — по имени);
 * - снятие установки (`true`/`false`);
 * - `manifest` сохраняется без изменений (в т.ч. вложенные объекты/массивы);
 * - смена `status` (в т.ч. `pending_approval` → `active`).
 */
export function describePackRepository(
  name: string,
  make: () => Promise<{ repo: PackRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('upsert по имени: запись обновляется, installedAt сохраняется', async () => {
      const { repo } = await make();
      expect(await repo.get('synth-media')).toBeNull();

      await repo.save(installation('synth-media'));
      const created = await repo.get('synth-media');
      expect(created?.version).toBe('1.0.0');
      expect(created?.kind).toBe('pack');
      expect(created?.packType).toBe('skills');
      expect(created?.status).toBe('active');
      expect(created?.requiresApproval).toBe(false);
      expect(created?.installedAt).toBe('2026-01-01T00:00:00.000Z');

      await repo.save(
        installation('synth-media', {
          version: '2.0.0',
          description: 'обновлён',
          installedAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      const updated = await repo.get('synth-media');
      expect(updated?.version).toBe('2.0.0');
      expect(updated?.description).toBe('обновлён');
      expect(updated?.installedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(updated?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');

      // Upsert не плодит дубликаты.
      expect((await repo.list()).filter((p) => p.name === 'synth-media')).toHaveLength(1);
    });

    it('список детерминирован (по имени), пустой реестр — []', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);

      await repo.save(installation('zeta-pack'));
      await repo.save(installation('alpha-pack'));
      await repo.save(installation('mid-pack'));

      expect((await repo.list()).map((p) => p.name)).toEqual(['alpha-pack', 'mid-pack', 'zeta-pack']);
    });

    it('снятие установки: true для существующей, false для неизвестной', async () => {
      const { repo } = await make();
      await repo.save(installation('temp-pack'));

      expect(await repo.delete('temp-pack')).toBe(true);
      expect(await repo.get('temp-pack')).toBeNull();
      expect(await repo.delete('temp-pack')).toBe(false);
      expect(await repo.list()).toEqual([]);
    });

    it('manifest сохраняется без изменений (вложенные объекты/массивы)', async () => {
      const { repo } = await make();
      const manifest = {
        name: 'synth-media',
        version: '1.0.0',
        kind: 'addon',
        description: 'медиа-надстройка',
        provides: {
          mcp: [{ name: 'telegram', transport: 'http', port: 8080 }],
          skills: [{ name: 'draft', path: 'skills/draft' }],
          agents: [],
          pipelines: [],
        },
        contracts: { apiV2: '^2' },
      };

      await repo.save(installation('synth-media', { kind: 'addon', manifest }));
      const stored = await repo.get('synth-media');
      expect(stored?.manifest).toEqual(manifest);
      expect(
        (stored?.manifest as { provides: { mcp: Array<{ name: string }> } }).provides.mcp[0]?.name,
      ).toBe('telegram');
    });

    it('смена статуса установки', async () => {
      const { repo } = await make();
      await repo.save(
        installation('pending-pack', { status: 'pending_approval', requiresApproval: true }),
      );
      expect((await repo.get('pending-pack'))?.status).toBe('pending_approval');
      expect((await repo.get('pending-pack'))?.requiresApproval).toBe(true);

      await repo.save(installation('pending-pack', { status: 'active' }));
      expect((await repo.get('pending-pack'))?.status).toBe('active');

      await repo.save(installation('pending-pack', { status: 'disabled' }));
      expect((await repo.get('pending-pack'))?.status).toBe('disabled');
    });

    it('provides: списки id установленных сущностей сохраняются', async () => {
      const { repo } = await make();
      await repo.save(
        installation('pack-with-provides', {
          provides: {
            agents: ['publisher'],
            skills: ['draft'],
            mcp: ['telegram'],
            pipelines: ['release-pipeline'],
          },
        }),
      );
      const stored = await repo.get('pack-with-provides');
      expect(stored?.provides.agents).toEqual(['publisher']);
      expect(stored?.provides.skills).toEqual(['draft']);
      expect(stored?.provides.mcp).toEqual(['telegram']);
      expect(stored?.provides.pipelines).toEqual(['release-pipeline']);
    });
  });
}
