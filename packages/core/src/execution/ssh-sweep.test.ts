/**
 * Reaper каталогов SSH-материала (PROP-124 §2).
 *
 * Критерий уборки — «жив ли **владелец**» каталога (`owner.pid`), а не «жив ли
 * агент»: осиротевший агент (владелец мёртв) гасится, а каталог живого
 * владельца не трогается никогда (длинный фоновый прогон не теряет ключ).
 *
 * Тесты работают на **изолированном** корне (`rootDir`): уборка не должна
 * трогать каталоги других процессов на той же машине.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessStartTime, SSH_OWNER_PID_FILE, SSH_TEMP_DIR_PREFIX } from '../git/ssh-env.js';
import { sweepStaleSshDirs } from './ssh-sweep.js';

/** Каталоги, созданные тестом (убираются после каждого теста). */
const created: string[] = [];

/** Изолированный корень уборки. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'synth-sweep-root-'));
  created.push(root);
  return root;
}

/** Каталог материала в изолированном корне. */
async function makeMaterialDir(root: string, name: string): Promise<string> {
  const dir = join(root, `${SSH_TEMP_DIR_PREFIX}${name}`);
  await mkdir(dir, { recursive: true });
  created.push(dir);
  return dir;
}

/** Существует ли путь. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** pid уже завершившегося процесса (заведомо мёртвый владелец). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return pid;
}

/** Жив ли процесс. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Живой процесс-долгожитель (вместо агента): один процесс, без потомков. */
function spawnSleeper(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  return {
    pid: child.pid!,
    stop: (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Процесс уже мёртв — не ошибка.
      }
    },
  };
}

/** Записать владельца каталога (pid + время старта). */
async function writeOwner(dir: string, pid: number, startTime: string | null): Promise<void> {
  await writeFile(join(dir, SSH_OWNER_PID_FILE), `${pid}\n${startTime ?? ''}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/** Записать pid агента. */
async function writeAgentPid(dir: string, pid: number): Promise<void> {
  await writeFile(join(dir, 'agent.pid'), String(pid), { encoding: 'utf-8', mode: 0o600 });
}

afterEach(async () => {
  for (const path of created.splice(0)) {
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
});

describe('reaper SSH-материала: критерий «жив ли владелец» (PROP-124 §2)', () => {
  it('владелец мёртв, агент жив — агент убит, каталог удалён', async () => {
    const root = await makeRoot();
    const dir = await makeMaterialDir(root, 'orphan');
    const agent = spawnSleeper();
    try {
      await writeOwner(dir, await deadPid(), null);
      await writeAgentPid(dir, agent.pid);
      // Каталог «свежий» — по возрасту он бы не убирался.
      expect(isAlive(agent.pid)).toBe(true);

      const removed = await sweepStaleSshDirs(60 * 60 * 1000, { rootDir: root });

      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await exists(dir)).toBe(false);
      // Осиротевший агент не должен жить с ключом в памяти.
      const deadline = Date.now() + 5_000;
      while (isAlive(agent.pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(isAlive(agent.pid)).toBe(false);
    } finally {
      agent.stop();
    }
  });

  it('владелец жив — каталог не тронут (даже старый)', async () => {
    const root = await makeRoot();
    const dir = await makeMaterialDir(root, 'live-owner');
    await writeOwner(dir, process.pid, readProcessStartTime(process.pid));
    await writeAgentPid(dir, await deadPid());
    // Каталог старше любого TTL — но владелец жив.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(dir, twoHoursAgo, twoHoursAgo);

    await sweepStaleSshDirs(60 * 60 * 1000, { rootDir: root });

    expect(await exists(dir)).toBe(true);
    expect(await exists(join(dir, SSH_OWNER_PID_FILE))).toBe(true);
  });

  it('pid владельца переиспользован (не совпало время старта) — каталог убран', async () => {
    const root = await makeRoot();
    const dir = await makeMaterialDir(root, 'reused-pid');
    // pid живого процесса, но время старта — чужое: значит pid переиспользован.
    await writeOwner(dir, process.pid, '123456789');

    await sweepStaleSshDirs(60 * 60 * 1000, { rootDir: root });

    expect(await exists(dir)).toBe(false);
  });

  it('каталог без владельца (git-режим) убирается по возрасту', async () => {
    const root = await makeRoot();
    const dir = await makeMaterialDir(root, 'legacy');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(dir, twoHoursAgo, twoHoursAgo);

    const removed = await sweepStaleSshDirs(60 * 60 * 1000, { rootDir: root });

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await exists(dir)).toBe(false);
  });

  it('каталог без владельца с живым агентом — не трогаем', async () => {
    const root = await makeRoot();
    const dir = await makeMaterialDir(root, 'legacy-live-agent');
    const agent = spawnSleeper();
    try {
      await writeAgentPid(dir, agent.pid);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(dir, twoHoursAgo, twoHoursAgo);

      await sweepStaleSshDirs(60 * 60 * 1000, { rootDir: root });

      expect(await exists(dir)).toBe(true);
      expect(isAlive(agent.pid)).toBe(true);
    } finally {
      agent.stop();
    }
  });
});
