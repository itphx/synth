import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';
import { loadProtectedPaths, checkPath, clearProtectedPathsCache } from './protected-paths.js';
import { ProtectedPathsStore } from './protected-paths-store.js';
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
    expect(d.messageId).toBe('deny-protected-path');
  });

  it('approvalPaths → ask', () => {
    const d = checkPath('~/.ssh/config', CWD, basePolicy());
    expect(d.action).toBe('ask');
    expect(d.matchedRule).toBe('protected-paths.ask');
    expect(d.messageId).toBe('ask-protected-path');
  });

  it('deniedPrefixes (директория) → deny, но approvalPaths проверяется раньше', () => {
    // .ssh/config под префиксом ~/.ssh, но должен дать ask (approvalPaths раньше)
    const d = checkPath('~/.ssh/config', CWD, basePolicy());
    expect(d.action).toBe('ask');
    // файл вне approvalPaths, внутри deniedPrefixes — deny (deny-protected-dir)
    const d2 = checkPath('~/.ssh/authorized_keys', CWD, basePolicy());
    expect(d2.action).toBe('deny');
    expect(d2.matchedRule).toBe('protected-paths.deny');
    expect(d2.messageId).toBe('deny-protected-dir');
    expect(d2.params?.dir).toContain('.ssh');
  });

  it('обычный путь → allow', () => {
    expect(checkPath('~/workspace/file.ts', CWD, basePolicy()).action).toBe('allow');
  });
});

describe('checkPath — резолв путей', () => {
  it('~ расширяется в домашний каталог', () => {
    const d = checkPath('~/.ssh/id_rsa', CWD, basePolicy());
    expect(d.action).toBe('deny');
    expect(d.messageId).toBe('deny-protected-path');
    expect(d.params?.path).toBe(join(HOME, '.ssh', 'id_rsa'));
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

  it('динамический путь с защищённым маркером — deny (fail-closed)', () => {
    // $() не резолвится, но литеральный фрагмент `/.ssh/id_rsa` — защищённый путь.
    const d = checkPath('$(echo ~)/.ssh/id_rsa', CWD, basePolicy());
    expect(d.action).toBe('deny');
    expect(d.matchedRule).toBe('protected-paths.deny');
    expect(d.messageId).toBe('deny-protected-path');
  });

  it('динамический путь без защищённых маркеров — не блокируется (source unknown)', () => {
    // Файловые тулы не раскрывают переменные: значение используется как
    // литеральный путь внутри workspace, поэтому «неизвестный» путь не denied.
    const d = checkPath('$(echo ~)/notes/todo.md', CWD, basePolicy());
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('dynamic parts');
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

describe('loadProtectedPaths — динамические префиксы {dataDir}/secrets (H5)', () => {
  let dir: string;
  let dataDir: string;
  let systemDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-protected-data-'));
    dataDir = join(dir, 'data');
    systemDir = join(dir, 'system');
    await mkdir(systemDir, { recursive: true });
    await mkdir(join(dataDir, 'security'), { recursive: true });
    await writeFile(join(systemDir, 'protected-paths.json'), JSON.stringify(basePolicy(), null, 2), 'utf-8');
    clearProtectedPathsCache();
  });

  afterEach(async () => {
    clearProtectedPathsCache();
    await rm(dir, { recursive: true, force: true });
  });

  it('dataDir → {dataDir}/secrets запрещён (пути в статическом JSON нет)', () => {
    const p = loadProtectedPaths({ systemDir, overridePath: join(dataDir, 'security', 'protected-paths.json'), dataDir });
    expect(p.deniedPrefixes).toContain(join(dataDir, 'secrets'));
    // мастер-ключ, api-key, ssh-ключи — deny
    expect(checkPath(join(dataDir, 'secrets', 'master.key'), CWD, p).action).toBe('deny');
    expect(checkPath(join(dataDir, 'secrets', 'api-key'), CWD, p).action).toBe('deny');
    expect(checkPath(join(dataDir, 'secrets', 'ssh-keys', 'k.json'), CWD, p).action).toBe('deny');
    expect(checkPath(join(dataDir, 'secrets'), CWD, p).action).toBe('deny');
    // {dataDir}/security (override-файл политики) — тоже deny (tamper-protection)
    expect(checkPath(join(dataDir, 'security', 'protected-paths.json'), CWD, p).action).toBe('deny');
    // обычные каталоги dataDir не закрываем (там workspace/sessions/projects)
    expect(checkPath(join(dataDir, 'sessions', 's.json'), CWD, p).action).toBe('allow');
    expect(checkPath(join(dataDir, 'workspaces', 'default', 'a.txt'), CWD, p).action).toBe('allow');
  });

  it('$SYNTH_DATA_DIR раскрывается по dataDir → deny', () => {
    const p = loadProtectedPaths({ systemDir, overridePath: join(dataDir, 'security', 'protected-paths.json'), dataDir });
    expect(checkPath('$SYNTH_DATA_DIR/secrets/master.key', CWD, p).action).toBe('deny');
    expect(checkPath('${SYNTH_DATA_DIR}/secrets/master.key', CWD, p).action).toBe('deny');
  });

  it('dataDir выводится из конвенции overridePath ({dataDir}/security/protected-paths.json)', () => {
    const p = loadProtectedPaths({ systemDir, overridePath: join(dataDir, 'security', 'protected-paths.json') });
    expect(p.deniedPrefixes).toContain(join(dataDir, 'secrets'));
    expect(checkPath(join(dataDir, 'secrets', 'master.key'), CWD, p).action).toBe('deny');
  });

  it('override не может снять динамический префикс (fail-safe)', async () => {
    await writeFile(join(dataDir, 'security', 'protected-paths.json'), JSON.stringify({
      version: 1,
      add: {},
      remove: { deniedPrefixes: [join(dataDir, 'secrets'), join(dataDir, 'security')] },
    }, null, 2), 'utf-8');
    const p = loadProtectedPaths({ systemDir, overridePath: join(dataDir, 'security', 'protected-paths.json'), dataDir });
    expect(checkPath(join(dataDir, 'secrets', 'master.key'), CWD, p).action).toBe('deny');
  });

  it('без dataDir — политика без динамических префиксов (совместимость)', () => {
    const p = loadProtectedPaths({ systemDir, overridePath: join(dir, 'custom-override.json') });
    expect(p.dataDir).toBeUndefined();
    expect(p.deniedPrefixes).not.toContain(join(dir, 'secrets'));
  });

  it('кэш учитывает dataDir (разные инстансы — разные политики)', () => {
    const otherDataDir = join(dir, 'other');
    const p1 = loadProtectedPaths({ systemDir, overridePath: join(dataDir, 'security', 'protected-paths.json'), dataDir });
    const p2 = loadProtectedPaths({ systemDir, overridePath: join(otherDataDir, 'security', 'protected-paths.json'), dataDir: otherDataDir });
    expect(p1).not.toBe(p2);
    expect(checkPath(join(dataDir, 'secrets', 'master.key'), CWD, p2).action).toBe('allow');
  });
});

describe('ProtectedPathsStore — динамические префиксы и API-представление (H5)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-protected-store-'));
    clearProtectedPathsCache();
  });

  afterEach(async () => {
    clearProtectedPathsCache();
    await rm(dir, { recursive: true, force: true });
  });

  it('getPolicy() закрывает {dataDir}/secrets, getRaw() не раскрывает dataDir', () => {
    const store = new ProtectedPathsStore({ dataDir: dir });
    const policy = store.getPolicy();
    expect(policy.dataDir).toBe(dir);
    expect(policy.deniedPrefixes).toContain(join(dir, 'secrets'));
    expect(checkPath(join(dir, 'secrets', 'master.key'), CWD, policy).action).toBe('deny');

    const raw = store.getRaw();
    expect(raw.policy.dataDir).toBeUndefined();
    // API-клиент видит динамические префиксы (прозрачность настроек)
    expect(raw.policy.deniedPrefixes).toContain(join(dir, 'secrets'));
    expect(raw.base.deniedPrefixes).not.toContain(join(dir, 'secrets'));
  });

  it('savePolicy из UI (со динамическими префиксами в списке) не ломает защиту', async () => {
    const store = new ProtectedPathsStore({ dataDir: dir });
    const fromUi = { ...store.getRaw().policy };
    expect(await store.savePolicy(fromUi)).toBe(true);
    clearProtectedPathsCache();
    const policy = store.getPolicy();
    expect(checkPath(join(dir, 'secrets', 'master.key'), CWD, policy).action).toBe('deny');
    // дубликатов динамического префикса нет
    expect(policy.deniedPrefixes.filter((p) => p === join(dir, 'secrets'))).toHaveLength(1);
  });
});
