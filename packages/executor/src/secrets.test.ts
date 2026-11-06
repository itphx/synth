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
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  materializeSecrets,
  SSH_AGENT_PID_FILE,
  SSH_TEMP_DIR_PREFIX,
  STALE_SSH_DIR_TTL_MS,
  sweepStaleSshDirs,
} from './secrets.js';
import { ExecService } from './exec-service.js';

const execFileAsync = promisify(execFile);

// Фикстура: PEM собирается в рантайме, чтобы в исходниках не было литерала
// заголовка приватного ключа (secret-scan); тело — заведомая заглушка.
const pem = (body: string): string => {
  const label = 'OPENSSH PRIVATE KEY';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};
const PRIVATE_KEY = pem('executor-secret-material');
const PASSPHRASE = 'executor-passphrase';

/**
 * Есть ли программа в окружении: `ENOENT` — нет; прочий сбой — есть
 * (программа может не поддерживать вызванный флаг).
 */
async function hasProgram(bin: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(bin, args, { timeout: 10_000 });
    return true;
  } catch (err) {
    return (err as { code?: string | number }).code !== 'ENOENT';
  }
}

/**
 * Агентные инструменты в окружении (`ssh-agent`/`ssh-add`/`ssh-keygen`).
 *
 * Нет их — агентные тесты пропускаются (а не падают): в slim-образе
 * исполнителя `ssh-agent` может отсутствовать.
 */
const AGENT_TOOLS_AVAILABLE = (
  await Promise.all([
    hasProgram('ssh-agent', ['-h']),
    hasProgram('ssh-add', ['-h']),
    hasProgram('ssh-keygen', ['--help']),
  ])
).every(Boolean);

/** Ключ для агентных тестов — генерируется в рантайме (secret-scan). */
async function generateKey(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-exec-key-'));
  try {
    const path = join(dir, 'id_ed25519');
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', path, '-q']);
    return await readFile(path, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** pid уже завершившегося процесса (для проверки sweep'а). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return pid;
}

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
  it('константы каталога совпадают с core (контракт reaper\'а)', async () => {
    // Reaper — общая реализация в core (`execution/ssh-sweep.ts`): значения
    // имён файлов и префикса должны совпадать, иначе исполнитель не увидит
    // каталоги control plane (и наоборот).
    const core = await import('@itphx/synth-core');
    expect(SSH_TEMP_DIR_PREFIX).toBe(core.SSH_TEMP_DIR_PREFIX);
    expect(SSH_AGENT_PID_FILE).toBe(core.SSH_AGENT_PID_FILE);
    expect(STALE_SSH_DIR_TTL_MS).toBe(core.STALE_SSH_DIR_TTL_MS);
  });

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

/**
 * Sweep осиротевших каталогов — **по живости pid агента** (PROP-124 §2).
 *
 * Каталог с живым агентом нельзя удалять по возрасту: иначе длинный фоновый
 * прогон теряет ключ (агент жив, а сокет/материал исчезли бы).
 */
describe('sweep по живости pid агента (PROP-124 §2)', () => {
  it('каталог с живым pid не удаляется даже по возрасту', async () => {
    const dir = join(tmpdir(), `${SSH_TEMP_DIR_PREFIX}live-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    // pid текущего процесса — заведомо живой.
    await writeFile(join(dir, SSH_AGENT_PID_FILE), String(process.pid), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(dir, twoHoursAgo, twoHoursAgo);
    try {
      await sweepStaleSshDirs(60 * 60 * 1000);
      // Каталог на месте — ключ процесса вызова не потерян.
      await expect(access(dir)).resolves.toBeUndefined();
      await expect(access(join(dir, SSH_AGENT_PID_FILE))).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('каталог с мёртвым pid убирается по возрасту (как прежде)', async () => {
    const dir = join(tmpdir(), `${SSH_TEMP_DIR_PREFIX}dead-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, SSH_AGENT_PID_FILE), String(await deadPid()), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(dir, twoHoursAgo, twoHoursAgo);
    try {
      await sweepStaleSshDirs(60 * 60 * 1000);
      await expect(access(dir)).rejects.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('битый pid-файл не мешает уборке по возрасту', async () => {
    const dir = join(tmpdir(), `${SSH_TEMP_DIR_PREFIX}broken-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, SSH_AGENT_PID_FILE), 'не pid', { encoding: 'utf-8', mode: 0o600 });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(dir, twoHoursAgo, twoHoursAgo);
    try {
      await sweepStaleSshDirs(60 * 60 * 1000);
      await expect(access(dir)).rejects.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Агентный режим секрета вызова на исполнителе (протокол 6, PROP-124 §2):
 * `SSH_AUTH_SOCK` в окружении вызова, приватный ключ удаляется с диска сразу
 * после `ssh-add`.
 */
describe.skipIf(!AGENT_TOOLS_AVAILABLE)('исполнитель: агентный режим секрета (протокол 6)', () => {
  it('mode: "agent" — SSH_AUTH_SOCK в env, файла ключа нет, cleanup гасит агента', async () => {
    const privateKey = await generateKey();
    const materialized = await materializeSecrets([
      { kind: 'ssh-key', privateKey, mode: 'agent' },
    ]);
    const sock = materialized.env.SSH_AUTH_SOCK;
    const pid = Number(materialized.env.SSH_AGENT_PID);
    try {
      expect(sock).toBeTruthy();
      expect(Number.isInteger(pid)).toBe(true);
      // Git-режим не смешивается с агентным.
      expect(materialized.env.GIT_SSH_COMMAND).toBeUndefined();
      // Файла ключа нет — материал только в памяти агента.
      const dir = dirname(sock!);
      expect(await readdir(dir)).not.toContain('key');

      // Агент видит идентичность.
      const { stdout } = await execFileAsync('ssh-add', ['-l'], {
        env: { ...process.env, SSH_AUTH_SOCK: sock! },
      });
      expect(String(stdout).trim().length).toBeGreaterThan(0);
    } finally {
      await materialized.cleanup();
    }
    // Каталог убран.
    await expect(access(dirname(sock!))).rejects.toBeTruthy();
  });

  it('mode: "git" — поведение прежнее (GIT_SSH_COMMAND, ключ на диске)', async () => {
    const materialized = await materializeSecrets([
      { kind: 'ssh-key', privateKey: PRIVATE_KEY, mode: 'git' },
    ]);
    try {
      expect(materialized.env.GIT_SSH_COMMAND).toContain('-i ');
      expect(materialized.env.SSH_AUTH_SOCK).toBeUndefined();
      const keyPath = keyPathFrom(materialized.env);
      await expect(access(keyPath)).resolves.toBeUndefined();
    } finally {
      await materialized.cleanup();
    }
  });
});
