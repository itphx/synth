// PROP-091, раздел «Проверка»: тесты `synth doctor` на временных каталогах.
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../storage/instance-meta.js';
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
