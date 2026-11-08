// PID 1-обёртка backend (`src/init.ts`): проброс сигналов, код выхода, группа
// процессов. Тест детерминированный и без контейнера: обёртка запускается
// отдельным процессом node (через tsx — тесты идут из исходников, не из dist),
// а «приложением» служит временный fixture-скрипт.

import { describe, expect, it } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(SRC_DIR, '..');
const INIT_ENTRY = join(SRC_DIR, 'init.ts');
/** PID 1-скрипт образа (`sh`-инициализатор, reaping + проброс). */
const SHELL_INIT = join(SRC_DIR, '..', '..', '..', 'docker', 'init.sh');

/** Пауза (держит event loop — ожидание теста). */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Запуск обёртки: `node --import tsx src/init.ts`, цель — `SYNTH_INIT_ENTRY`. */
function startWrapper(entry: string, env: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', INIT_ENTRY], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, SYNTH_INIT_ENTRY: entry, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Код выхода процесса (обёртка всегда выходит сама, не по сигналу). */
function waitExit(child: ChildProcess, limitMs = 10_000): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`обёртка не завершилась за ${limitMs} мс`)),
      limitMs,
    );
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Собранный stderr процесса (для проверки понятной ошибки). */
function collectStderr(child: ChildProcess): () => string {
  let text = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf-8');
  });
  return () => text;
}

/** Дождаться файла с pid (fixture пишет его до ожидания сигнала). */
async function waitPidFile(path: string, deadlineMs = 5_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const pid = Number((await readFile(path, 'utf-8')).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Файла ещё нет — ждём.
    }
    if (Date.now() > deadline) throw new Error(`не дождались pid в ${path}`);
    await delay(20);
  }
}

/** Дождаться исчезновения процесса: `kill(pid, 0)` бросает `ESRCH`. */
async function waitProcessGone(pid: number, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
    if (Date.now() > deadline) throw new Error(`процесс ${pid} остался жив`);
    await delay(20);
  }
}

/** Fixture: живёт до SIGTERM, внук остаётся жить (его гасит группа). */
const CHILD_WITH_GRANDCHILD = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
});
writeFileSync(process.env.INIT_TEST_GRANDCHILD_PID, String(grandchild.pid));

process.on('SIGTERM', () => {
  // Внука НЕ убиваем: сигнал должен дойти до него в составе process group.
  setTimeout(() => process.exit(75), 20);
});
setInterval(() => {}, 1000);
`;

describe('PID 1-обёртка backend (src/init.ts)', () => {
  it('пересылает SIGTERM группе и выходит с кодом дочернего процесса (75)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-init-'));
    const fixture = join(dir, 'child.mjs');
    const pidFile = join(dir, 'grandchild.pid');
    await writeFile(fixture, CHILD_WITH_GRANDCHILD, 'utf-8');

    const wrapper = startWrapper(fixture, { INIT_TEST_GRANDCHILD_PID: pidFile });
    try {
      const grandchildPid = await waitPidFile(pidFile);
      // Docker/K8s шлют SIGTERM только PID 1 — то есть самой обёртке.
      wrapper.kill('SIGTERM');
      expect(await waitExit(wrapper)).toBe(75);
      // Внук не обрабатывал SIGTERM сам — погиб от проброса в группу.
      await waitProcessGone(grandchildPid);
    } finally {
      wrapper.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('выходит с кодом дочернего процесса при штатном завершении (0)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-init-'));
    const fixture = join(dir, 'child.mjs');
    await writeFile(fixture, 'process.exit(0);\n', 'utf-8');

    const wrapper = startWrapper(fixture);
    try {
      expect(await waitExit(wrapper)).toBe(0);
    } finally {
      wrapper.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('переводит гибель дочернего процесса по сигналу в 128+N (SIGKILL → 137)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-init-'));
    const fixture = join(dir, 'child.mjs');
    await writeFile(fixture, "process.kill(process.pid, 'SIGKILL');\n", 'utf-8');

    const wrapper = startWrapper(fixture);
    try {
      expect(await waitExit(wrapper)).toBe(137);
    } finally {
      wrapper.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('отсутствующая цель запуска — код 1 и понятное сообщение в stderr', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-init-'));
    const missing = join(dir, 'нет-такого-файла.mjs');

    const wrapper = startWrapper(missing);
    const stderr = collectStderr(wrapper);
    try {
      expect(await waitExit(wrapper)).toBe(1);
      expect(stderr()).toContain('цель запуска не найдена');
    } finally {
      wrapper.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

// PID 1 в образе — не Node-обёртка, а `docker/init.sh` (reaping осиротевших
// детей умеет только `waitpid(-1)`, то есть только шелл/init; libuv ждёт лишь
// pid'ы своих handle'ов). Полная цепочка образа — init.sh → init.ts → main.js;
// сам reaping проверяется в контейнере (PID namespace тесту недоступен),
// здесь — проброс сигнала и кода выхода через обе ступени.
describe('PID 1-инициализатор образа (docker/init.sh)', () => {
  function startShellInit(args: string[], env: Record<string, string>): ChildProcess {
    // `/bin/sh <script>` — без зависимости от executable-бита файла.
    return spawn('/bin/sh', [SHELL_INIT, ...args], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  it('пробрасывает SIGTERM цепочке и выходит с кодом приложения (75)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-init-'));
    const fixture = join(dir, 'child.mjs');
    const pidFile = join(dir, 'grandchild.pid');
    await writeFile(fixture, CHILD_WITH_GRANDCHILD, 'utf-8');

    const shellInit = startShellInit(['node', INIT_ENTRY], {
      SYNTH_INIT_ENTRY: fixture,
      INIT_TEST_GRANDCHILD_PID: pidFile,
    });
    try {
      const grandchildPid = await waitPidFile(pidFile);
      // Docker/K8s шлют SIGTERM только PID 1 — то есть sh-инициализатору.
      shellInit.kill('SIGTERM');
      expect(await waitExit(shellInit)).toBe(75);
      // Сигнал дошёл до группы через Node-ступень: внук погашен.
      await waitProcessGone(grandchildPid);
    } finally {
      shellInit.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('без команды запуска — код 1 и подсказка в stderr', async () => {
    const shellInit = startShellInit([], {});
    const stderr = collectStderr(shellInit);
    try {
      expect(await waitExit(shellInit)).toBe(1);
      expect(stderr()).toContain('не задана команда запуска');
    } finally {
      shellInit.kill('SIGKILL');
    }
  }, 20_000);
});
