/**
 * PROP-090 §9: тесты дефолтного seam'а скана (`createPluginScanHook`).
 *
 * Хук — точка расширения Ф2: по умолчанию он зовёт встроенный статический
 * сканер и отдаёт `PluginScanResult` (`performed: true`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginActivationDescriptor } from '../activation.js';
import { createPluginScanHook } from './hook.js';

/** Дескриптор без файлов и каталога — сканировать нечего. */
function descriptor(over: Partial<PluginActivationDescriptor> = {}): PluginActivationDescriptor {
  return {
    name: 'demo-plugin',
    version: '1.0.0',
    manifest: { name: 'demo-plugin', version: '1.0.0', kind: 'plugin', description: 'x' },
    ...over,
  } as PluginActivationDescriptor;
}

describe('createPluginScanHook: сканирование карты файлов', () => {
  it('вызывает сканер и возвращает performed: true', async () => {
    const hook = createPluginScanHook();
    const result = await hook(descriptor({ files: { 'a.js': 'const a = 1;' } }));

    expect(result.performed).toBe(true);
    expect(result.verdict).toBe('safe');
    expect(result.findings).toEqual([]);
    expect(result.contentHash).toBeTruthy();
    expect(result.scannedFiles).toBe(1);
  });

  it('опасный контент → вердикт dangerous', async () => {
    const hook = createPluginScanHook();
    const result = await hook(
      descriptor({ files: { 'a.js': "readFileSync('.env')" } }),
    );
    expect(result.verdict).toBe('dangerous');
    expect(result.findings?.length).toBeGreaterThan(0);
  });
});

describe('createPluginScanHook: сканирование каталога', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-scan-hook-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('обходит распакованный бандл', async () => {
    await writeFile(join(dir, 'a.js'), 'const a = 1;', 'utf-8');
    const hook = createPluginScanHook();
    const result = await hook(descriptor({ rootDir: dir }));

    expect(result.performed).toBe(true);
    expect(result.verdict).toBe('safe');
    expect(result.scannedFiles).toBe(1);
  });

  it('каталог имеет приоритет над картой файлов', async () => {
    await writeFile(join(dir, 'a.js'), 'const a = 1;', 'utf-8');
    const hook = createPluginScanHook();
    const result = await hook(
      descriptor({ rootDir: dir, files: { 'b.js': "readFileSync('.env')" } }),
    );
    expect(result.verdict).toBe('safe');
  });
});

describe('createPluginScanHook: краевые случаи', () => {
  it('сканировать нечего → performed: false, вердикт safe', async () => {
    const hook = createPluginScanHook();
    const result = await hook(descriptor());
    expect(result.performed).toBe(false);
    expect(result.verdict).toBe('safe');
    expect(result.findings).toEqual([]);
  });

  it('источник и URL берутся из дескриптора (часть ключа кэша)', async () => {
    const hook = createPluginScanHook();
    const result = await hook(
      descriptor({ files: { 'a.js': 'const a = 1;' }, source: 'npm', sourceUrl: 'pkg' }),
    );
    expect(result.performed).toBe(true);
  });

  it('общий кэш: повторный скан того же содержимого берётся из кэша', async () => {
    const hook = createPluginScanHook();
    const files = { 'a.js': 'const a = 1;' };
    const first = await hook(descriptor({ files }));
    const second = await hook(descriptor({ files }));
    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
  });
});
