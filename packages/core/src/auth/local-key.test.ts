import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localApiKeyFilePath, resolveOrCreateLocalApiKey } from './local-key.js';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-local-key-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveOrCreateLocalApiKey (локальный API-ключ standalone)', () => {
  it('читает существующий непустой ключ (created: false, trim)', async () => {
    const dir = await makeTmpDir();
    await mkdir(join(dir, 'secrets'), { recursive: true });
    await writeFile(localApiKeyFilePath(dir), '  existing-key-123\n');

    const res = await resolveOrCreateLocalApiKey({ dataDir: dir });

    expect(res.created).toBe(false);
    expect(res.key).toBe('existing-key-123');
    expect(res.path).toBe(localApiKeyFilePath(dir));
  });

  it('генерирует 32 hex-символа, каталог 0700, файл 0600', async () => {
    const dir = await makeTmpDir();

    const res = await resolveOrCreateLocalApiKey({ dataDir: dir });

    expect(res.created).toBe(true);
    expect(res.key).toMatch(/^[0-9a-f]{32}$/);
    expect(res.path).toBe(localApiKeyFilePath(dir));
    expect((await stat(join(dir, 'secrets'))).mode & 0o777).toBe(0o700);
    expect((await stat(res.path)).mode & 0o777).toBe(0o600);
    expect((await readFile(res.path, 'utf-8')).trim()).toBe(res.key);
  });

  it('идемпотентен: повторный вызов возвращает тот же ключ', async () => {
    const dir = await makeTmpDir();

    const first = await resolveOrCreateLocalApiKey({ dataDir: dir });
    const second = await resolveOrCreateLocalApiKey({ dataDir: dir });

    expect(second.key).toBe(first.key);
    expect(second.created).toBe(false);
  });

  it('пустой/whitespace-only файл перегенерируется', async () => {
    const dir = await makeTmpDir();
    await mkdir(join(dir, 'secrets'), { recursive: true });
    await writeFile(localApiKeyFilePath(dir), '   \n');

    const res = await resolveOrCreateLocalApiKey({ dataDir: dir });

    expect(res.created).toBe(true);
    expect(res.key).toMatch(/^[0-9a-f]{32}$/);
  });
});
