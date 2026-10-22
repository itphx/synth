import { describe, expect, it } from 'vitest';
import type { PluginLockEntry } from '@itphx/synth-shared';
import type { PluginLockRepository } from '../ports/index.js';

/** Запись lock-файла для контрактного прогона. */
function entry(name: string, overrides: Partial<PluginLockEntry> = {}): PluginLockEntry {
  return {
    name,
    version: '1.0.0',
    source: 'npm',
    identifier: `@demo/${name}`,
    trust_level: 'trusted',
    scan_verdict: 'safe',
    content_hash: 'a'.repeat(64),
    ref: 'sha256:deadbeef',
    entry: 'dist/index.js',
    installed_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Паспорт порта `PluginLockRepository` (PROP-068 §4.4 / PROP-090 §5, ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - upsert по имени плагина (`installed_at` сохраняется, `updated_at` обновляется);
 * - чтение (`null` для неизвестного), список (детерминированный порядок — по имени);
 * - снятие записи (`true`/`false`);
 * - провенанс (источник, pin `ref`, `content_hash`, доверие, вердикт скана)
 *   сохраняется без потерь.
 */
export function describePluginLockRepository(
  name: string,
  make: () => Promise<{ repo: PluginLockRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустой lock — []; save → get возвращает запись', async () => {
      const { repo } = await make();
      expect(await repo.list()).toEqual([]);
      expect(await repo.get('demo-plugin')).toBeNull();

      await repo.save(entry('demo-plugin'));
      const stored = await repo.get('demo-plugin');
      expect(stored?.version).toBe('1.0.0');
      expect(stored?.source).toBe('npm');
      expect(stored?.trust_level).toBe('trusted');
      expect(stored?.scan_verdict).toBe('safe');
      expect(stored?.content_hash).toBe('a'.repeat(64));
      expect(stored?.installed_at).toBe('2026-01-01T00:00:00.000Z');
    });

    it('upsert по имени: запись обновляется, installed_at сохраняется', async () => {
      const { repo } = await make();
      await repo.save(entry('demo-plugin'));

      await repo.save(
        entry('demo-plugin', {
          version: '2.0.0',
          scan_verdict: 'caution',
          content_hash: 'b'.repeat(64),
          installed_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        }),
      );

      const updated = await repo.get('demo-plugin');
      expect(updated?.version).toBe('2.0.0');
      expect(updated?.scan_verdict).toBe('caution');
      expect(updated?.content_hash).toBe('b'.repeat(64));
      expect(updated?.installed_at).toBe('2026-01-01T00:00:00.000Z');
      expect(updated?.updated_at).toBe('2026-06-01T00:00:00.000Z');

      // Upsert не плодит дубликаты.
      expect((await repo.list()).filter((e) => e.name === 'demo-plugin')).toHaveLength(1);
    });

    it('список детерминирован (по имени)', async () => {
      const { repo } = await make();
      await repo.save(entry('zeta-plugin'));
      await repo.save(entry('alpha-plugin'));
      await repo.save(entry('mid-plugin'));

      expect((await repo.list()).map((e) => e.name)).toEqual([
        'alpha-plugin',
        'mid-plugin',
        'zeta-plugin',
      ]);
    });

    it('снятие записи: true для существующей, false для неизвестной', async () => {
      const { repo } = await make();
      await repo.save(entry('temp-plugin'));

      expect(await repo.delete('temp-plugin')).toBe(true);
      expect(await repo.get('temp-plugin')).toBeNull();
      expect(await repo.delete('temp-plugin')).toBe(false);
      expect(await repo.list()).toEqual([]);
    });

    it('провенанс сохраняется без потерь (source/ref/identifier/entry)', async () => {
      const { repo } = await make();
      await repo.save(
        entry('pinned-plugin', {
          source: 'catalog',
          identifier: 'itphx/synth-media',
          ref: 'v1.2.3',
          entry: 'dist/main.js',
          trust_level: 'verified',
          scan_verdict: 'caution',
        }),
      );
      const stored = await repo.get('pinned-plugin');
      expect(stored?.source).toBe('catalog');
      expect(stored?.identifier).toBe('itphx/synth-media');
      expect(stored?.ref).toBe('v1.2.3');
      expect(stored?.entry).toBe('dist/main.js');
      expect(stored?.trust_level).toBe('verified');
      expect(stored?.scan_verdict).toBe('caution');
    });

    it('необязательные поля (identifier/ref/entry) могут отсутствовать', async () => {
      const { repo } = await make();
      await repo.save({
        name: 'local-plugin',
        version: '0.1.0',
        source: 'local',
        trust_level: 'community',
        scan_verdict: 'safe',
        content_hash: 'c'.repeat(64),
        installed_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
      const stored = await repo.get('local-plugin');
      expect(stored?.source).toBe('local');
      expect(stored?.identifier).toBeUndefined();
      expect(stored?.ref).toBeUndefined();
      expect(stored?.entry).toBeUndefined();
    });
  });
}
