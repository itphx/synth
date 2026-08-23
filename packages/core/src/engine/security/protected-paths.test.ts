import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';
import { loadProtectedPaths, checkPath, clearProtectedPathsCache } from './protected-paths.js';
import type { ProtectedPathsPolicy, ProtectedPathsOverride } from './protected-paths.js';

const HOME = os.homedir();
const CWD = '/workspace/project';

function basePolicy(): ProtectedPathsPolicy {
  return {
    deniedPaths: ['~/.ssh/id_rsa', '/etc/passwd'],
    deniedPrefixes: ['~/.ssh', '/etc/sudoers.d'],
    approvalPaths: ['~/.ssh/config'],
    deniedCommandPrefixes: ['rm -rf /'],
  };
}

describe('checkPath — приоритет deny > ask > deniedPrefixes', () => {
  it('deniedPaths (точное совпадение) → deny', () => {
    const d = checkPath('~/.ssh/id_rsa', CWD, basePolicy());
    expect(d.action).toBe('deny');
    expect(d.matchedRule).toBe('protected-paths.deny');
  });

  it('approvalPaths → ask', () => {
    const d = checkPath('~/.ssh/config', CWD, basePolicy());
    expect(d.action).toBe('ask');
    expect(d.matchedRule).toBe('protected-paths.ask');
  });

  it('deniedPrefixes (директория) → deny, но approvalPaths проверяется раньше', () => {
    // .ssh/config под префиксом ~/.ssh, но должен дать ask (approvalPaths раньше)
    const d = checkPath('~/.ssh/config', CWD, basePolicy());
    expect(d.action).toBe('ask');
    // файл вне approvalPaths, внутри deniedPrefixes — deny
    const d2 = checkPath('~/.ssh/authorized_keys', CWD, basePolicy());
    expect(d2.action).toBe('deny');
    expect(d2.matchedRule).toBe('protected-paths.deny');
  });

  it('обычный путь → allow', () => {
    expect(checkPath('~/workspace/file.ts', CWD, basePolicy()).action).toBe('allow');
  });
});

describe('checkPath — резолв путей', () => {
  it('~ расширяется в домашний каталог', () => {
    const d = checkPath('~/.ssh/id_rsa', CWD, basePolicy());
    expect(d.action).toBe('deny');
    expect(d.reason).toContain(join(HOME, '.ssh', 'id_rsa'));
  });

  it('$HOME расширяется в домашний каталог', () => {
    const d = checkPath('$HOME/.ssh/id_rsa', CWD, basePolicy());
    expect(d.action).toBe('deny');
  });

  it('$PWD расширяется в cwd', () => {
    const policy: ProtectedPathsPolicy = { ...basePolicy(), deniedPaths: ['$PWD/secret.txt'] };
    const d = checkPath('$PWD/secret.txt', CWD, policy);
    expect(d.action).toBe('deny');
  });

  it('относительный путь резолвится от cwd', () => {
    const policy: ProtectedPathsPolicy = { ...basePolicy(), deniedPaths: [join(CWD, 'secret.txt')] };
    const d = checkPath('secret.txt', CWD, policy);
    expect(d.action).toBe('deny');
  });

  it('динамический путь ($(...) / ${...}) — не блокируется (source unknown)', () => {
    const d = checkPath('$(echo ~)/.ssh/id_rsa', CWD, basePolicy());
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('динамику');
  });
});

describe('checkPath — пустая политика', () => {
  it('пустые списки → allow', () => {
    const empty: ProtectedPathsPolicy = { deniedPaths: [], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [] };
    expect(checkPath('~/.ssh/id_rsa', CWD, empty).action).toBe('allow');
  });
});

describe('loadProtectedPaths — каскад add/remove', () => {
  let dir: string;
  let systemDir: string;
  let overrideDir: string;
  let overridePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-protected-paths-'));
    systemDir = join(dir, 'system');
    overrideDir = join(dir, 'security');
    overridePath = join(overrideDir, 'protected-paths.json');
    await mkdir(systemDir, { recursive: true });
    await mkdir(overrideDir, { recursive: true });
    await writeFile(join(systemDir, 'protected-paths.json'), JSON.stringify(basePolicy(), null, 2), 'utf-8');
    clearProtectedPathsCache();
  });

  afterEach(async () => {
    clearProtectedPathsCache();
    await rm(dir, { recursive: true, force: true });
  });

  it('без override — возвращается системная политика', () => {
    const p = loadProtectedPaths({ systemDir, overridePath });
    expect(p.deniedPaths).toEqual(['~/.ssh/id_rsa', '/etc/passwd']);
    expect(p.approvalPaths).toEqual(['~/.ssh/config']);
  });

  it('override add расширяет списки', async () => {
    const ov: ProtectedPathsOverride = {
      version: 1,
      add: { deniedPaths: ['/extra/secret'], approvalPaths: ['/extra/ask'] },
      remove: {},
    };
    await writeFile(overridePath, JSON.stringify(ov, null, 2), 'utf-8');
    const p = loadProtectedPaths({ systemDir, overridePath });
    expect(p.deniedPaths).toEqual(['~/.ssh/id_rsa', '/etc/passwd', '/extra/secret']);
    expect(p.approvalPaths).toEqual(['~/.ssh/config', '/extra/ask']);
  });

  it('override remove убирает из базы', async () => {
    const ov: ProtectedPathsOverride = {
      version: 1,
      add: {},
      remove: { deniedPaths: ['/etc/passwd'] },
    };
    await writeFile(overridePath, JSON.stringify(ov, null, 2), 'utf-8');
    const p = loadProtectedPaths({ systemDir, overridePath });
    expect(p.deniedPaths).toEqual(['~/.ssh/id_rsa']);
  });

  it('add и remove одновременно: итог = base + add − remove', async () => {
    const ov: ProtectedPathsOverride = {
      version: 1,
      add: { deniedPaths: ['/new'] },
      remove: { deniedPaths: ['~/.ssh/id_rsa'] },
    };
    await writeFile(overridePath, JSON.stringify(ov, null, 2), 'utf-8');
    const p = loadProtectedPaths({ systemDir, overridePath });
    expect(p.deniedPaths).toEqual(['/etc/passwd', '/new']);
  });

  it('remove не ломает duplicate у add (set-семантика)', async () => {
    const ov: ProtectedPathsOverride = {
      version: 1,
      add: { deniedPaths: ['/a', '/b'] },
      remove: {},
    };
    await writeFile(overridePath, JSON.stringify(ov, null, 2), 'utf-8');
    const p = loadProtectedPaths({ systemDir, overridePath });
    expect(p.deniedPaths).toEqual(['~/.ssh/id_rsa', '/etc/passwd', '/a', '/b']);
  });

  it('кэшируется по ключу systemDir|overridePath', async () => {
    const p1 = loadProtectedPaths({ systemDir, overridePath });
    await writeFile(overridePath, JSON.stringify({ version: 1, add: { deniedPaths: ['/x'] }, remove: {} }, null, 2), 'utf-8');
    const p2 = loadProtectedPaths({ systemDir, overridePath });
    // кэш не перечитан — тот же результат (кэш)
    expect(p1).toBe(p2);
  });

  it('невалидный override-файл — игнорируется (fallback на base)', async () => {
    await writeFile(overridePath, '{ not json', 'utf-8');
    const p = loadProtectedPaths({ systemDir, overridePath });
    expect(p.deniedPaths).toEqual(['~/.ssh/id_rsa', '/etc/passwd']);
  });

  it('несуществующий override-файл — системная политика', async () => {
    const p = loadProtectedPaths({ systemDir, overridePath: join(overrideDir, 'missing.json') });
    expect(p.deniedPaths).toEqual(['~/.ssh/id_rsa', '/etc/passwd']);
  });

  it('использует реальный definitions/protected-paths.json (интеграция)', () => {
    // без systemDir — читает definitions/protected-paths.json из пакета
    const p = loadProtectedPaths({});
    expect(p.deniedPaths).toContain('~/.ssh/id_rsa');
    expect(p.deniedPaths).toContain('/etc/passwd');
  });
});
