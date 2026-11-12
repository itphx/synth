/**
 * Тесты fail-closed проверки каталога данных (PROP-137 Ф1).
 *
 * Проверка реальная (создание файла), а не `access(W_OK)`: на NFS бит записи
 * может не совпадать с фактической возможностью создать файл.
 *
 * Тесты на «нет права записи» выполняются только под не-root: у root биты
 * прав не ограничивают запись, и каталог 0555 остаётся записываемым —
 * отвергнуть его проверка (верно) не может.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDataDirWritable, DataDirNotWritableError } from './data-dir-check.js';

/** Процесс запущен от root? Тогда биты прав не ограничивают запись. */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('assertDataDirWritable (core)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-datadir-check-'));
  });

  afterEach(async () => {
    await chmod(root, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it('записываемый каталог — проверка проходит', async () => {
    const dir = join(root, 'data');
    await expect(assertDataDirWritable(dir)).resolves.toBeUndefined();
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('отсутствующий каталог создаётся', async () => {
    const dir = join(root, 'nested', 'deeper', 'data');
    await assertDataDirWritable(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('проба не оставляет временных файлов в каталоге', async () => {
    const dir = join(root, 'data');
    await assertDataDirWritable(dir);
    expect(await readdir(dir)).toEqual([]);
  });

  it.skipIf(isRoot)('каталог без права записи — ошибка с uid и командой chown', async () => {
    const dir = join(root, 'readonly');
    await mkdir(dir);
    await chmod(dir, 0o555);

    const err = await assertDataDirWritable(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataDirNotWritableError);
    const message = (err as DataDirNotWritableError).message;
    expect(message).toContain(`data directory "${dir}" is not writable by uid`);
    expect(message).toContain('chown -R');
    expect(message).toContain(`"${dir}"`);
    expect((err as DataDirNotWritableError).code).toBe('DATA_DIR_NOT_WRITABLE');
    expect((err as DataDirNotWritableError).dataDir).toBe(dir);
  });

  it.skipIf(isRoot)('ошибка содержит uid процесса (в тексте команды chown)', async () => {
    const dir = join(root, 'readonly2');
    await mkdir(dir);
    await chmod(dir, 0o555);
    const err = await assertDataDirWritable(dir).catch((e: unknown) => e);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
    expect((err as DataDirNotWritableError).uid).toBe(String(uid));
    expect((err as DataDirNotWritableError).message).toContain(`chown -R ${String(uid)}:`);
  });

  it.skipIf(isRoot)('после снятия прав каталог снова проходит проверку', async () => {
    const dir = join(root, 'restored');
    await mkdir(dir);
    await chmod(dir, 0o555);
    await expect(assertDataDirWritable(dir)).rejects.toThrow(DataDirNotWritableError);
    await chmod(dir, 0o755);
    await expect(assertDataDirWritable(dir)).resolves.toBeUndefined();
  });

  it.skipIf(isRoot)('произвольный label попадает в текст ошибки', async () => {
    const dir = join(root, 'labelled');
    await mkdir(dir);
    await chmod(dir, 0o555);
    const err = await assertDataDirWritable(dir, { label: 'workspace directory' }).catch(
      (e: unknown) => e,
    );
    expect((err as DataDirNotWritableError).message).toContain('workspace directory');
  });
});
