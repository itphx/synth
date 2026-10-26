/**
 * ADR-077 (протокол 4): материализация секретов вызова **на исполнителе**.
 *
 * Control plane передаёт приватный SSH-ключ **значением** (поле `secrets[]`
 * в `POST /exec`): путь к файлу в control plane в контейнере исполнителя не
 * существует. Исполнитель готовит материал **у себя** (каталог `0700`, ключ
 * `0600`, askpass `0700`) и **обязательно** удаляет его после вызова —
 * при успехе, ошибке команды, таймауте и отмене.
 *
 * Здесь проверяется именно этот слой: права на материал, состав окружения,
 * наличие файла во время команды и его удаление после, уборка частично
 * созданного при сбое подготовки и sweep осиротевших каталогов.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { materializeSecrets, SSH_TEMP_DIR_PREFIX, sweepStaleSshDirs } from './secrets.js';
import { ExecService } from './exec-service.js';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nexecutor-secret-material\n-----END OPENSSH PRIVATE KEY-----\n';
const PASSPHRASE = 'executor-passphrase';

/** Путь к ключу из `GIT_SSH_COMMAND` (`ssh -i <путь> …`). */
function keyPathFrom(env: Record<string, string>): string {
  const command = env.GIT_SSH_COMMAND ?? '';
  const match = /ssh -i (\S+)/.exec(command);
  if (!match?.[1]) throw new Error(`в GIT_SSH_COMMAND нет пути к ключу: ${command}`);
  return match[1];
}

/** Каталоги `synth-ssh-*` в `os.tmpdir()`, содержащие материал с маркером. */
async function dirsWithMaterial(marker: string): Promise<string[]> {
  const root = tmpdir();
  const found: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!name.startsWith(SSH_TEMP_DIR_PREFIX)) continue;
    const dir = join(root, name);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const content = await readFile(join(dir, file), 'utf-8');
        if (content.includes(marker)) {
          found.push(dir);
          break;
        }
      } catch {
        // Файл недоступен — пропускаем.
      }
    }
  }
  return found;
}

describe('материализация секретов вызова (ADR-077, протокол 4)', () => {
  it('каталог 0700 и ключ 0600; GIT_SSH_COMMAND указывает внутрь своего tmp', async () => {
    const materialized = await materializeSecrets([{ kind: 'ssh-key', privateKey: PRIVATE_KEY }]);
    try {
      const keyPath = keyPathFrom(materialized.env);
      const dir = dirname(keyPath);

      expect(basename(dir).startsWith(SSH_TEMP_DIR_PREFIX)).toBe(true);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
      // Ключ — внутри своего каталога (никаких путей control plane).
      expect(keyPath.startsWith(`${dir}/`)).toBe(true);
      await expect(access(keyPath)).resolves.toBeUndefined();
    } finally {
      await materialized.cleanup();
    }
  });

  it('cleanup удаляет каталог с ключом; повторный вызов — no-op', async () => {
    const materialized = await materializeSecrets([{ kind: 'ssh-key', privateKey: PRIVATE_KEY }]);
    const keyPath = keyPathFrom(materialized.env);
    const dir = dirname(keyPath);

    await materialized.cleanup();
    await expect(access(keyPath)).rejects.toBeTruthy();
    await expect(access(dir)).rejects.toBeTruthy();
    // Идемпотентно.
    await expect(materialized.cleanup()).resolves.toBeUndefined();
  });

  it('с passphrase — askpass 0700, SSH_ASKPASS/SSH_ASKPASS_REQUIRE и NumberOfPasswordPrompts=1', async () => {
    const materialized = await materializeSecrets([
      { kind: 'ssh-key', privateKey: PRIVATE_KEY, passphrase: PASSPHRASE },
    ]);
    try {
      const keyPath = keyPathFrom(materialized.env);
      const dir = dirname(keyPath);
      const askpass = materialized.env.SSH_ASKPASS;

      expect(askpass).toBeTruthy();
      expect(materialized.env.SSH_ASKPASS_REQUIRE).toBe('force');
      expect(materialized.env.GIT_SSH_COMMAND).toContain('NumberOfPasswordPrompts=1');
      // Без passphrase BatchMode глушит askpass — с passphrase его быть не должно.
      expect(materialized.env.GIT_SSH_COMMAND).not.toContain('BatchMode=yes');
      expect((await stat(askpass as string)).mode & 0o777).toBe(0o700);
      expect(askpass?.startsWith(dir)).toBe(true);
    } finally {
      await materialized.cleanup();
    }
  });

  it('сбой подготовки — частично созданный каталог убран', async () => {
    // Второй секрет падает при записи ключа (не строка) — первый уже создан.
    const badSecret = { kind: 'ssh-key' as const, privateKey: undefined as unknown as string };
    await expect(
      materializeSecrets([{ kind: 'ssh-key', privateKey: PRIVATE_KEY }, badSecret]),
    ).rejects.toThrow();
    expect(await dirsWithMaterial('executor-secret-material')).toEqual([]);
  });
});

describe('исполнитель: секрет живёт только во время команды', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'synth-exec-secrets-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function makeService(): ExecService {
    return new ExecService({
      workspaceRoot: workspace,
      maxConcurrency: 2,
      maxTimeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
  }

  it('файл ключа есть во время команды и удалён после успеха', async () => {
    const service = makeService();
    const outcome = await service.execute({
      command: {
        kind: 'shell',
        command:
          'p=$(printf "%s" "$GIT_SSH_COMMAND" | sed "s/.*-i \\([^ ]*\\).*/\\1/"); ' +
          'if [ -f "$p" ]; then printf "key:%s" "$p"; else printf "no-key"; fi',
      },
      secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.stdout.startsWith('key:')).toBe(true);
    const keyPath = outcome.result.stdout.slice('key:'.length);
    // Во время команды файл существовал…
    expect(keyPath.length).toBeGreaterThan(0);
    // …а после вызова — удалён.
    await expect(access(keyPath)).rejects.toBeTruthy();
    await expect(access(dirname(keyPath))).rejects.toBeTruthy();
  });

  it('файл ключа удалён и после ошибки команды (ненулевой код выхода)', async () => {
    const service = makeService();
    const outcome = await service.execute({
      command: {
        kind: 'shell',
        command:
          'p=$(printf "%s" "$GIT_SSH_COMMAND" | sed "s/.*-i \\([^ ]*\\).*/\\1/"); ' +
          'printf "key:%s" "$p"; exit 3',
      },
      secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.reason).toBe('nonzero_exit');
    const keyPath = outcome.error.stdout.slice('key:'.length);
    expect(keyPath.length).toBeGreaterThan(0);
    await expect(access(keyPath)).rejects.toBeTruthy();
  });
});

describe('sweep осиротевших каталогов SSH (ADR-077, протокол 4)', () => {
  let oldDir: string;
  let freshDir: string;

  beforeEach(async () => {
    oldDir = join(tmpdir(), `${SSH_TEMP_DIR_PREFIX}stale-${process.pid}-${Date.now()}`);
    freshDir = join(tmpdir(), `${SSH_TEMP_DIR_PREFIX}fresh-${process.pid}-${Date.now()}`);
    await mkdir(oldDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });
    await writeFile(join(oldDir, 'key'), PRIVATE_KEY, { encoding: 'utf-8', mode: 0o600 });
    // Старый каталог — «осиротевший» (двухчасовой давности).
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldDir, twoHoursAgo, twoHoursAgo);
  });

  afterEach(async () => {
    await rm(oldDir, { recursive: true, force: true });
    await rm(freshDir, { recursive: true, force: true });
  });

  it('старый каталог удаляется, свежий — остаётся', async () => {
    const removed = await sweepStaleSshDirs(60 * 60 * 1000);
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(access(oldDir)).rejects.toBeTruthy();
    await expect(access(freshDir)).resolves.toBeUndefined();
  });

  it('свежий каталог не трогается даже при частом sweep', async () => {
    await sweepStaleSshDirs(60 * 60 * 1000);
    await expect(access(freshDir)).resolves.toBeUndefined();
  });
});
