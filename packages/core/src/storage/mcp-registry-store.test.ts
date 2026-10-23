import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpRegistryStore } from './mcp-registry-store.js';
import type { McpServerConfig } from '@itphx/synth-shared';

const httpConfig = (url = 'https://mcp.example.com/mcp'): McpServerConfig => ({ type: 'sse', url });
const stdioConfig = (): McpServerConfig => ({ type: 'stdio', command: 'node', args: ['server.js'] });

describe('McpRegistryStore (ADR-071 §2.5)', () => {
  let store: McpRegistryStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-mcp-registry-'));
    store = new McpRegistryStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('add создаёт PG-ready запись со стабильными полями', async () => {
    const entry = await store.add({
      name: 'my-http',
      config: httpConfig(),
      origin: 'user',
      author: { userId: 'u1', username: 'developer' },
      trust: 'community',
    });

    expect(entry.id).toBeTruthy();
    expect(entry.schemaVersion).toBe(1);
    expect(entry.name).toBe('my-http');
    expect(entry.origin).toBe('user');
    expect(entry.trust).toBe('community');
    expect(entry.author).toEqual({ userId: 'u1', username: 'developer' });
    expect(entry.enabledByDefault).toBe(false);
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBeTruthy();
  });

  it('instance-запись по умолчанию trust=builtin, author=null', async () => {
    const entry = await store.add({ name: 'sys', config: stdioConfig(), origin: 'instance' });
    expect(entry.trust).toBe('builtin');
    expect(entry.author).toBeNull();
  });

  it('get/getByName/list возвращают запись', async () => {
    const entry = await store.add({ name: 'a', config: httpConfig(), origin: 'user' });
    expect((await store.get(entry.id))?.name).toBe('a');
    expect((await store.getByName('a'))?.id).toBe(entry.id);
    expect(await store.list()).toHaveLength(1);
    expect(await store.get('missing')).toBeNull();
    expect(await store.getByName('missing')).toBeNull();
  });

  it('add отклоняет дубликат по имени', async () => {
    await store.add({ name: 'dup', config: httpConfig(), origin: 'user' });
    await expect(store.add({ name: 'dup', config: httpConfig(), origin: 'user' })).rejects.toThrow('уже существует');
  });

  it('update меняет поля и updatedAt, сохраняет id/createdAt', async () => {
    const entry = await store.add({ name: 'a', config: httpConfig(), origin: 'user' });
    const updated = await store.update(entry.id, {
      name: 'b',
      config: { type: 'sse', url: 'https://other.example.com/mcp' },
      enabledByDefault: true,
    });
    expect(updated?.id).toBe(entry.id);
    expect(updated?.name).toBe('b');
    expect(updated?.enabledByDefault).toBe(true);
    expect(updated?.createdAt).toBe(entry.createdAt);
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(entry.updatedAt).getTime());
  });

  it('update возвращает null для несуществующего id', async () => {
    expect(await store.update('missing', { enabledByDefault: true })).toBeNull();
  });

  it('remove удаляет запись', async () => {
    const entry = await store.add({ name: 'a', config: httpConfig(), origin: 'user' });
    expect(await store.remove(entry.id)).toBe(true);
    expect(await store.get(entry.id)).toBeNull();
    expect(await store.remove(entry.id)).toBe(false);
  });

  it('toServerConfigMap отдаёт имя → конфиг', async () => {
    await store.add({ name: 'a', config: httpConfig(), origin: 'user' });
    await store.add({ name: 'b', config: stdioConfig(), origin: 'instance' });
    const map = await store.toServerConfigMap();
    expect(Object.keys(map).sort()).toEqual(['a', 'b']);
    expect(map.a?.url).toBe('https://mcp.example.com/mcp');
  });

  it('toOriginMap отдаёт имя → origin', async () => {
    await store.add({ name: 'a', config: httpConfig(), origin: 'user' });
    await store.add({ name: 'b', config: stdioConfig(), origin: 'instance' });
    expect(await store.toOriginMap()).toEqual({ a: 'user', b: 'instance' });
  });

  it('seedFromConfig добавляет instance-серверы и не дублирует по имени', async () => {
    const added = await store.seedFromConfig({
      'synth-mcp-local': { type: 'sse', url: 'http://localhost:8080/mcp', enabledByDefault: true },
      'stdio-srv': stdioConfig(),
    });
    expect(added).toBe(2);

    const entries = await store.list();
    expect(entries).toHaveLength(2);
    const local = entries.find((e) => e.name === 'synth-mcp-local');
    expect(local?.origin).toBe('instance');
    expect(local?.trust).toBe('builtin');
    expect(local?.author).toBeNull();
    expect(local?.enabledByDefault).toBe(true);

    // Повторный сид — без дублирования.
    expect(await store.seedFromConfig({ 'synth-mcp-local': { type: 'sse', url: 'http://localhost:8080/mcp' } })).toBe(0);
    expect(await store.list()).toHaveLength(2);
  });

  it('персистит данные между инстансами (переживает рестарт)', async () => {
    await store.add({ name: 'persist', config: httpConfig(), origin: 'user' });
    const reloaded = new McpRegistryStore({ dataDir: tmpDir });
    expect((await reloaded.getByName('persist'))?.name).toBe('persist');
  });

  it('пишет файл атомарно: нет .tmp-файлов, JSON валиден', async () => {
    await store.add({ name: 'atomic', config: httpConfig(), origin: 'user' });
    const dir = join(tmpDir, 'mcp');
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
    expect(files).toContain('registry.json');
    const raw = JSON.parse(await readFile(join(dir, 'registry.json'), 'utf-8'));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.entries).toHaveLength(1);
  });

  it('параллельные add не теряют записи (per-file lock)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.add({ name: `srv-${i}`, config: httpConfig(), origin: 'user' }),
      ),
    );
    const entries = await store.list();
    expect(entries).toHaveLength(10);
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.size).toBe(10);
  });

  it('ADR-105 Ф0: ссылка на внешний доступ (auth) переживает перезапуск', async () => {
    await store.add({
      name: 'with-auth',
      config: { ...httpConfig(), auth: { kind: 'credential', credentialId: 'extc_1' } },
      origin: 'user',
    });

    const reloaded = new McpRegistryStore({ dataDir: tmpDir });
    expect((await reloaded.getByName('with-auth'))?.config.auth).toEqual({
      kind: 'credential',
      credentialId: 'extc_1',
    });
    expect((await reloaded.toServerConfigMap())['with-auth']?.auth).toEqual({
      kind: 'credential',
      credentialId: 'extc_1',
    });
  });

  it('ADR-105 Ф0: старые записи без auth читаются как есть (обратная совместимость)', async () => {
    const entry = await store.add({ name: 'legacy', config: httpConfig(), origin: 'user' });
    expect(entry.config.auth).toBeUndefined();
    expect((await store.get(entry.id))?.config.auth).toBeUndefined();
  });
});
