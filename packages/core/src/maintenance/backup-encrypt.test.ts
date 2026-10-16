// ADR-091 (остаток): тесты шифрования архива бэкапа (`--encrypt`) и расшифровки
// при восстановлении. Ключи — фиксированные тестовые (не боевые).
import { readFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import { MemoryMaintenanceAuditRepository } from '../storage/memory/index.js';
import { readFileFromTarGz } from './archive.js';
import { createBackup, runBackupCommand } from './backup.js';
import {
  BackupEncryptionError,
  decryptArchiveToFile,
  decodeBackupKey,
  encryptArchiveToFile,
  isEncryptedArchivePath,
  readEncryptedMeta,
  resolveBackupKey,
} from './backup-crypto.js';
import { restoreBackup, runRestoreCommand } from './restore.js';
import { isSafeBackupName, listBackups, validateRestoreArchive } from './service.js';

/** Тестовый ключ — 32 байта (не боевой). */
const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf-8');
const TEST_KEY_B64 = TEST_KEY.toString('base64');
const TEST_KEY_HEX = TEST_KEY.toString('hex');
/** Другой корректный ключ (для проверки несовпадения). */
const OTHER_KEY = Buffer.from('fedcba9876543210fedcba9876543210', 'utf-8');

describe('backup encryption (ADR-091)', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backup-enc-'));
    dataDir = join(tmpDir, 'data');
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    await mkdir(join(dataDir, 'projects'), { recursive: true });
    await mkdir(join(dataDir, 'secrets'), { recursive: true, mode: 0o700 });
    await mkdir(join(dataDir, 'workspaces', 'w1'), { recursive: true });
    await mkdir(join(dataDir, 'tmp'), { recursive: true });
    await mkdir(join(dataDir, 'backups'), { recursive: true });
    await writeFile(join(dataDir, 'sessions', 's1.json'), '{"id":"s1"}', 'utf-8');
    await writeFile(join(dataDir, 'projects', 'p1.json'), '{"id":"p1"}', 'utf-8');
    await writeFile(join(dataDir, 'secrets', 'master.key'), 'SECRET', 'utf-8');
    await writeFile(join(dataDir, 'workspaces', 'w1', 'f.txt'), 'ws', 'utf-8');
    await writeFile(join(dataDir, 'tmp', 'scratch'), 'tmp', 'utf-8');
    await writeFile(
      join(dataDir, 'meta.json'),
      JSON.stringify({ schemaVersion: 3, instanceVersion: '0.0.0', migrations: [], updatedAt: '' }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trip encrypt→decrypt: содержимое совпадает с исходным архивом', async () => {
    const plain = await createBackup({ dataDir, out: join(tmpDir, 'plain.tar.gz') });
    const encrypted = await createBackup({
      dataDir,
      out: join(tmpDir, 'enc.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
    });

    expect(encrypted.encrypted).toBe(true);
    expect(encrypted.path.endsWith('.tar.gz.enc')).toBe(true);
    expect(isEncryptedArchivePath(encrypted.path)).toBe(true);
    // Плейнтекст-архив удалён, остался только контейнер.
    await expect(stat(join(tmpDir, 'enc.tar.gz'))).rejects.toThrow();
    expect((await stat(encrypted.path)).mode & 0o777).toBe(0o600);

    const dec = join(tmpDir, 'dec.tar.gz');
    await decryptArchiveToFile(encrypted.path, dec, TEST_KEY);

    // Манифест расшифрованного архива идентичен исходному (записи + контрольная сумма).
    const decManifest = JSON.parse(
      (await readFileFromTarGz(dec, 'manifest.json'))!.toString('utf-8'),
    ) as { entries: unknown[]; contentChecksum: string };
    expect(decManifest.entries).toEqual(encrypted.manifest.entries);
    expect(decManifest.contentChecksum).toBe(encrypted.manifest.contentChecksum);
    expect(decManifest.contentChecksum).toBe(plain.manifest.contentChecksum);
    expect((await readFileFromTarGz(dec, 'sessions/s1.json'))?.toString('utf-8')).toBe('{"id":"s1"}');
  });

  it('неверный ключ → ошибка расшифровки; аудит пишет restore.failed', async () => {
    const encrypted = await createBackup({
      dataDir,
      out: join(tmpDir, 'enc.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
    });

    await expect(
      decryptArchiveToFile(encrypted.path, join(tmpDir, 'x.tar.gz'), OTHER_KEY),
    ).rejects.toThrow(/Неверный ключ или архив повреждён/);

    const audit = new MemoryMaintenanceAuditRepository();
    await expect(
      restoreBackup({
        archive: encrypted.path,
        dataDir: join(tmpDir, 'target'),
        encryptKey: OTHER_KEY,
        audit,
        actor: 'cli',
      }),
    ).rejects.toThrow(/Неверный ключ/);

    const entries = await audit.list();
    expect(entries.map((entry) => entry.op)).toEqual(['restore.failed']);
    expect(entries[0]!.error).toContain('Неверный ключ');
    // Данные в целевой каталог не попали (расшифровка не удалась).
    const targetEntries = await readdir(join(tmpDir, 'target')).catch(() => [] as string[]);
    expect(targetEntries.filter((name) => name !== 'tmp')).toEqual([]);
    // Частично расшифрованный плейнтекст удалён на ошибке (иначе — утечка
    // содержимого каталога данных в открытом виде).
    const tmpLeftovers = await readdir(join(tmpDir, 'target', 'tmp')).catch(() => [] as string[]);
    expect(tmpLeftovers).toEqual([]);
  });

  it('отсутствие ключа при --encrypt → exit 1, архив не создан, ключ не в выводе', async () => {
    const outDir = join(tmpDir, 'out');
    const errors: string[] = [];
    const code = await runBackupCommand({
      dataDir,
      out: outDir,
      encrypt: true,
      env: {},
      log: () => {},
      error: (msg) => errors.push(msg),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Не задан ключ шифрования');
    // Каталога/файлов архива нет.
    await expect(stat(outDir)).rejects.toThrow();
  });

  it('повреждённый шифротекст (подмена байта) → ошибка аутентификации', async () => {
    const encrypted = await createBackup({
      dataDir,
      out: join(tmpDir, 'enc.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
    });

    const raw = Buffer.from(await readFile(encrypted.path));
    // Подменяем байт в области шифротекста (не заголовок, не authTag).
    raw[raw.length - 20] = raw[raw.length - 20]! ^ 0xff;
    const corrupt = join(tmpDir, 'corrupt.tar.gz.enc');
    await writeFile(corrupt, raw);

    await expect(decryptArchiveToFile(corrupt, join(tmpDir, 'bad.tar.gz'), TEST_KEY)).rejects.toThrow(
      /Неверный ключ или архив повреждён/,
    );
  });

  it('restore `.enc` с повреждённым шифротекстом → временный плейнтекст не остаётся', async () => {
    const encrypted = await createBackup({
      dataDir,
      out: join(tmpDir, 'enc.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
    });

    const raw = Buffer.from(await readFile(encrypted.path));
    raw[raw.length - 20] = raw[raw.length - 20]! ^ 0xff;
    const corrupt = join(tmpDir, 'corrupt.tar.gz.enc');
    await writeFile(corrupt, raw);

    const target = join(tmpDir, 'corrupt-target');
    await expect(
      restoreBackup({ archive: corrupt, dataDir: target, encryptKey: TEST_KEY }),
    ).rejects.toThrow(/Неверный ключ или архив повреждён/);

    const leftovers = await readdir(join(target, 'tmp')).catch(() => [] as string[]);
    expect(leftovers).toEqual([]);
  });

  it('restore `.enc`: ошибка последующего шага (битый плейнтекст) → временный файл удалён', async () => {
    // Валидный контейнер, но «мусорный» плейнтекст: расшифровка проходит, а разбор
    // tar.gz падает — `finally` обязан убрать временный плейнтекст и здесь.
    const junk = join(tmpDir, 'junk.bin');
    await writeFile(junk, Buffer.alloc(4096, 0x7a));
    const encOut = join(tmpDir, 'junk.tar.gz.enc');
    await encryptArchiveToFile(junk, encOut, TEST_KEY);

    const target = join(tmpDir, 'junk-target');
    await expect(
      restoreBackup({ archive: encOut, dataDir: target, encryptKey: TEST_KEY }),
    ).rejects.toThrow();

    const leftovers = await readdir(join(target, 'tmp')).catch(() => [] as string[]);
    expect(leftovers).toEqual([]);
  });

  it('restore `.enc` (валидный ключ) → временный архив удалён, данные восстановлены', async () => {
    const src = join(tmpDir, 'ok-src');
    await mkdir(join(src, 'sessions'), { recursive: true });
    await writeFile(join(src, 'sessions', 's1.json'), '{"id":"s1"}', 'utf-8');
    await writeFile(
      join(src, 'meta.json'),
      JSON.stringify({ schemaVersion: 0, instanceVersion: '0.0.0', migrations: [], updatedAt: '' }),
      'utf-8',
    );
    const encrypted = await createBackup({
      dataDir: src,
      out: join(tmpDir, 'enc.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
    });

    const target = join(tmpDir, 'ok-target');
    const result = await restoreBackup({
      archive: encrypted.path,
      dataDir: target,
      encryptKey: TEST_KEY,
      safetyCopy: false,
    });
    expect(result.restored).toBeGreaterThan(0);
    expect(await readFile(join(target, 'sessions', 's1.json'), 'utf-8')).toBe('{"id":"s1"}');

    const leftovers = await readdir(join(target, 'tmp')).catch(() => [] as string[]);
    expect(leftovers.filter((f) => f.startsWith('restore-decrypt-'))).toEqual([]);
  });

  it('restore `.enc` --dry-run (валидный ключ) → временных файлов не остаётся', async () => {
    const src = join(tmpDir, 'dry-src');
    await mkdir(join(src, 'sessions'), { recursive: true });
    await writeFile(join(src, 'sessions', 's1.json'), '{"id":"s1"}', 'utf-8');
    await writeFile(
      join(src, 'meta.json'),
      JSON.stringify({ schemaVersion: 0, instanceVersion: '0.0.0', migrations: [], updatedAt: '' }),
      'utf-8',
    );
    const encrypted = await createBackup({
      dataDir: src,
      out: join(tmpDir, 'enc.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
    });

    const target = join(tmpDir, 'dry-target');
    const logs: string[] = [];
    await restoreBackup({
      archive: encrypted.path,
      dataDir: target,
      dryRun: true,
      encryptKey: TEST_KEY,
      log: (msg) => logs.push(msg),
    });

    // Никаких временных файлов; данные не распакованы (кроме созданного tmp/).
    const leftovers = await readdir(join(target, 'tmp')).catch(() => [] as string[]);
    expect(leftovers).toEqual([]);
    const targetEntries = await readdir(target).catch(() => [] as string[]);
    expect(targetEntries.filter((name) => name !== 'tmp')).toEqual([]);
    // Путь временного плейнтекста не утекает в вывод (логируется источник).
    expect(logs.join('\n')).not.toContain('restore-decrypt-');
    expect(logs.join('\n')).toContain(encrypted.path);
  });

  it('расшифрованный (временный) архив создаётся с правами 0600', async () => {
    const encrypted = await createBackup({
      dataDir,
      out: join(tmpDir, 'enc.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
    });

    const dec = join(tmpDir, 'mode.tar.gz');
    await decryptArchiveToFile(encrypted.path, dec, TEST_KEY);
    expect((await stat(dec)).mode & 0o777).toBe(0o600);
  });

  it('файл с неверным заголовком → понятная ошибка (не зашифрованный архив)', async () => {
    const notEnc = join(tmpDir, 'plain.tar.gz.enc');
    await writeFile(notEnc, Buffer.alloc(64, 0x41));
    await expect(decryptArchiveToFile(notEnc, join(tmpDir, 'y.tar.gz'), TEST_KEY)).rejects.toThrow(
      /не является зашифрованным архивом/,
    );
  });

  it('sidecar содержит только метаданные (без путей файлов и хешей)', async () => {
    const encrypted = await createBackup({
      dataDir,
      out: join(tmpDir, 'enc.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
      withSecrets: true,
      withWorkspace: true,
    });

    const sidecarPath = `${encrypted.path}.meta.json`;
    expect((await stat(sidecarPath)).mode & 0o777).toBe(0o600);
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf-8')) as Record<string, unknown>;

    expect(Object.keys(sidecar).sort()).toEqual(
      [
        'createdAt',
        'encrypted',
        'entries',
        'formatVersion',
        'instanceVersion',
        'schemaVersion',
        'tool',
        'withSecrets',
        'withWorkspace',
      ].sort(),
    );
    expect(sidecar.tool).toBe('synth-backup');
    expect(sidecar.encrypted).toBe(true);
    expect(sidecar.withSecrets).toBe(true);
    expect(sidecar.withWorkspace).toBe(true);
    expect(sidecar.entries).toBe(encrypted.manifest.entries.length);

    const serialized = JSON.stringify(sidecar);
    expect(serialized).not.toContain('sessions');
    expect(serialized).not.toContain('sha256');
    expect(serialized).not.toContain('path');
    expect(serialized).not.toContain('dataDir');
  });

  it('readEncryptedMeta: нет/битый sidecar → null', async () => {
    const encrypted = await createBackup({
      dataDir,
      out: join(tmpDir, 'enc.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
    });
    expect(await readEncryptedMeta(encrypted.path)).not.toBeNull();

    await writeFile(`${encrypted.path}.meta.json`, 'not-json', 'utf-8');
    expect(await readEncryptedMeta(encrypted.path)).toBeNull();

    await rm(`${encrypted.path}.meta.json`, { force: true });
    expect(await readEncryptedMeta(encrypted.path)).toBeNull();
  });

  it('listBackups видит `.enc` c encrypted:true и метаданными; без sidecar — metadataAvailable:false', async () => {
    const backupsDir = join(dataDir, 'backups');
    await mkdir(backupsDir, { recursive: true });
    const encrypted = await createBackup({
      dataDir,
      out: backupsDir,
      encrypt: true,
      encryptKey: TEST_KEY,
    });
    const name = basename(encrypted.path);

    const infos = await listBackups(dataDir);
    const info = infos.find((entry) => entry.name === name);
    expect(info).toBeTruthy();
    expect(info!.encrypted).toBe(true);
    expect(info!.metadataAvailable).toBe(true);
    expect(info!.entries).toBe(encrypted.manifest.entries.length);
    expect(info!.schemaVersion).toBe(3);

    // Sidecar удалён → запись остаётся с пометкой «метаданные недоступны».
    await rm(`${encrypted.path}.meta.json`, { force: true });
    const after = (await listBackups(dataDir)).find((entry) => entry.name === name);
    expect(after!.encrypted).toBe(true);
    expect(after!.metadataAvailable).toBe(false);
    expect(after!.entries).toBe(0);
  });

  it('validateRestoreArchive(`.enc`) → ok:false с понятной причиной', async () => {
    const backupsDir = join(dataDir, 'backups');
    await mkdir(backupsDir, { recursive: true });
    const encrypted = await createBackup({
      dataDir,
      out: backupsDir,
      encrypt: true,
      encryptKey: TEST_KEY,
    });

    const validation = await validateRestoreArchive({ dataDir, archive: encrypted.path });
    expect(validation.ok).toBe(false);
    expect(validation.problem).toContain('зашифрован');
    expect(validation.problem).toContain('CLI');
  });

  it('isSafeBackupName: `.tar.gz.enc` — да, sidecar `.enc.meta.json` — нет', () => {
    expect(isSafeBackupName('x.tar.gz')).toBe(true);
    expect(isSafeBackupName('x.tar.gz.enc')).toBe(true);
    expect(isSafeBackupName('x.tar.gz.enc.meta.json')).toBe(false);
    expect(isSafeBackupName('../x.tar.gz.enc')).toBe(false);
  });

  it('CLI end-to-end: backup --encrypt + restore <file>.enc (ключ через env)', async () => {
    const src = join(tmpDir, 'src');
    await mkdir(join(src, 'sessions'), { recursive: true });
    await writeFile(join(src, 'sessions', 's1.json'), '{"id":"s1"}', 'utf-8');
    await writeFile(
      join(src, 'meta.json'),
      JSON.stringify({ schemaVersion: 0, instanceVersion: '0.0.0', migrations: [], updatedAt: '' }),
      'utf-8',
    );
    const outDir = join(tmpDir, 'out');
    await mkdir(outDir, { recursive: true });

    const encCode = await runBackupCommand({
      dataDir: src,
      out: outDir,
      encrypt: true,
      env: { SYNTH_BACKUP_KEY: TEST_KEY_B64 },
      log: () => {},
      error: () => {},
    });
    expect(encCode).toBe(0);

    const files = await readdir(outDir);
    expect(files.some((f) => f.endsWith('.tar.gz.enc'))).toBe(true);
    expect(files.some((f) => f.endsWith('.enc.meta.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.tar.gz'))).toBe(false);
    const archive = join(outDir, files.find((f) => f.endsWith('.tar.gz.enc'))!);

    const target = join(tmpDir, 'target');
    const keyFile = join(tmpDir, 'key.b64');
    await writeFile(keyFile, TEST_KEY_B64, 'utf-8');
    const dryErrors: string[] = [];
    const dry = await runRestoreCommand({
      archive,
      dataDir: target,
      dryRun: true,
      env: { SYNTH_BACKUP_KEY_FILE: keyFile },
      log: () => {},
      error: (msg) => dryErrors.push(msg),
    });
    expect(dry, dryErrors.join('\n')).toBe(0);

    const applied = await runRestoreCommand({
      archive,
      dataDir: target,
      yes: true,
      noSafetyCopy: true,
      env: { SYNTH_BACKUP_KEY: TEST_KEY_HEX },
      log: () => {},
      error: () => {},
    });
    expect(applied).toBe(0);
    expect(await readFile(join(target, 'sessions', 's1.json'), 'utf-8')).toBe('{"id":"s1"}');

    // Временный расшифрованный архив удалён (каталог tmp пуст).
    const leftovers = await readdir(join(target, 'tmp')).catch(() => [] as string[]);
    expect(leftovers.filter((f) => f.startsWith('restore-decrypt-'))).toEqual([]);
  });

  it('CLI restore `.enc` без ключа → exit 1 (понятная ошибка, аудит restore.failed)', async () => {
    const encrypted = await createBackup({
      dataDir,
      out: join(tmpDir, 'enc.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
    });
    const audit = new MemoryMaintenanceAuditRepository();
    const errors: string[] = [];
    const code = await runRestoreCommand({
      archive: encrypted.path,
      dataDir: join(tmpDir, 'target'),
      yes: true,
      noSafetyCopy: true,
      env: {},
      audit,
      log: () => {},
      error: (msg) => errors.push(msg),
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Не задан ключ шифрования');
    const entries = await audit.list();
    expect(entries.map((entry) => entry.op)).toEqual(['restore.failed']);
  });

  it('resolveBackupKey: приоритет --key-file > SYNTH_BACKUP_KEY_FILE > SYNTH_BACKUP_KEY', async () => {
    const keyFile = join(tmpDir, 'k1');
    await writeFile(keyFile, TEST_KEY_B64, 'utf-8');
    const otherFile = join(tmpDir, 'k2');
    await writeFile(otherFile, OTHER_KEY.toString('hex'), 'utf-8');

    // key-file приоритетнее env.
    expect(
      await resolveBackupKey({
        keyFile,
        env: { SYNTH_BACKUP_KEY: OTHER_KEY.toString('base64') },
      }),
    ).toEqual(TEST_KEY);
    // env-файл приоритетнее inline env-ключа.
    expect(
      await resolveBackupKey({
        env: { SYNTH_BACKUP_KEY_FILE: keyFile, SYNTH_BACKUP_KEY: OTHER_KEY.toString('base64') },
      }),
    ).toEqual(TEST_KEY);
    // inline env-ключ (base64 и hex).
    expect(await resolveBackupKey({ env: { SYNTH_BACKUP_KEY: TEST_KEY_B64 } })).toEqual(TEST_KEY);
    expect(await resolveBackupKey({ env: { SYNTH_BACKUP_KEY: TEST_KEY_HEX } })).toEqual(TEST_KEY);
    // Нет ключа — ошибка без эха значения.
    await expect(resolveBackupKey({ env: {} })).rejects.toBeInstanceOf(BackupEncryptionError);
  });

  it('decodeBackupKey: неверная длина/формат → ошибка', () => {
    expect(() => decodeBackupKey('too-short')).toThrow();
    expect(() => decodeBackupKey(Buffer.alloc(16).toString('base64'))).toThrow();
    expect(() => decodeBackupKey('!!not base64!!')).toThrow();
    expect(decodeBackupKey(TEST_KEY_HEX)).toEqual(TEST_KEY);
    expect(decodeBackupKey(TEST_KEY_B64)).toEqual(TEST_KEY);
  });

  it('ошибка аудит-порта не мешает бэкапу с шифрованием (best-effort)', async () => {
    const audit: MaintenanceAuditRepository = {
      append: async () => {
        throw new Error('audit down');
      },
      list: async () => [],
      clear: async () => 0,
    };
    const result = await createBackup({
      dataDir,
      out: join(tmpDir, 'ok.tar.gz'),
      encrypt: true,
      encryptKey: TEST_KEY,
      audit,
    });
    expect(result.encrypted).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
  });
});
