// ADR-092: тесты `synth uninstall` — сохранение данных по умолчанию, защита
// необратимого удаления (`--purge` требует `--yes`), dry-run и локальный home.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUninstallCommand } from './uninstall.js';

describe('runUninstallCommand (ADR-092)', () => {
  let tmpDir: string;
  let dataDir: string;

  const exists = async (p: string): Promise<boolean> => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-uninstall-'));
    dataDir = join(tmpDir, 'data');
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    await mkdir(join(dataDir, 'projects'), { recursive: true });
    await mkdir(join(dataDir, 'secrets'), { recursive: true, mode: 0o700 });
    await mkdir(join(dataDir, 'backups'), { recursive: true });
    await writeFile(join(dataDir, 'sessions', 's1.json'), '{"id":"s1"}', 'utf-8');
    await writeFile(join(dataDir, 'sessions', 's2.json'), '{"id":"s2"}', 'utf-8');
    await writeFile(join(dataDir, 'projects', 'p1.json'), '{"id":"p1"}', 'utf-8');
    await writeFile(join(dataDir, 'secrets', 'master.key'), 'KEY', { encoding: 'utf-8', mode: 0o600 });
    await writeFile(join(dataDir, 'backups', 'synth-pre-migrate-20260101-000000.tar.gz'), 'copy', 'utf-8');
    await writeFile(
      join(dataDir, 'meta.json'),
      JSON.stringify({ schemaVersion: 3, instanceVersion: '0.0.0', migrations: [], updatedAt: '' }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('без --purge: данные целы, печатается сводка и «данные не удалены»', async () => {
    const logs: string[] = [];
    const code = await runUninstallCommand({ dataDir, log: (m) => logs.push(m) });

    expect(code).toBe(0);
    expect(await exists(dataDir)).toBe(true);
    const out = logs.join('\n');
    expect(out).toContain('данные сохраняются');
    expect(out).toContain(dataDir);
    expect(out).toContain('сессий: 2');
    expect(out).toContain('проектов: 1');
    expect(out).toContain('secrets/: есть');
    expect(out).toContain('версия схемы: 3');
    expect(out).toContain('страховочных копий в backups/: 1');
    expect(out).toContain('Данные не удалены');
    expect(out).toContain('--purge');
  });

  it('--purge без --yes: код 1, каталог цел', async () => {
    const errors: string[] = [];
    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('--dry-run');
    expect(await exists(dataDir)).toBe(true);
  });

  it('--dry-run --purge: каталог цел, печатает план', async () => {
    const logs: string[] = [];
    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      dryRun: true,
      log: (m) => logs.push(m),
    });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('[dry-run]');
    expect(logs.join('\n')).toContain('Было бы удалено');
    expect(await exists(dataDir)).toBe(true);
  });

  it('--purge --yes: каталог удалён, предупреждения о master.key и backups', async () => {
    const logs: string[] = [];
    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      yes: true,
      log: (m) => logs.push(m),
    });

    expect(code).toBe(0);
    expect(await exists(dataDir)).toBe(false);
    const out = logs.join('\n');
    expect(out).toContain('master.key');
    expect(out).toContain('невосстановимы');
    expect(out).toContain('backups/');
    expect(out).toContain('Каталог данных удалён');
  });

  it('--home: перечисляет оставшиеся файлы, {home}/data удаляется только с --purge', async () => {
    const home = join(tmpDir, 'home');
    const homeData = join(home, 'data');
    await mkdir(join(homeData, 'sessions'), { recursive: true });
    await writeFile(join(homeData, 'sessions', 's.json'), '{"id":"s"}', 'utf-8');
    await writeFile(join(home, 'config.yaml'), 'core: {}', 'utf-8');
    await writeFile(join(home, 'profiles.json'), '[]', 'utf-8');
    // credentials.json намеренно отсутствует.

    // Без --purge: каталог данных {home}/data остаётся.
    const first = await runUninstallCommand({ dataDir: homeData, home, log: () => {} });
    expect(first).toBe(0);
    expect(await exists(homeData)).toBe(true);

    // С --purge --yes: {home}/data удаляется, файлы home перечисляются.
    const logs: string[] = [];
    const second = await runUninstallCommand({
      dataDir: homeData,
      home,
      purge: true,
      yes: true,
      log: (m) => logs.push(m),
    });
    expect(second).toBe(0);
    expect(await exists(homeData)).toBe(false);
    const out = logs.join('\n');
    expect(out).toContain(join(home, 'config.yaml'));
    expect(out).toContain(join(home, 'profiles.json'));
    expect(out).not.toContain('credentials.json');
    // Файлы home остались на диске.
    expect(await exists(join(home, 'config.yaml'))).toBe(true);
  });
});
