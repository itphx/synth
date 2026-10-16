// ADR-092: тесты `synth uninstall` — сохранение данных по умолчанию, защита
// необратимого удаления (`--purge` требует `--yes`), dry-run и локальный home.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryMaintenanceAuditRepository } from '../storage/memory/index.js';
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

  it('--purge --yes пишет uninstall.purge до удаления (ADR-092)', async () => {
    const audit = new MemoryMaintenanceAuditRepository();
    const logs: string[] = [];

    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      yes: true,
      audit,
      log: (m) => logs.push(m),
    });

    expect(code).toBe(0);
    expect(await exists(dataDir)).toBe(false);
    const list = await audit.list();
    expect(list).toHaveLength(1);
    const e = list[0]!;
    expect(e.op).toBe('uninstall.purge');
    expect(e.status).toBe('ok');
    expect(e.actor).toBe('cli');
    expect(e.details).toMatchObject({ dataDir, sessions: 2, projects: 1 });
    expect(typeof e.details?.sizeBytes).toBe('number');

    // Вывод явно предупреждает, что запись удаляется вместе с каталогом.
    const out = logs.join('\n');
    expect(out).toContain('uninstall.purge');
    expect(out).toContain('внешний audit-sink');
  });

  it('--purge без --yes не пишет событие', async () => {
    const audit = new MemoryMaintenanceAuditRepository();
    const code = await runUninstallCommand({ dataDir, purge: true, audit, log: () => {}, error: () => {} });

    expect(code).toBe(1);
    expect(await audit.list()).toEqual([]);
  });
});

// PROP-032: `synth uninstall` при `storage.backend=postgres` по умолчанию не
// трогает данные БД — схема удаляется только явным `--purge-db`.
describe('runUninstallCommand — backend=postgres (PROP-032)', () => {
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
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-uninstall-pg-'));
    dataDir = join(tmpDir, 'data');
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    await writeFile(join(dataDir, 'sessions', 's1.json'), '{"id":"s1"}', 'utf-8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('--purge --yes без --purge-db: файловый периметр удалён, схема БД не тронута', async () => {
    let purgeCalls = 0;
    const logs: string[] = [];

    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      yes: true,
      storageBackend: 'postgres',
      purgeSchema: async () => {
        purgeCalls += 1;
      },
      log: (m) => logs.push(m),
    });

    expect(code).toBe(0);
    expect(purgeCalls).toBe(0);
    expect(await exists(dataDir)).toBe(false);
    const out = logs.join('\n');
    expect(out).toContain('backend: postgres');
    expect(out).toContain('НЕ удаляются');
    expect(out).toContain('--purge-db');
  });

  it('--purge --yes --purge-db: схема БД удаляется (purgeSchema вызван)', async () => {
    let purgeCalls = 0;
    const logs: string[] = [];

    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      yes: true,
      purgeDb: true,
      storageBackend: 'postgres',
      purgeSchema: async () => {
        purgeCalls += 1;
      },
      log: (m) => logs.push(m),
    });

    expect(code).toBe(0);
    expect(purgeCalls).toBe(1);
    expect(await exists(dataDir)).toBe(false);
    expect(logs.join('\n')).toContain('Схема БД удалена');
  });

  it('--purge-db без --purge: отказ, схема и каталог не тронуты', async () => {
    let purgeCalls = 0;
    const errors: string[] = [];

    const code = await runUninstallCommand({
      dataDir,
      purgeDb: true,
      storageBackend: 'postgres',
      purgeSchema: async () => {
        purgeCalls += 1;
      },
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(code).toBe(1);
    expect(purgeCalls).toBe(0);
    expect(await exists(dataDir)).toBe(true);
    expect(errors.join('\n')).toContain('--purge');
  });

  it('--purge-db без шва purgeSchema: понятная ошибка, каталог не удалён', async () => {
    const errors: string[] = [];

    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      yes: true,
      purgeDb: true,
      storageBackend: 'postgres',
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('purgeSchema');
    expect(await exists(dataDir)).toBe(true);
  });

  it('ошибка удаления схемы БД: каталог данных не трогается', async () => {
    const errors: string[] = [];

    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      yes: true,
      purgeDb: true,
      storageBackend: 'postgres',
      purgeSchema: async () => {
        throw new Error('drop failed');
      },
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('drop failed');
    expect(await exists(dataDir)).toBe(true);
  });

  it('--purge-db при backend≠postgres: ошибка, каталог цел (fail-closed)', async () => {
    const errors: string[] = [];
    const logs: string[] = [];

    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      yes: true,
      purgeDb: true,
      storageBackend: 'file',
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
    });

    // Fail-closed: явная ошибка вместо молчаливого no-op.
    expect(code).toBe(1);
    const err = errors.join('\n');
    expect(err).toContain('--purge-db');
    expect(err).toContain('postgres');
    // Каталог данных не тронут — удаление не начиналось.
    expect(await exists(dataDir)).toBe(true);
    expect(await exists(join(dataDir, 'sessions', 's1.json'))).toBe(true);
  });

  it('--dry-run --purge --purge-db: план о схеме, ничего не удалено', async () => {
    let purgeCalls = 0;
    const logs: string[] = [];

    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      purgeDb: true,
      dryRun: true,
      storageBackend: 'postgres',
      purgeSchema: async () => {
        purgeCalls += 1;
      },
      log: (m) => logs.push(m),
    });

    expect(code).toBe(0);
    expect(purgeCalls).toBe(0);
    expect(await exists(dataDir)).toBe(true);
    const out = logs.join('\n');
    expect(out).toContain('DROP SCHEMA');
    expect(out).toContain('[dry-run]');
  });

  it('--purge --yes пишет backend/purgeDb в аудит-запись uninstall.purge — ADR-092', async () => {
    const audit = new MemoryMaintenanceAuditRepository();

    const code = await runUninstallCommand({
      dataDir,
      purge: true,
      yes: true,
      purgeDb: true,
      storageBackend: 'postgres',
      purgeSchema: async () => {},
      audit,
      log: () => {},
    });

    expect(code).toBe(0);
    const list = await audit.list();
    expect(list[0]!.details).toMatchObject({ backend: 'postgres', purgeDb: true });
  });
});
