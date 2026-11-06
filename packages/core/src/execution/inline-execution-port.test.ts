/**
 * ADR-077 (протокол 4) + PROP-124 §7: секреты вызова в inline-режиме.
 *
 * В inline-режиме точкой исполнения является процесс control plane: секрет
 * материализуется **здесь** (временный ключ `0600` в каталоге `0700`) и
 * **обязательно** удаляется после вызова — при успехе, ошибке команды,
 * таймауте и отмене. Никаких файлов в control plane после вызова не остаётся.
 *
 * Фоновый запуск (PROP-124 §7) секреты **поддерживает**: материал готовится
 * для фонового процесса и гасится **вместе с ним** — выход процесса,
 * `stop()`, таймаут. Ключ в режиме `agent` живёт в памяти эфемерного
 * `ssh-agent`, а агент **не** входит в группу процессов команды: поэтому
 * очистка явная, гарантированная и идемпотентная.
 */

import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { InlineExecutionPort } from './inline-execution-port.js';
import { isExecutionError } from './ports/index.js';

const execFileAsync = promisify(execFile);

// Фикстура: PEM собирается в рантайме, чтобы в исходниках не было литерала
// заголовка приватного ключа (secret-scan); тело — заведомая заглушка.
const pem = (body: string): string => {
  const label = 'OPENSSH PRIVATE KEY';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};
const PRIVATE_KEY = pem('inline-secret-material');

/** Команда печатает путь к ключу, извлечённый из `GIT_SSH_COMMAND`. */
const PRINT_KEY_PATH =
  'p=$(printf "%s" "$GIT_SSH_COMMAND" | sed "s/.*-i \\([^ ]*\\).*/\\1/"); printf "%s" "$p"';

/** Есть ли путь (файл/каталог) в файловой системе. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Дождаться появления файла (его пишет фоновая команда) и прочитать его. */
async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      if (Date.now() > deadline) throw new Error(`файл ${path} не появился`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        timer.unref?.();
      });
    }
  }
}

/** Дождаться смерти процесса (после `SIGTERM` он уходит не мгновенно). */
async function waitProcessGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
    });
  }
  return false;
}

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

/**
 * Ключ для агентных тестов — генерируется в рантайме (`ssh-keygen`), чтобы в
 * исходниках не было приватного ключа (secret-scan).
 */
async function generateKey(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-ssh-key-'));
  try {
    const path = join(dir, 'id_ed25519');
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', path, '-q']);
    return await readFile(path, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('inline-порт: материализация секрета вызова', () => {
  it('секрет доступен команде и удалён после вызова', async () => {
    const port = new InlineExecutionPort();
    const res = await port.execute({
      command: { kind: 'shell', command: PRINT_KEY_PATH },
      secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
    });

    const keyPath = res.stdout.trim();
    expect(keyPath.length).toBeGreaterThan(0);
    expect(keyPath).toContain('synth-ssh-');
    // Файл ключа существовал во время команды — и удалён после неё.
    await expect(access(keyPath)).rejects.toBeTruthy();
    await expect(access(dirname(keyPath))).rejects.toBeTruthy();
  });

  it('файл ключа есть во время выполнения команды', async () => {
    const port = new InlineExecutionPort();
    const res = await port.execute({
      command: {
        kind: 'shell',
        command:
          'p=$(printf "%s" "$GIT_SSH_COMMAND" | sed "s/.*-i \\([^ ]*\\).*/\\1/"); ' +
          'if [ -f "$p" ]; then printf "exists"; else printf "missing"; fi',
      },
      secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
    });
    expect(res.stdout).toBe('exists');
  });

  it('ненулевой код выхода — ошибка, но каталог с ключом тоже удалён', async () => {
    const port = new InlineExecutionPort();
    const err = await port
      .execute({
        command: { kind: 'shell', command: `${PRINT_KEY_PATH}; exit 3` },
        secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
      })
      .catch((e) => e);
    expect(isExecutionError(err)).toBe(true);
    if (!isExecutionError(err)) return;
    expect(err.reason).toBe('nonzero_exit');
    expect(err.code).toBe(3);
    const keyPath = err.stdout.trim();
    expect(keyPath.length).toBeGreaterThan(0);
    await expect(access(keyPath)).rejects.toBeTruthy();
    await expect(access(dirname(keyPath))).rejects.toBeTruthy();
  });

  it('без секретов окружение вызова не меняется', async () => {
    const port = new InlineExecutionPort();
    const res = await port.execute({
      command: { kind: 'shell', command: 'printf "%s" "$GIT_SSH_COMMAND"' },
    });
    expect(res.stdout).toBe('');
  });
});

/**
 * PROP-124 §7: фоновый запуск принимает секреты вызова — материал готовится
 * для фонового процесса и гасится вместе с ним.
 */
describe('inline-порт: секреты вызова в фоновом запуске', () => {
  it('секрет (git-режим) доступен фоновой команде и удалён после её выхода', async () => {
    const port = new InlineExecutionPort();
    const dir = await mkdtemp(join(tmpdir(), 'synth-bg-secret-'));
    const out = join(dir, 'key-path');
    try {
      const bg = await port.spawnBackground({
        command: { kind: 'shell', command: `${PRINT_KEY_PATH} > ${out}` },
        secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
      });
      const exit = await bg.exited;
      expect(exit.exitCode).toBe(0);

      const keyPath = (await readFile(out, 'utf-8')).trim();
      expect(keyPath).toContain('synth-ssh-');
      // После выхода процесса материал убран: и файл ключа, и каталог.
      expect(await exists(keyPath)).toBe(false);
      expect(await exists(dirname(keyPath))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('таймаут фонового процесса — материал убран вместе с процессом', async () => {
    const port = new InlineExecutionPort();
    const dir = await mkdtemp(join(tmpdir(), 'synth-bg-secret-'));
    const out = join(dir, 'key-path');
    try {
      const bg = await port.spawnBackground({
        command: { kind: 'shell', command: `${PRINT_KEY_PATH} > ${out}; sleep 30` },
        secrets: [{ kind: 'ssh-key', privateKey: PRIVATE_KEY }],
        timeoutMs: 300,
      });
      const keyPath = (await waitForFile(out)).trim();
      expect(keyPath).toContain('synth-ssh-');
      // Пока процесс жив — ключ на месте.
      expect(await exists(keyPath)).toBe(true);

      const exit = await bg.exited;
      expect(exit.signal).not.toBeNull();
      // Процесс остановлен по таймауту — материал убран.
      expect(await exists(keyPath)).toBe(false);
      expect(await exists(dirname(keyPath))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Сбой подготовки материала — **типовая** ошибка порта (`ExecutionError`,
   * `reason: 'spawn_failed'`), как и остальные сбои запуска: сырой
   * `SshEnvError` наружу не отдаётся (текст — без материала).
   */
  it('ошибка подготовки секретов — ExecutionError (spawn_failed), а не сырой SshEnvError', async () => {
    const port = new InlineExecutionPort();
    await expect(
      port.spawnBackground({
        command: { kind: 'shell', command: 'sleep 30' },
        // Ключ не строка — запись файла падает (подготовка материала срывается).
        secrets: [{ kind: 'ssh-key', privateKey: undefined as unknown as string }],
      }),
    ).rejects.toMatchObject({ name: 'ExecutionError', reason: 'spawn_failed' });
  });
});

describe.skipIf(!AGENT_TOOLS_AVAILABLE)(
  'inline-порт: секрет вызова в режиме агента (фон)',
  () => {
    it('SSH_AUTH_SOCK в окружении фонового процесса; после stop() агент мёртв, каталог удалён', async () => {
      const privateKey = await generateKey();
      const port = new InlineExecutionPort();
      const dir = await mkdtemp(join(tmpdir(), 'synth-bg-agent-'));
      const out = join(dir, 'agent-env');
      try {
        const bg = await port.spawnBackground({
          command: {
            kind: 'shell',
            command: `printf "%s|%s" "$SSH_AUTH_SOCK" "$SSH_AGENT_PID" > ${out}; sleep 30`,
          },
          secrets: [{ kind: 'ssh-key', privateKey, mode: 'agent' }],
        });

        const raw = await waitForFile(out);
        const [sock, pidRaw] = raw.split('|');
        expect(sock).toContain('synth-ssh-');
        const pid = Number(pidRaw);
        expect(Number.isInteger(pid)).toBe(true);
        expect(pid).toBeGreaterThan(0);

        const materialDir = dirname(sock!);
        // Файла ключа нет: материал остался только в памяти агента.
        expect(await exists(join(materialDir, 'key'))).toBe(false);
        // Пока процесс жив — агент жив.
        expect(() => process.kill(pid, 0)).not.toThrow();

        bg.stop();
        await bg.exited;

        // Агент не в группе процессов команды — гасится явной очисткой.
        expect(await waitProcessGone(pid)).toBe(true);
        expect(await exists(materialDir)).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('агент гасится и после естественного выхода фонового процесса', async () => {
      const privateKey = await generateKey();
      const port = new InlineExecutionPort();
      const dir = await mkdtemp(join(tmpdir(), 'synth-bg-agent-'));
      const out = join(dir, 'agent-env');
      try {
        const bg = await port.spawnBackground({
          command: {
            kind: 'shell',
            command: `printf "%s|%s" "$SSH_AUTH_SOCK" "$SSH_AGENT_PID" > ${out}`,
          },
          secrets: [{ kind: 'ssh-key', privateKey, mode: 'agent' }],
        });
        const raw = await waitForFile(out);
        const [sock, pidRaw] = raw.split('|');
        const pid = Number(pidRaw);

        const exit = await bg.exited;
        expect(exit.exitCode).toBe(0);
        // К моменту резолва `exited` материал уже убран.
        expect(await exists(dirname(sock!))).toBe(false);
        expect(await waitProcessGone(pid)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    /**
     * Агент не поднялся (`ssh-add` не смог добавить ключ) — фон не запускается,
     * наружу уходит **типовая** ошибка порта (`ExecutionError`,
     * `reason: 'spawn_failed'`), а не сырой `SshEnvError`; текст — без
     * материала.
     */
    it('агент не поднялся — ExecutionError (spawn_failed), текст без материала', async () => {
      const port = new InlineExecutionPort();
      const secret = 'материал-не-уходит-в-ошибку';
      let caught: unknown;
      try {
        await port.spawnBackground({
          command: { kind: 'shell', command: 'sleep 30' },
          secrets: [{ kind: 'ssh-key', privateKey: secret, mode: 'agent' }],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { name?: string }).name).toBe('ExecutionError');
      expect((caught as { reason?: string }).reason).toBe('spawn_failed');
      expect(String((caught as Error).message)).not.toContain(secret);
    });
  },
);
