import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { warning } from '../logger.js';
import type { ExecSecret } from '../execution/ports/index.js';

/**
 * ADR-076 §T3: подготовка SSH-окружения для git (ключа `GIT_SSH_COMMAND`).
 *
 * Приватный ключ пишется во временный файл `0600` в каталоге `0700`
 * (`mkdtemp` в `os.tmpdir()`); при наличии `passphrase` там же создаётся
 * исполняемый askpass-скрипт `0700`, который отдаёт ровно passphrase
 * (`base64`, чтобы не зависеть от кавычек/спецсимволов). `cleanup` идемпотентно
 * удаляет каталог вместе с ключом и скриптом.
 *
 * ## Режим агента (PROP-124 §2)
 *
 * `agent: true` — **другой транспорт того же ключа**: вместо файла в
 * `GIT_SSH_COMMAND` поднимается эфемерный `ssh-agent` на время вызова:
 *
 * 1. каталог `0700`, ключ `0600` — как в git-режиме;
 * 2. `ssh-agent -a <dir>/agent.sock` (сокет в том же каталоге; каталог `0700`,
 *    сам агент проверяет peer-uid);
 * 3. `ssh-add <key>` — с passphrase через тот же askpass-механизм
 *    (`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`), без passphrase — без askpass;
 * 4. **ключ и askpass-скрипт удаляются сразу после успешного `ssh-add`**:
 *    приватный материал остаётся только в памяти агента и недоступен
 *    процессам вызова (строго лучше git-пути, где файл живёт весь вызов);
 * 5. env вызова — `SSH_AUTH_SOCK` (+ `SSH_AGENT_PID`); `GIT_SSH_COMMAND` **не
 *    ставится** (`IdentitiesOnly=yes` несовместим с agent-идентичностями);
 * 6. **владелец каталога** — `owner.pid` (pid процесса, создавшего агента, и
 *    время старта из `/proc/<pid>/stat`, best-effort): по нему reaper
 *    (`execution/ssh-sweep.ts`) понимает, чей это агент;
 * 7. `cleanup` — **жёсткое** завершение агента (`SIGTERM` → ожидание смерти
 *    → `SIGKILL` → ожидание; агент демонизируется и сам не умирает) + `rm -rf`
 *    каталога.
 *
 * Ошибка на любом шаге → `SshEnvError('agent_failed')`; **гарантированный
 * cleanup** (агент гасится, каталог убирается). Тексты ошибок не содержат ни
 * ключа, ни passphrase.
 *
 * Механизм общий для inline и remote: точкой исполнения в remote-режиме
 * является исполнитель, который вызывает эту же функцию из core (динамический
 * `import()`), — дублирования нет.
 */

/** SSH-URL: scp-подобный (`git@host:path`) либо `ssh://`. */
export function isSshUrl(url: string): boolean {
  return url.startsWith('git@') || url.startsWith('ssh://');
}

export type SshEnvErrorCode = 'env_failed' | 'agent_failed';

/**
 * Типизированная ошибка подготовки SSH-окружения (FS/permissions при создании
 * временного ключа/askpass-скрипта). `passphrase` теперь поддержан через
 * `SSH_ASKPASS_REQUIRE=force`.
 *
 * `agent_failed` — сбой режима агента (PROP-124 §2): не удалось запустить
 * `ssh-agent`, не разобрался pid, не появился сокет или `ssh-add` вернул
 * ненулевой код.
 */
export class SshEnvError extends Error {
  constructor(
    readonly code: SshEnvErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SshEnvError';
  }
}

export interface CreateSshEnvOptions {
  privateKey: string;
  passphrase?: string;
  /**
   * Режим доставки ключа (PROP-124 §2).
   *
   * - `false` (по умолчанию) — **git-режим**: ключ файлом + `GIT_SSH_COMMAND`
   *   (поведение прежнее, байт в байт);
   * - `true` — **agent-режим**: эфемерный `ssh-agent` на время вызова,
   *   `SSH_AUTH_SOCK` в env, приватный ключ удаляется с диска сразу после
   *   `ssh-add`.
   */
  agent?: boolean;
  /**
   * Таймауты эскалации гашения агента (мс) — параметризуются (тесты).
   *
   * Дефолты: `SIGTERM` → ожидание 2 с → `SIGKILL` → ожидание 1 с (итого
   *cleanup не висит дольше ~3–4 с).
   */
  agentKill?: ProcessKillTimeouts;
}

/**
 * Таймауты эскалации гашения процесса (PROP-124 §2).
 *
 * Агент (`ssh-agent -a`) **демонизируется**: свой SID, reparent к init — он не
 * в группе процессов Node и не умирает вместе с создателем. Поэтому одного
 * `SIGTERM` мало: процесс может его игнорировать, и тогда ключ остаётся в
 * памяти агента навсегда.
 */
export interface ProcessKillTimeouts {
  /** Ожидание смерти после `SIGTERM`, мс (по умолчанию — 2000). */
  termGraceMs?: number;
  /** Ожидание смерти после `SIGKILL`, мс (по умолчанию — 1000). */
  killGraceMs?: number;
  /** Период опроса живости процесса, мс (по умолчанию — 50). */
  pollMs?: number;
}

/** Ожидание смерти после `SIGTERM` по умолчанию, мс. */
const DEFAULT_TERM_GRACE_MS = 2_000;

/** Ожидание смерти после `SIGKILL` по умолчанию, мс. */
const DEFAULT_KILL_GRACE_MS = 1_000;

/** Период опроса живости процесса по умолчанию, мс. */
const DEFAULT_POLL_MS = 50;

/** Префикс временных каталогов SSH-материала (общий с исполнителем). */
export const SSH_TEMP_DIR_PREFIX = 'synth-ssh-';

/**
 * Имя файла с данными владельца каталога материала.
 *
 * Владелец — процесс, создавший агента (pid + время старта). По нему reaper
 * (`execution/ssh-sweep.ts`) отличает «агент жив, но владелец мёртв» (осиротевший
 * агент — гасим) от «владелец жив» (каталог не трогаем никогда: длинный фоновый
 * прогон не должен терять ключ).
 */
export const SSH_OWNER_PID_FILE = 'owner.pid';

/** Данные владельца каталога материала. */
export interface SshOwnerInfo {
  /** pid процесса-владельца. */
  pid: number;
  /**
   * Время старта процесса (`/proc/<pid>/stat`, поле 22) — если доступно.
   *
   * Нужен, чтобы отличить переиспользованный pid от прежнего владельца: pid
   * один и тот же, а процесс уже другой.
   */
  startTime: string | null;
}

/**
 * Жив ли процесс (`process.kill(pid, 0)`).
 *
 * `EPERM` — процесс есть, но прав нет: это тоже «жив» (гасить не сможем, но
 * и считать мёртвым нельзя).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Пауза (таймер без `unref`: cleanup ждёт её — процесс не должен «зависнуть»). */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Дождаться смерти процесса (опрос `kill(pid, 0)` каждые `pollMs`).
 *
 * @returns `true` — процесс мёртв.
 */
export async function waitProcessGone(
  pid: number,
  timeoutMs: number,
  pollMs: number = DEFAULT_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Гасить процесс **наверняка**: `SIGTERM` → ожидание смерти → `SIGKILL` →
 * ожидание смерти.
 *
 * Агент демонизируется и может игнорировать `SIGTERM` — без эскалации он
 * остался бы жить с ключом в памяти. Суммарное ожидание ограничено
 * (`termGraceMs` + `killGraceMs`), поэтому вызов не висит.
 *
 * @returns `true` — процесс мёртв; `false` — пережил `SIGKILL` (вызывающий
 *   решает, что делать — обычно пишет предупреждение).
 */
export async function terminateProcess(
  pid: number,
  opts: ProcessKillTimeouts = {},
): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  const termGraceMs = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Процесс уже завершён (или нет прав) — дальше только проверка живости.
  }
  if (await waitProcessGone(pid, termGraceMs, pollMs)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Нет прав на `SIGKILL` — процесс останется жить, сообщим об этом.
  }
  return waitProcessGone(pid, killGraceMs, pollMs);
}

/**
 * Время старта процесса (`/proc/<pid>/stat`, поле 22) — best-effort.
 *
 * На не-Linux или без доступа — `null`: тогда переиспользование pid не
 * отличить, и владельца считаем живым по самому pid (fail-safe: каталог живого
 * владельца лучше не трогать).
 */
export function readProcessStartTime(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // `comm` может содержать пробелы и скобки — режем по последней `)`.
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    // После `comm` идёт поле 3 (`state`); поле 22 (`starttime`) — 20-е оттуда.
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime ?? null;
  } catch {
    return null;
  }
}

/**
 * Записать владельца каталога материала (pid процесса + время старта).
 *
 * Best-effort: ошибка записи не должна ломать подготовку материала — тогда
 * каталог просто не будет иметь владельца и уберётся по возрасту.
 */
export async function writeSshOwner(dir: string): Promise<void> {
  const startTime = readProcessStartTime(process.pid);
  await writeFile(
    join(dir, SSH_OWNER_PID_FILE),
    `${process.pid}\n${startTime ?? ''}\n`,
    { encoding: 'utf-8', mode: 0o600 },
  );
}

/**
 * Прочитать владельца каталога материала.
 *
 * `null` — файла нет (git-режим, старая версия), он нечитаем или повреждён.
 */
export async function readSshOwner(dir: string): Promise<SshOwnerInfo | null> {
  try {
    const raw = await readFile(join(dir, SSH_OWNER_PID_FILE), 'utf-8');
    const [pidRaw, startRaw] = raw.split('\n');
    const pid = Number.parseInt((pidRaw ?? '').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const startTime = (startRaw ?? '').trim();
    return { pid, startTime: startTime.length > 0 ? startTime : null };
  } catch {
    return null;
  }
}

export interface SshEnv {
  /**
   * Переменные окружения вызова: `GIT_SSH_COMMAND` (git-режим) либо
   * `SSH_AUTH_SOCK`/`SSH_AGENT_PID` (agent-режим).
   */
  env: Record<string, string>;
  /** Идемпотентная очистка (удаление материала; в agent-режиме — и агента). */
  cleanup: () => Promise<void>;
}

/**
 * Раскрытый SSH-ключ → секрет вызова (`ExecSecret`, ADR-077 протокол 4).
 *
 * Чистая функция: **ничего не пишет на диск**. Ключ уезжает в порт
 * исполнения как значение, а материал (файл `0600` в каталоге `0700`)
 * готовит **точка исполнения** — иначе путь control plane в контейнере
 * исполнителя не существует (ADR-077, «Обновлено 2026-10-26», (б)).
 *
 * `mode` — режим доставки ключа (PROP-124 §2): `git` (по умолчанию) —
 * файл ключа + `GIT_SSH_COMMAND`; `agent` — эфемерный `ssh-agent`
 * (`SSH_AUTH_SOCK`), приватный материал после `ssh-add` удаляется с диска.
 */
export function toSshSecret(
  revealed: { privateKey: string; passphrase?: string },
  mode?: 'git' | 'agent',
): ExecSecret {
  return {
    kind: 'ssh-key',
    privateKey: revealed.privateKey,
    ...(revealed.passphrase !== undefined ? { passphrase: revealed.passphrase } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

/**
 * Создаёт временный ключ и env для вызова.
 *
 * - **git-режим** (по умолчанию): `GIT_SSH_COMMAND`; ключ с `passphrase`
 *   получает `SSH_ASKPASS`-скрипт и `SSH_ASKPASS_REQUIRE=force` (без
 *   `BatchMode`, с `NumberOfPasswordPrompts=1`); ключ без passphrase —
 *   `BatchMode=yes` без askpass, как раньше. Сбой подготовки
 *   (FS/permissions) → `SshEnvError('env_failed')`.
 * - **agent-режим** (`agent: true`): эфемерный `ssh-agent`; сбой →
 *   `SshEnvError('agent_failed')`.
 */
export async function createSshEnv(opts: CreateSshEnvOptions): Promise<SshEnv> {
  if (opts.agent === true) return createSshAgentEnv(opts);
  return createGitSshEnv(opts);
}

/**
 * Git-режим: временный ключ + `GIT_SSH_COMMAND`.
 *
 * Поведение прежнее (регресс-тест `ssh-env.test.ts`): ключ живёт на диске
 * весь вызов, `cleanup` идемпотентно убирает каталог.
 */
async function createGitSshEnv(opts: CreateSshEnvOptions): Promise<SshEnv> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), SSH_TEMP_DIR_PREFIX));
  } catch (err) {
    throw new SshEnvError('env_failed', `Не удалось создать временный каталог SSH: ${(err as Error).message}`);
  }

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await chmod(dir, 0o700).catch(() => {});
    const keyPath = join(dir, 'key');
    await writeFile(keyPath, opts.privateKey, { encoding: 'utf-8', mode: 0o600 });
    await chmod(keyPath, 0o600).catch(() => {});

    const baseCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    const env: Record<string, string> = {};

    if (opts.passphrase) {
      const askpassPath = await writeAskpassScript(dir, opts.passphrase);
      env.SSH_ASKPASS = askpassPath;
      env.SSH_ASKPASS_REQUIRE = 'force';
      // BatchMode глушит askpass; NumberOfPasswordPrompts=1 — защита от зависания.
      env.GIT_SSH_COMMAND = `${baseCommand} -o NumberOfPasswordPrompts=1`;
    } else {
      env.GIT_SSH_COMMAND = `${baseCommand} -o BatchMode=yes`;
    }

    return { env, cleanup };
  } catch (err) {
    await cleanup();
    if (err instanceof SshEnvError) throw err;
    throw new SshEnvError('env_failed', `Не удалось подготовить SSH-окружение: ${(err as Error).message}`);
  }
}

/**
 * Agent-режим (PROP-124 §2): эфемерный `ssh-agent` на время вызова.
 *
 * Порядок: каталог `0700` → **владелец каталога** (`owner.pid`: pid процесса
 * и время старта — best-effort) → ключ `0600` → `ssh-agent -a <dir>/agent.sock`
 * → pid-файл агента в каталоге → `ssh-add` (askpass — при passphrase) →
 * удаление ключа и askpass-скрипта.
 *
 * Любая ошибка → `SshEnvError('agent_failed')` + гарантированный cleanup
 * (агент гасится **наверняка** — `SIGTERM` → `SIGKILL`, каталог убирается).
 */
async function createSshAgentEnv(opts: CreateSshEnvOptions): Promise<SshEnv> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), SSH_TEMP_DIR_PREFIX));
  } catch (err) {
    throw new SshEnvError('env_failed', `Не удалось создать временный каталог SSH: ${(err as Error).message}`);
  }

  let cleaned = false;
  let agentPid: number | undefined;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (agentPid !== undefined) {
      // Агент гасим по pid **наверняка**: `ssh-agent -a` демонизируется (свой
      // SID, reparent к init) — он не в группе процессов Node и не умирает
      // вместе с создателем. Один `SIGTERM` мог быть проигнорирован: тогда
      // ключ остался бы в памяти агента навсегда. Поэтому `SIGTERM` → ожидание
      // → `SIGKILL` → ожидание; пережил `SIGKILL` — предупреждение (без
      // материала) и продолжение: cleanup идемпотентен и не бросает.
      const gone = await terminateProcess(agentPid, opts.agentKill ?? {});
      if (!gone) {
        warning(
          'SSH',
          `ssh-agent не завершился после SIGKILL (pid ${agentPid}) — процесс остался жив`,
        );
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await chmod(dir, 0o700).catch(() => {});
    // Владелец каталога — по нему reaper поймёт, что агент осиротел (владелец
    // мёртв), и уберёт его. Запись — best-effort: без неё каталог просто
    // уберётся по возрасту.
    await writeSshOwner(dir).catch(() => {});
    const keyPath = join(dir, 'key');
    await writeFile(keyPath, opts.privateKey, { encoding: 'utf-8', mode: 0o600 });
    await chmod(keyPath, 0o600).catch(() => {});

    const sockPath = join(dir, SSH_AGENT_SOCKET);
    const pid = await startSshAgent(sockPath);
    // Pid известен до следующих шагов: сбой ниже обязан погасить агента.
    agentPid = pid;

    // pid-файл в каталоге материала — признак «агент жив» для sweep.
    await writeFile(join(dir, SSH_AGENT_PID_FILE), String(pid), { encoding: 'utf-8', mode: 0o600 });

    // Сокет обязан появиться: без него `SSH_AUTH_SOCK` невалиден.
    const sock = await stat(sockPath).catch(() => null);
    if (!sock) {
      throw new SshEnvError('agent_failed', 'ssh-agent не создал сокет');
    }

    const askpassPath = opts.passphrase ? await writeAskpassScript(dir, opts.passphrase) : undefined;

    const addEnv: NodeJS.ProcessEnv = { ...process.env, SSH_AUTH_SOCK: sockPath };
    if (askpassPath) {
      addEnv.SSH_ASKPASS = askpassPath;
      addEnv.SSH_ASKPASS_REQUIRE = 'force';
    }
    const added = await runTool('ssh-add', [keyPath], addEnv, SSH_ADD_TIMEOUT_MS);
    if (added.missing) {
      throw new SshEnvError('agent_failed', 'ssh-add недоступен в окружении исполнения');
    }
    if (added.code !== 0) {
      throw new SshEnvError(
        'agent_failed',
        `Не удалось добавить ключ в ssh-agent: код ${added.code}${stderrExcerpt(added.stderr)}`,
      );
    }

    // Материал больше не нужен: приватный ключ остаётся только в памяти агента.
    await unlink(keyPath).catch(() => {});
    if (askpassPath) await unlink(askpassPath).catch(() => {});

    return {
      env: { SSH_AUTH_SOCK: sockPath, SSH_AGENT_PID: String(pid) },
      cleanup,
    };
  } catch (err) {
    await cleanup();
    if (err instanceof SshEnvError) throw err;
    throw new SshEnvError('agent_failed', `Не удалось подготовить SSH-агент: ${(err as Error).message}`);
  }
}

/** Имя сокета агента в каталоге материала. */
export const SSH_AGENT_SOCKET = 'agent.sock';

/**
 * Имя файла с pid агента в каталоге материала.
 *
 * Признак «агент жив» для reaper'а (PROP-124 §2): каталог с живым агентом
 * нельзя удалять по возрасту — иначе длинный фоновый прогон теряет ключ.
 * Владелец каталога — `owner.pid` (см. `SSH_OWNER_PID_FILE`).
 */
export const SSH_AGENT_PID_FILE = 'agent.pid';

/** Таймаут запуска `ssh-agent`, мс. */
const SSH_AGENT_START_TIMEOUT_MS = 10_000;

/** Таймаут `ssh-add`, мс (защита от зависания на терминальном prompt'е). */
const SSH_ADD_TIMEOUT_MS = 30_000;

/** Предел длины stderr в тексте ошибки (символы). */
const STDERR_EXCERPT_CHARS = 300;

const execFileAsync = promisify(execFile);

/** Итог запуска внешней программы (агент/askpass). */
interface ToolRun {
  /** Код завершения (`0` — успех). */
  code: number;
  stdout: string;
  stderr: string;
  /** Программы нет в окружении (ENOENT). */
  missing: boolean;
}

/**
 * Запуск внешней программы без исключений: результат — всегда код/вывод.
 *
 * Ни ключ, ни passphrase в вывод не попадают (материал читает сама программа),
 * поэтому stderr можно показать в тексте ошибки.
 */
async function runTool(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ToolRun> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    return { code: 0, stdout, stderr, missing: false };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      missing: e.code === 'ENOENT',
    };
  }
}

/** Запуск `ssh-agent` с сокетом в каталоге материала → pid агента. */
async function startSshAgent(sockPath: string): Promise<number> {
  const started = await runTool('ssh-agent', ['-a', sockPath], process.env, SSH_AGENT_START_TIMEOUT_MS);
  if (started.missing) {
    throw new SshEnvError('agent_failed', 'ssh-agent недоступен в окружении исполнения');
  }
  if (started.code !== 0) {
    throw new SshEnvError(
      'agent_failed',
      `Не удалось запустить ssh-agent: код ${started.code}${stderrExcerpt(started.stderr)}`,
    );
  }
  const match = /SSH_AGENT_PID=(\d+)/.exec(started.stdout);
  const pid = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new SshEnvError('agent_failed', 'ssh-agent не вернул pid агента');
  }
  return pid;
}

/**
 * Askpass-скрипт `0700` в каталоге материала: отдаёт ровно passphrase.
 *
 * Passphrase кодируется `base64` — так скрипт не зависит от кавычек и
 * спецсимволов.
 */
async function writeAskpassScript(dir: string, passphrase: string): Promise<string> {
  const askpassPath = join(dir, 'askpass.sh');
  const encoded = Buffer.from(passphrase, 'utf-8').toString('base64');
  await writeFile(askpassPath, `#!/bin/sh\nbase64 -d <<'EOF'\n${encoded}\nEOF\n`, {
    encoding: 'utf-8',
    mode: 0o700,
  });
  await chmod(askpassPath, 0o700).catch(() => {});
  return askpassPath;
}

/** Хвост stderr в текст ошибки (материал ключа в stderr не попадает). */
function stderrExcerpt(stderr: string): string {
  const text = stderr.trim();
  if (!text) return '';
  const cut =
    text.length > STDERR_EXCERPT_CHARS ? `…${text.slice(-STDERR_EXCERPT_CHARS)}` : text;
  return `: ${cut}`;
}
