/**
 * PROP-090 §5: тесты раскладки слоя плагинов на диске и карантина.
 *
 * Проверяется:
 * - приоритет корня раскладки (явный home > `SYNTH_HOME` > `{dataDir}/plugin`);
 * - `stagePluginBundle`: при `allow` бандл попадает в `installed/<name>@<version>/`
 *   (+ `PLUGIN_INTEGRITY.json`), при `ask`/`block` — остаётся в `quarantine/`
 *   и в `installed/` **не** попадает;
 * - `releaseFromQuarantine` переносит бандл после подтверждения.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensurePluginLayout,
  pluginInstalledDir,
  pluginQuarantineDir,
  releaseFromQuarantine,
  resolvePluginLayout,
  stagePluginBundle,
} from './layout.js';

describe('resolvePluginLayout: приоритет корня', () => {
  it('без home → `{dataDir}/plugin`', () => {
    const layout = resolvePluginLayout({ dataDir: '/var/synth/data', env: {} });
    expect(layout.root).toBe('/var/synth/data/plugin');
    expect(layout.installedDir).toBe('/var/synth/data/plugin/installed');
    expect(layout.quarantineDir).toBe('/var/synth/data/plugin/quarantine');
    expect(layout.lockPath).toBe('/var/synth/data/plugin/plugins.lock.json');
    expect(layout.settingsPath).toBe('/var/synth/data/plugin/plugins.json');
  });

  it('env `SYNTH_HOME` → `<home>/plugin`', () => {
    const layout = resolvePluginLayout({
      dataDir: '/var/synth/data',
      env: { SYNTH_HOME: '/home/user/.local/share/synth' },
    });
    expect(layout.root).toBe('/home/user/.local/share/synth/plugin');
  });

  it('явный home приоритетнее env `SYNTH_HOME`', () => {
    const layout = resolvePluginLayout({
      home: '/home/user/explicit',
      dataDir: '/var/synth/data',
      env: { SYNTH_HOME: '/home/user/from-env' },
    });
    expect(layout.root).toBe('/home/user/explicit/plugin');
  });
});

describe('раскладка бандла и карантин', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-plugin-layout-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Раскладка без home — под тестовым dataDir. */
  function layout() {
    return resolvePluginLayout({ dataDir, env: {} });
  }

  /** Файлы демо-бандла. */
  function files() {
    return {
      'synth.pack': '{"name":"demo-plugin","version":"1.0.0","kind":"plugin"}',
      'dist/index.js': 'console.log(1);',
    };
  }

  it('ensurePluginLayout создаёт `installed/` и `quarantine/`', async () => {
    const l = layout();
    await ensurePluginLayout(l);
    expect(existsSync(l.installedDir)).toBe(true);
    expect(existsSync(l.quarantineDir)).toBe(true);
  });

  it('allow → бандл в `installed/<name>@<version>/` + PLUGIN_INTEGRITY.json', async () => {
    const l = layout();
    const result = await stagePluginBundle(l, {
      name: 'demo-plugin',
      version: '1.0.0',
      files: files(),
      action: 'allow',
      source: 'npm',
    });

    expect(result.installed).toBe(true);
    expect(result.dir).toBe(pluginInstalledDir(l, 'demo-plugin', '1.0.0'));
    expect(existsSync(join(result.dir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(result.dir, 'synth.pack'))).toBe(true);

    const integrity = JSON.parse(
      await readFile(join(result.dir, 'PLUGIN_INTEGRITY.json'), 'utf-8'),
    ) as { sha256: string; source?: string; fetched_at: string };
    expect(integrity.sha256).toBe(result.contentHash);
    expect(integrity.source).toBe('npm');
    expect(typeof integrity.fetched_at).toBe('string');
  });

  it('ask → бандл остаётся в карантине, в `installed/` не попадает', async () => {
    const l = layout();
    const result = await stagePluginBundle(l, {
      name: 'demo-plugin',
      version: '1.0.0',
      files: files(),
      action: 'ask',
    });

    expect(result.installed).toBe(false);
    expect(result.reason).toBe('approval_required');
    expect(result.dir).toBe(pluginQuarantineDir(l, 'demo-plugin', '1.0.0'));
    expect(existsSync(join(result.dir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(pluginInstalledDir(l, 'demo-plugin', '1.0.0'))).toBe(false);
  });

  it('block → бандл остаётся в карантине, в `installed/` не попадает', async () => {
    const l = layout();
    const result = await stagePluginBundle(l, {
      name: 'demo-plugin',
      version: '1.0.0',
      files: files(),
      action: 'block',
    });

    expect(result.installed).toBe(false);
    expect(result.reason).toBe('blocked');
    expect(existsSync(pluginInstalledDir(l, 'demo-plugin', '1.0.0'))).toBe(false);
  });

  it('releaseFromQuarantine переносит бандл в `installed/`', async () => {
    const l = layout();
    await stagePluginBundle(l, {
      name: 'demo-plugin',
      version: '1.0.0',
      files: files(),
      action: 'ask',
    });

    const installed = await releaseFromQuarantine(l, 'demo-plugin', '1.0.0');
    expect(installed).toBe(pluginInstalledDir(l, 'demo-plugin', '1.0.0'));
    expect(existsSync(join(installed, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(installed, 'PLUGIN_INTEGRITY.json'))).toBe(true);
    expect(existsSync(pluginQuarantineDir(l, 'demo-plugin', '1.0.0'))).toBe(false);
  });

  it('бинарные файлы (`binaryFiles` + `sourceDir`) копируются байт-в-байт', async () => {
    const l = layout();
    const source = join(dataDir, 'source-bundle');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe]);
    await mkdir(join(source, 'assets'), { recursive: true });
    await writeFile(join(source, 'assets', 'logo.png'), bytes);

    const result = await stagePluginBundle(l, {
      name: 'demo-plugin',
      version: '1.0.0',
      files: files(),
      binaryFiles: ['assets/logo.png'],
      sourceDir: source,
      action: 'allow',
    });

    expect(await readFile(join(result.dir, 'assets', 'logo.png'))).toEqual(bytes);
  });

  it('бинарный файл вне каталога бандла (`..`) → бросок, установка не создаётся', async () => {
    const l = layout();
    const source = join(dataDir, 'source-bundle');
    await mkdir(source, { recursive: true });

    await expect(
      stagePluginBundle(l, {
        name: 'demo-plugin',
        version: '1.0.0',
        files: files(),
        binaryFiles: ['../evil.bin'],
        sourceDir: source,
        action: 'allow',
      }),
    ).rejects.toThrow(/Недопустимый путь файла бандла/);
  });

  it('повторная раскладка вытесняет предыдущий каталог', async () => {
    const l = layout();
    await stagePluginBundle(l, {
      name: 'demo-plugin',
      version: '1.0.0',
      files: { 'a.js': '1' },
      action: 'allow',
    });
    await stagePluginBundle(l, {
      name: 'demo-plugin',
      version: '1.0.0',
      files: { 'b.js': '2' },
      action: 'allow',
    });

    const dir = pluginInstalledDir(l, 'demo-plugin', '1.0.0');
    expect(existsSync(join(dir, 'a.js'))).toBe(false);
    expect(existsSync(join(dir, 'b.js'))).toBe(true);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
});
