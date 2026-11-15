/**
 * Проба «что сейчас на переднем плане PTY-сессии» (протокол исполнителя 9).
 *
 * ## Зачем
 *
 * Сервису терминалов нужно **надёжно** знать, в фокусе оболочка или другая
 * программа (`ssh`, `vim`, `top`, …): по этому решению (а) разрешаются пути
 * вне каталога в ssh-сессиях, (б) детектится полноэкранное приложение
 * (`terminal_run` не должен вставлять команду поверх `vim`). Эвристики по
 * потоку вывода (альтернативный экран, перерисовки) ошибаются; факт из ядра
 * ОС — терминал-группа процессов переднего плана — не ошибается.
 *
 * ## Linux: `/proc`
 *
 * - `/proc/<shellPid>/stat`, поле 8 — `tpgid` (pgid переднего плана
 *   терминала этой сессии). Парсинг — **после последней `)`**: `comm`
 *   (поле 2) может содержать пробелы и скобки, наивный `split(' ')` сдвинул
 *   бы все поля;
 * - `tpgid <= 0` — терминала нет/фокуса нет ⇒ считаем, что в фокусе оболочка;
 * - `tpgid === shellPid` — в фокусе сама оболочка (`command` — её `comm`);
 * - иначе ищем процесс с `pgrp == tpgid` (поле 5, скан всех `/proc/<pid>/stat`)
 *   и отдаём его `comm`.
 *
 * ## Fallback (нет `/proc`, macOS)
 *
 * `ps -o tpgid= -p <pid>` и `ps -eo pgid=,comm=`; сравнение — в JS.
 *
 * ## Fail-open
 *
 * Любая ошибка → `null`: вызывающий сам решает, что делать (обычно —
 * работать по прежнему поведению). Проба не бросает и не логирует.
 */

import { execFile } from 'node:child_process';
import { readFile as readFileAsync, readdir as readdirAsync } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PtyForeground } from '../ports/execution-port.js';

/** Зависимости пробы (тесты подставляют подделки — реальный `/proc` не нужен). */
export interface ForegroundProbeDeps {
  /** Прочитать файл (по умолчанию — `node:fs/promises`). */
  readFile?: (path: string) => Promise<string>;
  /** Прочитать каталог (по умолчанию — `node:fs/promises`). */
  readdir?: (path: string) => Promise<string[]>;
  /** Выполнить `ps` с аргументами и вернуть stdout (по умолчанию — `execFile`). */
  execPs?: (args: string[]) => Promise<string>;
}

/** Разобранная запись `/proc/<pid>/stat` — только нужные поля. */
interface ProcStat {
  /** `comm` процесса (поле 2, имя в скобках). */
  comm: string;
  /** `pgrp` (поле 5) — группа процессов. */
  pgrp: number;
  /** `tpgid` (поле 8) — pgid переднего плана терминала. */
  tpgid: number;
}

/**
 * Разобрать `/proc/<pid>/stat`.
 *
 * `comm` берётся между **первой** `(` и **последней** `)`; остальные поля —
 * whitespace-разбиение хвоста. Остаток: индекс 0 — `state` (поле 3),
 * 1 — `ppid` (4), 2 — `pgrp` (5), …, 5 — `tpgid` (8).
 */
function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const comm = text.slice(open + 1, close);
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const pgrp = Number(rest[2]);
  const tpgid = Number(rest[5]);
  if (!Number.isInteger(pgrp) || !Number.isInteger(tpgid)) return null;
  return { comm, pgrp, tpgid };
}

/** Прочитать `/proc` через `node:fs/promises`. */
function defaultReadFile(path: string): Promise<string> {
  return readFileAsync(path, 'utf-8');
}

/** Прочитать каталог через `node:fs/promises`. */
function defaultReaddir(path: string): Promise<string[]> {
  return readdirAsync(path);
}

/**
 * Выполнить `ps` (без shell) и вернуть stdout.
 *
 * Потолок вывода небольшой: `ps -eo` на машине с тысячами процессов всё
 * равно укладывается в сотни килобайт, а больший буфер означал бы, что проба
 * держит память ради данных, которые отбрасываются.
 */
function defaultExecPs(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('ps', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Имя процесса из поля `comm`: в Linux это короткое имя, в macOS `comm` —
 * путь. Приводим к имени без каталога, чтобы `command` имел один смысл на
 * обеих платформах.
 */
function commandName(comm: string): string {
  const trimmed = comm.trim();
  if (trimmed.length === 0) return '';
  return basename(trimmed);
}

/**
 * Проба через `/proc` (Linux).
 *
 * @returns результат пробы или `undefined`, если `/proc` недоступен/нечитаем
 *          (тогда вызывающий пробует `ps`)
 */
async function inspectViaProc(
  shellPid: number,
  readFile: (path: string) => Promise<string>,
  readdir: (path: string) => Promise<string[]>,
): Promise<PtyForeground | null | undefined> {
  let shellStat: ProcStat | null;
  try {
    shellStat = parseProcStat(await readFile(`/proc/${shellPid}/stat`));
  } catch {
    // `/proc` нет (не Linux) — пробуем `ps`.
    return undefined;
  }
  if (!shellStat) return undefined;

  const tpgid = shellStat.tpgid;
  // Нет терминала/фокуса: считать, что в фокусе оболочка, безопасно — обёрнутая
  // команда уйдёт в оболочку, а полноэкранного приложения там нет.
  if (tpgid <= 0) return { shellPid, isShell: true };
  if (tpgid === shellPid) {
    return {
      shellPid,
      foregroundPgid: tpgid,
      command: commandName(shellStat.comm),
      isShell: true,
    };
  }

  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return { shellPid, foregroundPgid: tpgid, isShell: false };
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: ProcStat | null;
    try {
      stat = parseProcStat(await readFile(`/proc/${entry}/stat`));
    } catch {
      // Процесс завершился между readdir и чтением — норма.
      continue;
    }
    if (!stat || stat.pgrp !== tpgid) continue;
    return {
      shellPid,
      foregroundPgid: tpgid,
      command: commandName(stat.comm),
      isShell: false,
    };
  }
  // Процесс группы не найден (гонка с выходом): pgid известен, имени нет.
  return { shellPid, foregroundPgid: tpgid, isShell: false };
}

/**
 * Проба через `ps` (fallback: нет `/proc`, macOS).
 *
 * Формат `-eo pgid=,comm=` — pgid первым числом, остаток строки — `comm`
 * (может содержать пробелы, поэтому режем только по первому пробелу).
 */
async function inspectViaPs(
  shellPid: number,
  execPs: (args: string[]) => Promise<string>,
): Promise<PtyForeground | null> {
  try {
    const tpgidRaw = (await execPs(['-o', 'tpgid=', '-p', String(shellPid)])).trim();
    const tpgid = Number(tpgidRaw);
    if (tpgidRaw.length === 0 || !Number.isInteger(tpgid)) return null;
    // `<= 0` — терминала/фокуса нет (как у `/proc`): в фокусе оболочка.
    if (tpgid <= 0) return { shellPid, isShell: true };

    const table = await execPs(['-eo', 'pgid=,comm=']);
    let shellCommand: string | undefined;
    let foregroundCommand: string | undefined;
    for (const line of table.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const pgid = Number(match[1]);
      const name = commandName(match[2] as string);
      if (pgid === shellPid) shellCommand ??= name;
      if (pgid === tpgid) foregroundCommand ??= name;
    }
    if (tpgid === shellPid) {
      return {
        shellPid,
        foregroundPgid: tpgid,
        ...(shellCommand !== undefined ? { command: shellCommand } : {}),
        isShell: true,
      };
    }
    return {
      shellPid,
      foregroundPgid: tpgid,
      ...(foregroundCommand !== undefined ? { command: foregroundCommand } : {}),
      isShell: false,
    };
  } catch {
    return null;
  }
}

/**
 * Определить, что сейчас на переднем плане PTY-сессии.
 *
 * @param shellPid pid оболочки — лидер PTY-сессии (`PtyHandle.pid`)
 * @param deps подмена ввода-вывода (тесты); не заданы — реальные `/proc`/`ps`
 * @returns факт о переднем плане или `null` (неизвестно/ошибка)
 */
export async function inspectForeground(
  shellPid: number | undefined,
  deps?: ForegroundProbeDeps,
): Promise<PtyForeground | null> {
  if (shellPid === undefined || !Number.isInteger(shellPid) || shellPid <= 0) return null;
  const readFile = deps?.readFile ?? defaultReadFile;
  const readdir = deps?.readdir ?? defaultReaddir;
  const execPs = deps?.execPs ?? defaultExecPs;

  try {
    const viaProc = await inspectViaProc(shellPid, readFile, readdir);
    if (viaProc !== undefined) return viaProc;
  } catch {
    // Проба не должна бросать: ниже — `ps`, затем `null`.
  }
  try {
    return await inspectViaPs(shellPid, execPs);
  } catch {
    return null;
  }
}
