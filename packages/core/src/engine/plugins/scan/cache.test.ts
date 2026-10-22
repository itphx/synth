/**
 * PROP-068 §4.3: тесты кэша сканов.
 *
 * Ключ кэша — `sha256(source\0source_url\0content_hash)`: повторный скан
 * идентичного содержимого не пересчитывается, другое содержимое — пересчитывается.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { PluginScanCache } from './cache.js';
import { scanPluginFiles } from './scanner.js';

describe('PluginScanCache.key', () => {
  it('ключ — sha256 от `source\\0sourceUrl\\0contentHash`', () => {
    const expected = createHash('sha256')
      .update('npm\0https://example.test/pkg\0abc', 'utf8')
      .digest('hex');
    expect(PluginScanCache.key('npm', 'https://example.test/pkg', 'abc')).toBe(expected);
  });

  it('разные источник/URL/хеш дают разные ключи', () => {
    const base = PluginScanCache.key('npm', 'url', 'hash');
    expect(PluginScanCache.key('local', 'url', 'hash')).not.toBe(base);
    expect(PluginScanCache.key('npm', 'other', 'hash')).not.toBe(base);
    expect(PluginScanCache.key('npm', 'url', 'other')).not.toBe(base);
  });

  it('разделитель не даёт коллизий между разбивками', () => {
    expect(PluginScanCache.key('a', 'b', 'c')).not.toBe(PluginScanCache.key('a\0b', '', 'c'));
  });
});

describe('PluginScanCache: повторный скан', () => {
  it('идентичное содержимое не пересчитывается', () => {
    const cache = new PluginScanCache();
    const files = { 'a.js': 'const a = 1;' };

    const first = scanPluginFiles(files, { cache, source: 'npm', sourceUrl: 'pkg' });
    expect(first.cached).toBeUndefined();

    const second = scanPluginFiles(files, { cache, source: 'npm', sourceUrl: 'pkg' });
    expect(second.cached).toBe(true);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.verdict).toBe(first.verdict);
    expect(second.findings).toEqual(first.findings);
  });

  it('другое содержимое → пересчёт', () => {
    const cache = new PluginScanCache();
    const first = scanPluginFiles({ 'a.js': 'const a = 1;' }, { cache, source: 'npm' });
    const second = scanPluginFiles({ 'a.js': 'const a = 2;' }, { cache, source: 'npm' });
    expect(second.cached).toBeUndefined();
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it('другой источник → пересчёт (ключ включает источник)', () => {
    const cache = new PluginScanCache();
    const files = { 'a.js': 'const a = 1;' };
    scanPluginFiles(files, { cache, source: 'npm', sourceUrl: 'pkg' });
    const other = scanPluginFiles(files, { cache, source: 'local', sourceUrl: 'pkg' });
    expect(other.cached).toBeUndefined();
  });

  it('одинаковое содержимое с разным URL источника → пересчёт', () => {
    const cache = new PluginScanCache();
    const files = { 'a.js': 'const a = 1;' };
    scanPluginFiles(files, { cache, source: 'npm', sourceUrl: 'pkg-a' });
    const other = scanPluginFiles(files, { cache, source: 'npm', sourceUrl: 'pkg-b' });
    expect(other.cached).toBeUndefined();
  });
});

describe('PluginScanCache: ёмкость', () => {
  it('лишние записи вытесняются (FIFO)', () => {
    const cache = new PluginScanCache(2);
    cache.set('a', { verdict: 'safe', findings: [], contentHash: 'a', scannedFiles: 0, performed: true });
    cache.set('b', { verdict: 'safe', findings: [], contentHash: 'b', scannedFiles: 0, performed: true });
    cache.set('c', { verdict: 'safe', findings: [], contentHash: 'c', scannedFiles: 0, performed: true });

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('очистка сбрасывает кэш', () => {
    const cache = new PluginScanCache();
    cache.set('a', { verdict: 'safe', findings: [], contentHash: 'a', scannedFiles: 0, performed: true });
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });
});
