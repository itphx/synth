// Обёртка дочернего процесса в контейнере исполнителя.
//
// Исполнитель — тот, кто массово порождает процессы (shell-команды агентских
// тулов, фоновые прогоны, MCP-серверы), поэтому «кто жнёт зомби» здесь
// критично: без пожинания осиротевших детей зомби копятся, занимают слоты PID
// и ломают проверку «процесс ещё жив» (`kill(pid, 0)` успешен для зомби).
// Пожинать умеет только PID 1 — это sh-скрипт `docker/init.sh` (`synth-init`),
// а эта обёртка его дочерний процесс (см. ниже «Reaping»).
//
// Что делает обёртка:
//   1. запускает `node dist/main.js` (тот же `process.execPath`, тот же argv/env,
//      тот же cwd) в **отдельной process group** (`detached: true`) — сигнал
//      можно отправить всей группе (`kill(-pid)`), а не только шефу;
//   2. пробрасывает SIGTERM/SIGINT/SIGHUP группе дочернего процесса (Docker и
//      K8s шлют сигнал только PID 1; по SIGTERM исполнитель штатно гасит
//      фоновые процессы и закрывает сервер, см. `main.ts`);
//   3. ждёт завершения ребёнка и выходит с **тем же кодом** — включая 128+N при
//      гибели от сигнала; супервизор видит исходный код, а не код обёртки;
//   4. ошибка запуска/отсутствие цели — код 1 и понятная строка в stderr.
//
// Reaping осиротевших детей обёртка не делает и делать не может: пожинать
// умеет только PID 1, а Node/libuv ждёт лишь pid'ы своих child-handle'ов
// (`waitpid(process->pid)`), поэтому усыновлённые сироты остаются зомби.
// В контейнере PID 1 — sh-скрипт `docker/init.sh` (`synth-init`), эта
// обёртка — его дочерний процесс (см. шапку `docker/Dockerfile.executor`).
//
// `SYNTH_INIT_ENTRY` переопределяет цель запуска — только для тестов и ручной
// отладки (в образе он не задаётся, дефолт — `dist/main.js` рядом с обёрткой).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Сигналы, которые обёртка пересылает дочернему процессу (вся группа). */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/**
 * Код выхода по сигналу — как у оболочки: 128 + номер сигнала
 * (SIGKILL → 137, SIGTERM → 143). `undefined` — сигнал неизвестен.
 */
function signalExitCode(signal: NodeJS.Signals): number {
  const number = constants.signals[signal];
  return typeof number === 'number' ? 128 + number : 1;
}

/** Скрипт-цель: `dist/main.js` рядом с обёрткой (или `SYNTH_INIT_ENTRY`). */
function resolveEntry(): string {
  const override = process.env.SYNTH_INIT_ENTRY?.trim();
  if (override !== undefined && override.length > 0) return resolve(process.cwd(), override);
  return join(dirname(fileURLToPath(import.meta.url)), 'main.js');
}

function main(): void {
  const entry = resolveEntry();
  if (!existsSync(entry)) {
    // Внятная причина вместо стектрейса node «Cannot find module»: в образе
    // цель — `dist/main.js` рядом с обёрткой, её отсутствие = битая сборка.
    console.error(`[init] цель запуска не найдена: ${entry}`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    // Своя process group (setsid): `kill(-pid, sig)` накрывает и потомков,
    // оставшихся от дочернего процесса (фоновые команды, MCP-серверы).
    detached: true,
  });

  const forward = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Группы уже нет (ребёнок завершился) — нечего пересылать.
    }
  };

  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => forward(signal));
  }

  child.on('error', (err: Error) => {
    console.error(`[init] не удалось запустить ${entry}: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    // Код ребёнка сохраняется как есть; гибель от сигнала — 128+N, как в оболочке.
    process.exit(code ?? (signal === null ? 1 : signalExitCode(signal)));
  });
}

main();
