// ADR-091, раздел «Проверка»: тесты `synth doctor` на временных каталогах.
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../storage/instance-meta.js';
import type { StorageHealth } from '../storage/storage-context.js';
import { renderDoctorResult, runDoctor, type DoctorCheck } from './doctor.js';

/** Валидный материал мастер-ключа (32 байта base64). */
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

describe('runDoctor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-doctor-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function byId(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
    return checks.find((c) => c.id === id);
  }

  it('пустой каталог: data-dir ok, schema warn, master-key ok, data-integrity с нулями, providers warn', async () => {
    const result = await runDoctor({ dataDir: tmpDir });

    expect(byId(result.checks, 'data-dir')?.status).toBe('ok');
    expect(byId(result.checks, 'schema')?.status).toBe('warn');
    expect(byId(result.checks, 'schema')?.hint).toContain('migrate');
    expect(byId(result.checks, 'master-key')?.status).toBe('ok');
    expect(byId(result.checks, 'data-integrity')?.status).toBe('ok');
    expect(byId(result.checks, 'data-integrity')?.detail).toContain('сессий: 0');
    expect(byId(result.checks, 'providers')?.status).toBe('warn');

    // warn не делает ok=false — fail-проверок нет.
    expect(result.checks.some((c) => c.status === 'fail')).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.dataDir).toBe(tmpDir);
    expect(result.version).toBeTruthy();
  });

  it('битый sessions/broken.json → data-integrity fail, ok=false', async () => {
    await mkdir(join(tmpDir, 'sessions'), { recursive: true });
    await writeFile(join(tmpDir, 'sessions', 'broken.json'), '{ not json', 'utf-8');

    const result = await runDoctor({ dataDir: tmpDir });

    const integrity = byId(result.checks, 'data-integrity');
    expect(integrity?.status).toBe('fail');
    expect(integrity?.detail).toContain('broken');
    expect(result.ok).toBe(false);
  });

  it('secrets/master.key с правами 0644 → secrets-permissions warn', async () => {
    await mkdir(join(tmpDir, 'secrets'), { recursive: true, mode: 0o700 });
    const keyPath = join(tmpDir, 'secrets', 'master.key');
    await writeFile(keyPath, VALID_KEY, { encoding: 'utf-8', mode: 0o644 });
    // Явно выставляем права: umask может вмешаться при создании.
    await chmod(keyPath, 0o644);

    const result = await runDoctor({ dataDir: tmpDir });

    const perms = byId(result.checks, 'secrets-permissions');
    expect(perms?.status).toBe('warn');
    expect(perms?.detail).toContain('master.key');
    expect(byId(result.checks, 'master-key')?.status).toBe('ok');
  });

  it('ssh-keys без мастер-ключа → master-key fail', async () => {
    await mkdir(join(tmpDir, 'secrets', 'ssh-keys'), { recursive: true });
    await writeFile(join(tmpDir, 'secrets', 'ssh-keys', 'x.json'), '{}', 'utf-8');

    const result = await runDoctor({ dataDir: tmpDir });

    expect(byId(result.checks, 'master-key')?.status).toBe('fail');
    expect(result.ok).toBe(false);
  });

  it('meta.json со schemaVersion = SCHEMA_VERSION + 5 → schema fail', async () => {
    await writeFile(
      join(tmpDir, 'meta.json'),
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION + 5,
        instanceVersion: '999.0.0',
        migrations: [],
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const result = await runDoctor({ dataDir: tmpDir });

    expect(byId(result.checks, 'schema')?.status).toBe('fail');
    expect(byId(result.checks, 'schema')?.hint).toContain('Synth');
    expect(result.ok).toBe(false);
  });

  it('пробный файл .doctor-probe не остаётся после прогона', async () => {
    await runDoctor({ dataDir: tmpDir });

    const entries = await readdir(tmpDir);
    expect(entries).not.toContain('.doctor-probe');
  });

  it('renderDoctorResult({json:true}) → валидный JSON с checks', async () => {
    const result = await runDoctor({ dataDir: tmpDir });
    const json = renderDoctorResult(result, { json: true });
    const parsed = JSON.parse(json) as { checks: DoctorCheck[]; ok: boolean };

    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBe(result.checks.length);
    expect(typeof parsed.ok).toBe('boolean');
  });
});

// ADR-097: `storage.backend=postgres` — вместо файловых проверок идут проба
// соединения и версия схемы БД; файловые проверки помечаются `skipped`.
describe('runDoctor — backend=postgres (ADR-097)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-doctor-pg-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function byId(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
    return checks.find((c) => c.id === id);
  }

  /** Проба БД с заданными полями (дефолт — соединение есть, схема актуальна). */
  function health(overrides: Partial<StorageHealth> = {}): () => Promise<StorageHealth> {
    return async () => ({
      ok: true,
      latencyMs: 3,
      schemaVersion: 5,
      expectedSchemaVersion: 5,
      ...overrides,
    });
  }

  /** Файловые проверки, неприменимые при backend=postgres. */
  const SKIPPED_IDS = ['schema', 'data-integrity', 'providers', 'locks', 'version'];

  it('схема актуальна: db-connection/db-schema ok, файловые проверки skipped', async () => {
    const result = await runDoctor({
      dataDir: tmpDir,
      storageBackend: 'postgres',
      dbHealth: health(),
    });

    const connection = byId(result.checks, 'db-connection');
    expect(connection?.status).toBe('ok');
    expect(connection?.detail).toContain('соединение установлено');
    expect(connection?.detail).toContain('3 мс');

    const dbSchema = byId(result.checks, 'db-schema');
    expect(dbSchema?.status).toBe('ok');
    expect(dbSchema?.detail).toContain('схема 5 (ожидается 5)');

    for (const id of SKIPPED_IDS) {
      const check = byId(result.checks, id);
      expect(check?.status, `проверка ${id}`).toBe('skipped');
      expect(check?.detail, `проверка ${id}`).toContain('backend=postgres');
    }

    // Файловые проверки, остающиеся применимыми: каталог данных, ключ и права.
    expect(byId(result.checks, 'data-dir')?.status).toBe('ok');
    expect(byId(result.checks, 'master-key')?.status).toBe('ok');
    expect(byId(result.checks, 'secrets-permissions')?.status).toBe('ok');

    expect(result.checks.some((c) => c.status === 'fail')).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('нет соединения: db-connection fail, db-schema skipped (не вводим в заблуждение)', async () => {
    const result = await runDoctor({
      dataDir: tmpDir,
      storageBackend: 'postgres',
      dbHealth: health({ ok: false, error: 'connect ECONNREFUSED 127.0.0.1:5432' }),
    });

    const connection = byId(result.checks, 'db-connection');
    expect(connection?.status).toBe('fail');
    expect(connection?.detail).toContain('ECONNREFUSED');
    expect(connection?.hint).toContain('storage.postgres');

    const dbSchema = byId(result.checks, 'db-schema');
    expect(dbSchema?.status).toBe('skipped');
    expect(dbSchema?.detail).toContain('нет соединения');

    expect(result.ok).toBe(false);
  });

  it('исключение пробы БД → db-connection fail с текстом ошибки', async () => {
    const result = await runDoctor({
      dataDir: tmpDir,
      storageBackend: 'postgres',
      dbHealth: async () => {
        throw new Error('pool timeout');
      },
    });

    const connection = byId(result.checks, 'db-connection');
    expect(connection?.status).toBe('fail');
    expect(connection?.detail).toContain('pool timeout');
    expect(result.ok).toBe(false);
  });

  it('без шва пробы (dbHealth) db-connection fail с понятной причиной', async () => {
    const result = await runDoctor({ dataDir: tmpDir, storageBackend: 'postgres' });

    const connection = byId(result.checks, 'db-connection');
    expect(connection?.status).toBe('fail');
    expect(connection?.detail).toContain('не сконфигурирована');
  });

  it('схема БД новее драйвера → db-schema fail, ok=false', async () => {
    const result = await runDoctor({
      dataDir: tmpDir,
      storageBackend: 'postgres',
      dbHealth: health({ schemaVersion: 7, expectedSchemaVersion: 5 }),
    });

    const dbSchema = byId(result.checks, 'db-schema');
    expect(dbSchema?.status).toBe('fail');
    expect(dbSchema?.detail).toContain('схема 7 (ожидается 5)');
    expect(dbSchema?.hint).toContain('обновите Synth');
    expect(result.ok).toBe(false);
  });

  it('схема БД отстаёт → db-schema warn с подсказкой migrate (ok сохраняется)', async () => {
    const result = await runDoctor({
      dataDir: tmpDir,
      storageBackend: 'postgres',
      dbHealth: health({ schemaVersion: 2, expectedSchemaVersion: 5 }),
    });

    const dbSchema = byId(result.checks, 'db-schema');
    expect(dbSchema?.status).toBe('warn');
    expect(dbSchema?.hint).toBe('synth migrate');
    expect(result.ok).toBe(true);
  });

  it('схема БД не инициализирована → db-schema warn', async () => {
    const result = await runDoctor({
      dataDir: tmpDir,
      storageBackend: 'postgres',
      dbHealth: health({ schemaVersion: null }),
    });

    const dbSchema = byId(result.checks, 'db-schema');
    expect(dbSchema?.status).toBe('warn');
    expect(dbSchema?.detail).toContain('не инициализирована');
    expect(dbSchema?.hint).toBe('synth migrate');
  });

  it('проба БД выполняется один раз на прогон (db-connection и db-schema — один probe)', async () => {
    let calls = 0;
    const dbHealth = async (): Promise<StorageHealth> => {
      calls += 1;
      return { ok: true, schemaVersion: 5, expectedSchemaVersion: 5 };
    };

    await runDoctor({ dataDir: tmpDir, storageBackend: 'postgres', dbHealth });

    expect(calls).toBe(1);
  });

  it('renderDoctorResult: skipped-проверки печатаются символом «−» и попадают в сводку', async () => {
    const result = await runDoctor({
      dataDir: tmpDir,
      storageBackend: 'postgres',
      dbHealth: health(),
    });

    const text = renderDoctorResult(result);
    expect(text).toContain('− Схема данных');
    expect(text).toContain('неприменимо (backend=postgres)');
    expect(text).toContain('skipped: 5');
  });
});
