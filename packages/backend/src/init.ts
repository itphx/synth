// Обёртка дочернего процесса в контейнере backend (вторая ступень после
// sh-инициализатора `docker/init.sh`, см. ниже «Чего обёртка НЕ делает»).
//
// Зачем обёртка. С `CMD ["node","dist/main.js"]` приложение само становится
// PID 1 (в Docker/K8s это первый процесс, у которого нет родителя). PID 1
// обязан **пожинать** осиротевших детей (`waitpid`): иначе завершившиеся
// процессы остаются зомби, занимают слоты PID и ломают `kill(pid, 0)` —
// «процесс ещё жив» для давно мёртвого (аудит 0.13.4 §5.2: 38–42 зомби и
// падающие abort-тесты).
//
// Что делает обёртка:
//   1. запускает `node dist/main.js` (тот же `process.execPath`, тот же argv/env,
//      тот же cwd) в **отдельной process group** (`detached: true`) — поэтому
//      сигнал можно отправить всей группе (`kill(-pid)`), а не только шефу;
//   2. пробрасывает SIGTERM/SIGINT/SIGHUP группе дочернего процесса (Docker и
//      K8s шлют сигнал только PID 1 — сама обёртка);
//   3. ждёт завершения ребёнка и выходит с **тем же кодом** — включая 75
//      (graceful restart, ADR-092 п. 7 / инвариант 24) и 128+N при гибели от
//      сигнала; супервизор (Docker `restart`/K8s `restartPolicy`) видит
//      исходный код, а не код обёртки;
//   4. ошибка запуска/отсутствие цели — код 1 и понятная строка в stderr.
//
// Чего обёртка НЕ делает — reaping. Пожинать осиротевших детей умеет только
// PID 1, и для этого нужен `waitpid(-1)`; Node/libuv так не может: libuv ждёт
// лишь pid'ы своих child-handle'ов (`waitpid(process->pid)`), а усыновлённые
// сироты остаются зомби. Поэтому в контейнере PID 1 — sh-скрипт
// `docker/init.sh` (`synth-init`), а эта обёртка — его дочерний процесс
// (см. шапку `docker/Dockerfile.backend`).
//
// Это **не** замена graceful shutdown приложения: SIGTERM доходит до main.js,
// и тот закрывает сервер/очередь как раньше (см. `main.ts`).
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
    // оставшихся от дочернего процесса (`sh -c '… &'`, обёртки команд).
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
    // Код ребёнка сохраняется как есть (75 — рестарт, 0 — штатный выход);
    // гибель от сигнала переводится в 128+N, как в оболочке.
    process.exit(code ?? (signal === null ? 1 : signalExitCode(signal)));
  });
}

main();
