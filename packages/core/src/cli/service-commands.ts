/**
 * CLI `synth service …` — userspace-сервис инстанса через systemd (`--user`, ADR-134).
 *
 * **Что делает модуль.** Единственный поддерживаемый путь провижининга
 * «инстанс работает всегда»: пишет unit `synth.service` из **фиксированного
 * шаблона**, env-файл (0600, без секретов), включает автозапуск и поднимает
 * сервис. Ручное написание unit'а, `--system`-вариант и offline-установщик для
 * этого сценария больше не нужны (ADR-134).
 *
 * **Где живёт.** `$XDG_CONFIG_HOME/systemd/user/synth.service` (fallback
 * `~/.config/systemd/user`), env-файл — `$XDG_CONFIG_HOME/synth/service.env`
 * (fallback `~/.config/synth`). Чужой unit без маркера
 * `Managed by synth service install` не перезаписывается: нужен явный `--force`.
 *
 * **Режим рестарта.** В unit'е фиксировано `Environment=SYNTH_RESTART_MODE=process`
 * + `Restart=on-failure` + `RestartForceExitStatus=75`: `POST /api/v2/maintenance/restart`
 * (ADR-092 п. 7) выходит с кодом 75, а systemd поднимает процесс заново —
 * ручной супервизор не нужен.
 *
 * **Секреты.** В unit и env-файл не попадают: гибрид авторизуется сохранёнными
 * credentials после ручного `synth connect` (device flow, ADR-043/ADR-105), а
 * API-ключ инстанса создаёт сам сервер в `{dataDir}/secrets/api-key`. Команда
 * печатает только **путь** к ключу — не значение (инвариант 13).
 *
 * **Внешние команды** (`systemctl`, `loginctl`, `journalctl`) запускаются
 * `execFile`/`spawn` без shell, с таймаутом; код выхода и stderr попадают в
 * текст ошибки. Все они инъектируются через {@link ServiceCommandDeps}, поэтому
 * тесты не трогают реальный systemd и настоящий `~/.config`.
 *
 * **Ограничения.** Только Linux + systemd (`--user`); на других платформах
 * команда сообщает о неподдерживаемости, а не эмулирует сервис. Данные инстанса
 * команда не удаляет (`uninstall` убирает только unit; данные — `synth uninstall`).
 */
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { accessSync, existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';import { promisify } from 'node:util';

import { Command } from 'commander';
import { loadConfig, resolveDataDir, resolveHome } from '@itphx/synth-shared';
import type { SynthConfig } from '@itphx/synth-shared';

/** Имя unit'а (без суффикса) — его понимают `systemctl`/`journalctl`. */
export const SERVICE_UNIT_NAME = 'synth';

/** Полное имя unit-файла. */
export const SERVICE_UNIT_FILE = `${SERVICE_UNIT_NAME}.service`;

/** Маркер «unit создан этой командой»: без него перезапись запрещена. */
export const SERVICE_MANAGED_MARKER = 'Managed by synth service install';

/** Порт по умолчанию, если в конфиге нет `core.port`. */
export const SERVICE_DEFAULT_PORT = 4300;

/** Адрес прослушивания по умолчанию. */
export const SERVICE_DEFAULT_HOST = '127.0.0.1';

/** Сколько ждать `/health` после запуска сервиса (мс). */
export const SERVICE_HEALTH_TIMEOUT_MS = 30_000;

/** Интервал опроса `/health` (мс). */
export const SERVICE_HEALTH_INTERVAL_MS = 500;

/** Таймаут одной внешней команды (мс). */
const COMMAND_TIMEOUT_MS = 20_000;

/** Результат внешней команды. */
export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Обёртка `execFile` (инъектируется в тестах). */
export type ExecFileImpl = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<ExecResult>;

/** Обёртка `spawn` для `logs` (stdio наследуется; инъектируется в тестах). */
export type SpawnImpl = (
  file: string,
  args: string[],
  options: { stdio: 'inherit' },
) => Promise<number>;

/** Зависимости группы команд (в CLI — дефолты, в тестах — подмены). */
export interface ServiceCommandDeps {
  /** Вывод в stdout (по умолчанию — `console.log`). */
  stdout?: (line: string) => void;
  /** Вывод в stderr (по умолчанию — `console.error`). */
  stderr?: (line: string) => void;
  /** Окружение (`XDG_CONFIG_HOME`, `HOME`, `PATH`, `USER`); по умолчанию — `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Запуск внешней команды (по умолчанию — `execFile` без shell). */
  execFileImpl?: ExecFileImpl;
  /** Запуск `journalctl` с наследованием stdio (по умолчанию — `spawn`). */
  spawnImpl?: SpawnImpl;
  /** Проверка наличия программы в `PATH` (по умолчанию — поиск по `PATH`). */
  whichImpl?: (command: string) => Promise<boolean>;
  /** Транспорт `/health` (по умолчанию — обычный `fetch`; без egress-слоя). */
  fetchImpl?: typeof fetch;
  /** Ожидание между опросами `/health` (тесты — no-op). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Домашний каталог (для XDG-fallback); по умолчанию — `os.homedir()`. */
  homeDir?: string;
  /** Путь к Node (`process.execPath`); в тестах — фиксированный. */
  nodePath?: string;
  /** Абсолютный путь к `cli.js`; по умолчанию — `realpathSync(process.argv[1])`. */
  scriptPath?: string;
  /** Таймаут ожидания `/health` (мс). */
  healthTimeoutMs?: number;
  /** Интервал опроса `/health` (мс). */
  healthIntervalMs?: number;
}

/** Ошибка CLI: машинный код, текст, код выхода и (опционально) вывод команды. */
export class ServiceCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number = 1,
    readonly stdout: string = '',
    readonly stderr: string = '',
  ) {
    super(message);
    this.name = 'ServiceCliError';
  }
}

/** Непустая строка из опции CLI. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Пути unit'а и env-файла (XDG или `~/.config`). */
export interface ServicePaths {
  /** Базовый каталог конфигурации (`$XDG_CONFIG_HOME` или `~/.config`). */
  configHome: string;
  /** Каталог unit'ов `systemd/user`. */
  unitDir: string;
  /** Полный путь unit-файла. */
  unitPath: string;
  /** Каталог env-файла (`<configHome>/synth`). */
  envDir: string;
  /** Полный путь env-файла. */
  envPath: string;
}

/**
 * Резолвинг путей по XDG: `$XDG_CONFIG_HOME` → `~/.config` (ADR-134 п. 2).
 * Каталоги не создаются — это делает `install` (и только при реальной записи).
 */
export function resolveServicePaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): ServicePaths {
  const raw = str(env.XDG_CONFIG_HOME);
  const configHome = raw ? resolve(raw) : join(homeDirectory, '.config');
  const unitDir = join(configHome, 'systemd', 'user');
  const envDir = join(configHome, 'synth');
  return {
    configHome,
    unitDir,
    unitPath: join(unitDir, SERVICE_UNIT_FILE),
    envDir,
    envPath: join(envDir, 'service.env'),
  };
}

/**
 * Экранирование значения для unit-файла systemd: кавычки, обратные слэши и
 * спецификаторы (`%%`). Перевод строки и NUL запрещены — иначе в unit можно
 * подмешать произвольные директивы.
 */
export function quoteUnitArg(value: string, label = 'аргумент'): string {
  if (/[\n\r\0]/.test(value)) {
    throw new ServiceCliError(
      'VALIDATION_ERROR',
      `${label}: запрещены перевод строки и NUL-символ`,
    );
  }
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%');
  return `"${escaped}"`;
}

/**
 * Значение директивы без кавычек (`EnvironmentFile=` не принимает кавычки:
 * systemd считает их частью пути). C-экранирование: пробел/таб/кавычка —
 * `\xNN`, обратный слэш — `\\`, `%` — `%%` (иначе трактуется как спецификатор).
 */
export function escapeUnitPath(value: string, label = 'путь'): string {
  if (/[\n\r\0]/.test(value)) {
    throw new ServiceCliError(
      'VALIDATION_ERROR',
      `${label}: запрещены перевод строки и NUL-символ`,
    );
  }
  return value
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '\\x20')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\x22')
    .replace(/%/g, '%%');
}

/** Параметры шаблона unit'а (ADR-134 п. 3). */
export interface ServiceUnitInput {
  /** Путь к исполняемому файлу Node (`process.execPath`). */
  nodePath: string;
  /** Абсолютный путь к `cli.js`. */
  scriptPath: string;
  /** Путь к env-файлу (`EnvironmentFile=-…`). */
  envFilePath: string;
  /** Явный home-каталог (иначе используется `--data-dir`). */
  home?: string | null;
  /** Явный каталог данных. */
  dataDir?: string | null;
  /** Порт прослушивания. */
  port: number;
  /** Адрес прослушивания. */
  host: string;
  /** URL удалённого backend (гибрид) — только при заданном значении. */
  connect?: string | null;
}

/**
 * Генератор unit-файла: **единственный** шаблон (ADR-134 п. 3). Чистая функция —
 * используется командой и тестами; никакого ввода-вывода.
 */
export function renderServiceUnit(input: ServiceUnitInput): string {
  const parts: string[] = [quoteUnitArg(input.nodePath), quoteUnitArg(input.scriptPath), 'serve'];
  if (input.home) {
    parts.push('--home', quoteUnitArg(input.home));
  } else if (input.dataDir) {
    parts.push('--data-dir', quoteUnitArg(input.dataDir));
  }
  parts.push('--port', quoteUnitArg(String(input.port)), '--host', quoteUnitArg(input.host));
  if (input.connect) parts.push('--connect', quoteUnitArg(input.connect));

  const execStart = parts.join(' ');

  const lines = [
    `# ${SERVICE_MANAGED_MARKER} — пересоздаётся командой, ручные правки затираются`,
    '[Unit]',
    'Description=Synth — AI-платформа',
    'Documentation=https://docs.synth.itphx.ru/',
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    'WorkingDirectory=%h',
    'Environment=HOME=%h',
    'Environment=NODE_ENV=production',
    'Environment=SYNTH_RESTART_MODE=process',
    `EnvironmentFile=-${escapeUnitPath(input.envFilePath, 'путь env-файла')}`,
    `ExecStart=${execStart}`,
    'Restart=on-failure',
    'RestartForceExitStatus=75',
    'RestartSec=3',
    'KillMode=mixed',
    'TimeoutStopSec=30',
    'LimitNOFILE=65536',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

/** Содержимое нового env-файла: только шапка, без секретов. */
export function renderServiceEnvFile(): string {
  return [
    '# Synth service environment (ADR-134)',
    '# Неконфиденциальные переменные для synth.service (systemd --user).',
    '# Секреты сюда НЕ писать: API-ключ — {dataDir}/secrets/api-key,',
    '# внешние доступы — слой credentials (ADR-105).',
    '#',
    '# Пример:',
    '# NODE_OPTIONS=--max-old-space-size=4096',
    '',
  ].join('\n');
}

/** Проверка, что unit создан этой командой (по маркеру в шапке). */
export function isManagedUnit(content: string): boolean {
  return content.includes(SERVICE_MANAGED_MARKER);
}

/** Разбор слов unit-файла: кавычки, C-escape и `%%` → `%`. */
export function parseUnitWords(value: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /\s/.test(value[i]!)) i++;
    if (i >= value.length) break;
    let word = '';
    if (value[i] === '"') {
      i++;
      while (i < value.length && value[i] !== '"') {
        const char = value[i]!;
        if (char === '\\' && i + 1 < value.length) {
          const next = value[i + 1]!;
          word += next === '\\' || next === '"' ? next : next === 'n' ? '\n' : next;
          i += 2;
        } else {
          word += char;
          i++;
        }
      }
      i++; // закрывающая кавычка
    } else {
      while (i < value.length && !/\s/.test(value[i]!)) {
        word += value[i];
        i++;
      }
    }
    words.push(word.replace(/%%/g, '%'));
  }
  return words;
}

/** Разобранные параметры установленного unit'а. */
export interface ParsedServiceUnit {
  /** Маркер присутствует (unit создан `synth service install`). */
  managed: boolean;
  port: number | null;
  host: string | null;
  home: string | null;
  dataDir: string | null;
  connect: string | null;
  restartMode: string | null;
}

/** Параметры из unit-файла: `ExecStart` и `Environment=SYNTH_RESTART_MODE`. */
export function parseServiceUnit(content: string): ParsedServiceUnit {
  const result: ParsedServiceUnit = {
    managed: isManagedUnit(content),
    port: null,
    host: null,
    home: null,
    dataDir: null,
    connect: null,
    restartMode: null,
  };

  const execLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('ExecStart='));
  if (execLine) {
    const words = parseUnitWords(execLine.slice('ExecStart='.length));
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      if (word === '--port') {
        const port = Number(words[i + 1]);
        if (Number.isInteger(port) && port >= 1 && port <= 65535) result.port = port;
        i++;
      } else if (word === '--host') {
        result.host = words[i + 1] ?? null;
        i++;
      } else if (word === '--home') {
        result.home = words[i + 1] ?? null;
        i++;
      } else if (word === '--data-dir') {
        result.dataDir = words[i + 1] ?? null;
        i++;
      } else if (word === '--connect') {
        result.connect = words[i + 1] ?? null;
        i++;
      }
    }
  }

  const restartLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('Environment=SYNTH_RESTART_MODE='));
  if (restartLine) {
    result.restartMode = restartLine.slice('Environment=SYNTH_RESTART_MODE='.length).trim();
  }

  return result;
}

/** Порт из флага: целое 1…65535 (иначе `VALIDATION_ERROR`). */
export function parseServicePort(raw: unknown, fallback: number): number {
  const text = str(raw);
  if (!text) {
    if (!Number.isInteger(fallback) || fallback < 1 || fallback > 65535) {
      throw new ServiceCliError(
        'VALIDATION_ERROR',
        `--port: в конфиге недопустимый порт «${String(fallback)}»; укажите --port`,
      );
    }
    return fallback;
  }
  if (!/^\d+$/.test(text)) {
    throw new ServiceCliError(
      'VALIDATION_ERROR',
      `--port: ожидается целое 1…65535, получено «${text}»`,
    );
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceCliError(
      'VALIDATION_ERROR',
      `--port: ожидается целое 1…65535, получено «${text}»`,
    );
  }
  return port;
}

/** Адрес прослушивания: непустой, без переводов строк. */
export function parseServiceHost(raw: unknown): string {
  const host = str(raw) || SERVICE_DEFAULT_HOST;
  if (/[\n\r\0]/.test(host)) {
    throw new ServiceCliError('VALIDATION_ERROR', '--host: запрещены перевод строки и NUL-символ');
  }
  return host;
}

/** `--connect`: валидный `http(s)`-URL. Возвращает исходную строку. */
export function parseConnectUrl(raw: unknown): string {
  const value = str(raw);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceCliError(
      'VALIDATION_ERROR',
      `--connect: ожидается http(s)-URL, получено «${value}»`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServiceCliError(
      'VALIDATION_ERROR',
      `--connect: ожидается http(s)-URL, получено «${value}»`,
    );
  }
  return value;
}

/** Адрес для опроса `/health` (wildcard-host → loopback). */
export function healthAddress(host: string): string {
  const value = host.trim();
  if (!value || value === '0.0.0.0' || value === '::') return '127.0.0.1';
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`;
  return value;
}

/** URL `/health` инстанса. */
export function healthUrl(host: string, port: number): string {
  return `http://${healthAddress(host)}:${port}/health`;
}

/** Аргументы `journalctl` для `logs`. */
export function buildLogsArgs(lines: number, follow: boolean): string[] {
  return [
    '--user',
    '-u',
    SERVICE_UNIT_NAME,
    '-n',
    String(lines),
    ...(follow ? ['--follow'] : []),
  ];
}

/** Разбор значения `Linger=yes|no` из `loginctl show-user`. */
export function parseLinger(stdout: string): boolean | null {
  const match = /(?:^|\n)Linger=(yes|no)\b/.exec(stdout);
  if (!match) return null;
  return match[1] === 'yes';
}

/** Текущий пользователь (для `loginctl`). */
function currentUser(env: NodeJS.ProcessEnv): string {
  const fromEnv = str(env.USER) || str(env.LOGNAME);
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

/** Поиск программы в `PATH` (без shell). */
export function findExecutable(command: string, pathValue: string | undefined): string | null {
  for (const dir of (pathValue ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // ищем дальше
    }
  }
  return null;
}

const execFileAsync = promisify(execFile) as unknown as (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; encoding: 'utf8' },
) => Promise<{ stdout: string; stderr: string }>;

/** Дефолтный запуск команды: `execFile`, без shell, с таймаутом. */
const defaultExecFile: ExecFileImpl = async (file, args, options = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (error) {
    const detail = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    const exitCode = typeof detail.code === 'number' ? detail.code : 1;
    const stdout = String(detail.stdout ?? '');
    const stderr = String(detail.stderr ?? '');
    const reason = stderr.trim() || String(detail.message ?? 'команда завершилась с ошибкой');
    throw new ServiceCliError(
      'COMMAND_FAILED',
      `${file} ${args.join(' ')}: ${reason}`,
      exitCode,
      stdout,
      stderr,
    );
  }
};

/** Дефолтный `spawn` с наследованием stdio (для `journalctl -f`). */
const defaultSpawn: SpawnImpl = (file, args, options) =>
  new Promise<number>((resolvePromise) => {
    const child = spawn(file, args, { stdio: options.stdio });
    child.on('error', () => resolvePromise(1));
    child.on('close', (code) => resolvePromise(code ?? 0));
  });

/** Прогон команды: ошибка → `ServiceCliError` (код выхода и stderr сохранены). */
async function runCommand(
  deps: ServiceCommandDeps,
  file: string,
  args: string[],
): Promise<ExecResult> {
  const exec = deps.execFileImpl ?? defaultExecFile;
  try {
    return await exec(file, args, { timeoutMs: COMMAND_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof ServiceCliError) throw error;
    throw new ServiceCliError(
      'COMMAND_FAILED',
      `${file} ${args.join(' ')}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Прогон команды «best-effort»: любой отказ → `null` (вывод сохраняется, если он был). */
async function tryCommand(
  deps: ServiceCommandDeps,
  file: string,
  args: string[],
): Promise<ExecResult | null> {
  const exec = deps.execFileImpl ?? defaultExecFile;
  try {
    return await exec(file, args, { timeoutMs: COMMAND_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof ServiceCliError) {
      return { stdout: error.stdout, stderr: error.stderr };
    }
    return null;
  }
}

/** `systemctl --user …`. */
function systemctl(deps: ServiceCommandDeps, args: string[]): Promise<ExecResult> {
  return runCommand(deps, 'systemctl', ['--user', ...args]);
}

/** Есть ли программа в `PATH` (по умолчанию — поиск по `PATH`). */
async function commandAvailable(deps: ServiceCommandDeps, command: string): Promise<boolean> {
  if (deps.whichImpl) return deps.whichImpl(command);
  const env = deps.env ?? process.env;
  return findExecutable(command, env.PATH) !== null;
}

/** Проверка окружения перед реальными действиями (`systemctl --user`). */
async function assertSystemdUsable(deps: ServiceCommandDeps): Promise<void> {
  if (!(await commandAvailable(deps, 'systemctl'))) {
    throw new ServiceCliError(
      'SYSTEMD_UNAVAILABLE',
      'systemd не найден в PATH — synth service поддерживает только systemd (Linux, --user). ' +
        'Для контейнеров используйте Docker/Helm (ADR-077), для systemd-юнита на сервере — systemctl.',
    );
  }
  try {
    await systemctl(deps, ['show-environment']);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ServiceCliError(
      'SYSTEMD_USER_UNAVAILABLE',
      `systemctl --user недоступен (${detail}). Похоже, нет пользовательской сессии systemd ` +
        'или не задан XDG_RUNTIME_DIR; проверьте: export XDG_RUNTIME_DIR=/run/user/$(id -u).',
      1,
    );
  }
}

/** Чтение файла (нет файла → `null`). */
async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Ожидание `/health` конкретного инстанса. */
interface HealthSnapshot {
  ok: boolean;
  version?: string;
  startedAt?: string;
  error?: string;
}

/** Один запрос `GET /health` (обычный `fetch`, локальный адрес). */
async function probeHealth(
  deps: ServiceCommandDeps,
  url: string,
  timeoutMs: number,
): Promise<HealthSnapshot> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    const response = await fetchImpl(url, signal ? { signal } : {});
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return {
      ok: true,
      ...(typeof body?.version === 'string' ? { version: body.version } : {}),
      ...(typeof body?.startedAt === 'string' ? { startedAt: body.startedAt } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Опрос `/health` до успеха или таймаута. */
async function waitForHealth(deps: ServiceCommandDeps, url: string): Promise<HealthSnapshot> {
  const timeoutMs = deps.healthTimeoutMs ?? SERVICE_HEALTH_TIMEOUT_MS;
  const intervalMs = deps.healthIntervalMs ?? SERVICE_HEALTH_INTERVAL_MS;
  const sleep =
    deps.sleepImpl ??
    ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));
  const deadline = Date.now() + timeoutMs;
  let last: HealthSnapshot = { ok: false, error: 'нет ответа' };
  for (;;) {
    last = await probeHealth(deps, url, 3_000);
    if (last.ok) return last;
    if (Date.now() >= deadline) {
      return { ...last, ok: false, error: last.error ?? 'таймаут' };
    }
    await sleep(intervalMs);
  }
}

/** Диагностика неудачного старта: статус unit'а и последние строки журнала. */
async function printStartupDiagnostics(deps: ServiceCommandDeps): Promise<void> {
  const err = deps.stderr ?? ((line: string) => console.error(line));
  const status = await tryCommand(deps, 'systemctl', [
    '--user',
    'status',
    SERVICE_UNIT_NAME,
    '--no-pager',
  ]);
  if (status) {
    const text = `${status.stdout}${status.stderr}`.trim();
    if (text) err(text);
  }
  const logs = await tryCommand(deps, 'journalctl', [
    '--user',
    '-u',
    SERVICE_UNIT_NAME,
    '-n',
    '50',
  ]);
  if (logs) {
    const text = logs.stdout.trim();
    if (text) err(text);
  }
}

/** Код выхода команды с сохранением `exitCode` ошибки. */
async function runGrouped(deps: ServiceCommandDeps, fn: () => Promise<number>): Promise<void> {
  const err = deps.stderr ?? ((line: string) => console.error(line));
  try {
    process.exitCode = await fn();
  } catch (error) {
    if (error instanceof ServiceCliError) {
      err(`Ошибка: ${error.message}`);
      process.exitCode = error.exitCode;
    } else {
      err(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

/** Резолвинг скрипта CLI: `realpathSync(process.argv[1])`, fallback — как есть. */
function resolveScriptPath(deps: ServiceCommandDeps): string {
  if (deps.scriptPath) return deps.scriptPath;
  const arg = process.argv[1] ?? '';
  if (!arg) {
    throw new ServiceCliError(
      'CLI_PATH_UNKNOWN',
      'не удалось определить путь cli.js (process.argv[1] пуст); запустите команду через synth',
    );
  }
  try {
    return realpathSync(arg);
  } catch {
    return resolve(arg);
  }
}

/** Резолвер Node: `process.execPath` (инъекция — для тестов). */
function resolveNodePath(deps: ServiceCommandDeps): string {
  return deps.nodePath ?? process.execPath;
}

/** План установки для `--dry-run` (человекочитаемо). */
function printInstallPlan(
  out: (line: string) => void,
  paths: ServicePaths,
  commands: string[],
): void {
  out('[dry-run] Сервис synth.service — план без записи и без systemctl:');
  out(`  unit: ${paths.unitPath}`);
  out(`  env:  ${paths.envPath} (0600, существующий не перезаписывается)`);
  out('  команды:');
  for (const command of commands) out(`    ${command}`);
}

/** Команды установки для плана/dry-run. */
function serviceCommands(
  autostart: boolean,
  startEnabled: boolean,
  lingerRequested: boolean,
  user: string,
): string[] {
  return [
    'systemctl --user daemon-reload',
    ...(autostart ? [`systemctl --user enable ${SERVICE_UNIT_FILE}`] : []),
    ...(startEnabled ? [`systemctl --user restart ${SERVICE_UNIT_FILE}`] : []),
    ...(lingerRequested ? [`loginctl enable-linger ${user}`] : []),
  ];
}

/** `synth service install …` — записать unit и поднять сервис. */
function createInstallCommand(deps: ServiceCommandDeps): Command {
  const cmd = new Command('install').description(
    'Установить userspace-сервис synth.service (systemd --user, ADR-134)',
  );
  return cmd
    .option('--port <n>', 'порт инстанса (по умолчанию — core.port из конфига или 4300)')
    .option('--host <addr>', 'адрес прослушивания (по умолчанию 127.0.0.1)')
    .option('--home <dir>', 'локальный home-каталог (ADR-079)')
    .option('--data-dir <dir>', 'каталог данных инстанса')
    .option('--config <path>', 'путь к config.yaml (читается для дефолтов, в unit не пишется)')
    .option('--connect <url>', 'URL удалённого backend (гибрид; только при заданном режиме)')
    .option('--oidc-issuer <url>', 'OIDC issuer (в unit не пишется — только для UI-входа)')
    .option('--oidc-client-id <id>', 'OIDC client_id (в unit не пишется — только для UI-входа)')
    .option('--no-autostart', 'не включать автозапуск (без systemctl enable)')
    .option('--no-start', 'не запускать сервис после установки')
    .option('--no-linger', 'не включать loginctl enable-linger')
    .option('--force', 'перезаписать unit без маркера synth')
    .option('--print-unit', 'напечатать unit и выйти (ничего не пишется)')
    .option('--dry-run', 'напечатать план и unit без записи и без systemctl')
    .option('--json', 'машиночитаемый вывод (JSON)')
    .action(async (options: Record<string, unknown>) => {
      await runGrouped(deps, () => install(deps, options));
    });
}

/** Тело `install`: валидация → (запись) → systemctl → health. */
async function install(
  deps: ServiceCommandDeps,
  options: Record<string, unknown>,
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;

  const homeFlag = str(options.home);
  const dataDirFlag = str(options.dataDir);
  const configFlag = str(options.config);
  const connectFlag = str(options.connect);
  const oidcIssuer = str(options.oidcIssuer);
  const oidcClientId = str(options.oidcClientId);
  const printUnit = options.printUnit === true;
  const dryRun = options.dryRun === true;

  if (homeFlag && dataDirFlag) {
    throw new ServiceCliError(
      'VALIDATION_ERROR',
      'укажите либо --home <dir>, либо --data-dir <dir> (не оба)',
    );
  }
  if (configFlag) {
    const exists = await stat(configFlag).then(
      (value) => value.isFile(),
      () => false,
    );
    if (!exists) {
      throw new ServiceCliError(
        'VALIDATION_ERROR',
        `--config: файл не найден: ${configFlag}`,
      );
    }
  }

  const home = resolveHome(homeFlag || null, env);
  const synth: SynthConfig = await loadConfig({
    ...(configFlag ? { configPath: configFlag } : {}),
    ...(home ? { home } : {}),
    env,
  });

  const port = parseServicePort(options.port, Number(synth.core.port) || SERVICE_DEFAULT_PORT);
  const host = parseServiceHost(options.host);
  const connect = connectFlag ? parseConnectUrl(connectFlag) : null;
  if (host === '0.0.0.0' || host === '::') {
    err(
      `Предупреждение: --host ${host} — инстанс доступен из сети, проверьте аутентификацию (API-ключ/OIDC).`,
    );
  }
  if (oidcIssuer || oidcClientId) {
    err(
      'Предупреждение: --oidc-issuer/--oidc-client-id в unit не пишутся (они нужны UI-входу): ' +
        'положите их в config.yaml рядом с home (remote.auth.*) и перезапустите сервис.',
    );
  }

  const unitHome = homeFlag ? resolve(homeFlag) : dataDirFlag ? null : home;
  const unitDataDir = dataDirFlag ? resolve(dataDirFlag) : unitHome ? null : resolveDataDir(synth, env, home);
  if (configFlag && unitHome && !resolve(configFlag).startsWith(`${unitHome}/`)) {
    err(
      `Предупреждение: --config ${configFlag} не попадает в unit (ExecStart без --config): ` +
        'положите config.yaml в home или задайте SYNTH_CONFIG в service.env.',
    );
  }

  const paths = resolveServicePaths(env, deps.homeDir ?? homedir());
  const unit = renderServiceUnit({
    nodePath: resolveNodePath(deps),
    scriptPath: resolveScriptPath(deps),
    envFilePath: paths.envPath,
    home: unitHome,
    dataDir: unitDataDir,
    port,
    host,
    connect,
  });

  const existing = await readIfExists(paths.unitPath);
  const foreignUnit = existing !== null && !isManagedUnit(existing);
  if (foreignUnit && options.force !== true && !printUnit) {
    throw new ServiceCliError(
      'UNIT_EXISTS',
      `юнит ${paths.unitPath} создан не synth (нет маркера «${SERVICE_MANAGED_MARKER}»); ` +
        'перезапись — только с --force',
    );
  }

  const startEnabled = options.start !== false;
  const autostart = options.autostart !== false;
  const lingerRequested = options.linger !== false;
  const user = currentUser(env);
  const url = `http://${healthAddress(host)}:${port}`;

  if (printUnit || dryRun) {
    if (options.json === true) {
      out(
        JSON.stringify(
          {
            installed: false,
            dryRun,
            unitPath: paths.unitPath,
            envPath: paths.envPath,
            unit,
            url,
            port,
            host,
            home: unitHome,
            dataDir: unitDataDir,
            connect,
            commands: dryRun ? serviceCommands(autostart, startEnabled, lingerRequested, user) : [],
          },
          null,
          2,
        ),
      );
      return 0;
    }
    if (dryRun) {
      printInstallPlan(out, paths, serviceCommands(autostart, startEnabled, lingerRequested, user));
      out('');
    }
    out(unit);
    return 0;
  }

  // Реальные действия: сначала окружение, затем запись (чтобы не оставить
  // полуустановленный unit при отсутствии userspace-systemd).
  await assertSystemdUsable(deps);

  const targetDir = unitHome ?? unitDataDir;
  if (targetDir) {
    try {
      await mkdir(targetDir, { recursive: true });
    } catch (error) {
      throw new ServiceCliError(
        'DIR_CREATE_FAILED',
        `не удалось создать каталог ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await mkdir(paths.unitDir, { recursive: true });
  await writeFile(paths.unitPath, unit, { mode: 0o644 });
  await chmod(paths.unitPath, 0o644).catch(() => {});

  await mkdir(paths.envDir, { recursive: true });
  let envCreated = false;
  if (!existsSync(paths.envPath)) {
    try {
      await writeFile(paths.envPath, renderServiceEnvFile(), { mode: 0o600, flag: 'wx' });
      await chmod(paths.envPath, 0o600);
      envCreated = true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
  }

  await systemctl(deps, ['daemon-reload']);

  let enabled = false;
  if (autostart) {
    await systemctl(deps, ['enable', SERVICE_UNIT_FILE]);
    enabled = true;
  }

  let started = false;
  if (startEnabled) {
    try {
      await systemctl(deps, ['restart', SERVICE_UNIT_FILE]);
      started = true;
    } catch (error) {
      await printStartupDiagnostics(deps);
      throw error;
    }
  }

  let linger: boolean | null = null;
  if (lingerRequested) {
    try {
      await runCommand(deps, 'loginctl', ['enable-linger', user]);
      linger = true;
    } catch (error) {
      linger = false;
      err(
        `Предупреждение: loginctl enable-linger не удался (${
          error instanceof Error ? error.message : String(error)
        }) — сервис работает до выхода из сеанса, автозапуск после перезагрузки не включён.`,
      );
    }
  }

  let health: HealthSnapshot = { ok: false, error: 'сервис не запускался (--no-start)' };
  if (started) {
    health = await waitForHealth(deps, healthUrl(host, port));
    if (!health.ok) {
      await printStartupDiagnostics(deps);
      throw new ServiceCliError(
        'SERVICE_UNHEALTHY',
        `сервис не ответил на ${healthUrl(host, port)} за ${
          (deps.healthTimeoutMs ?? SERVICE_HEALTH_TIMEOUT_MS) / 1000
        } с (${health.error ?? 'таймаут'})`,
      );
    }
  }

  const apiKeyPath = join(unitDataDir ?? resolveDataDir(synth, env, home), 'secrets', 'api-key');
  if (options.json === true) {
    out(
      JSON.stringify(
        {
          installed: true,
          unitPath: paths.unitPath,
          envPath: paths.envPath,
          envCreated,
          url,
          port,
          host,
          home: unitHome,
          dataDir: unitDataDir,
          connect,
          enabled,
          started,
          linger,
          restartMode: 'process',
          apiKeyPath,
          health,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  out(`Сервис ${SERVICE_UNIT_FILE} установлен`);
  out(`  юнит: ${paths.unitPath}`);
  out(`  env:  ${paths.envPath}${envCreated ? ' (создан, 0600)' : ' (существующий сохранён)'}`);
  out(`  URL:  ${url}`);
  out(`  API-ключ: ${apiKeyPath} (значение не печатается)`);
  out(`  логи: journalctl --user -u ${SERVICE_UNIT_NAME} -f`);
  out('  перезапуск: exit 75 → Restart=on-failure (режим process)');
  if (!enabled) out('  автозапуск: не включён (--no-autostart)');
  if (!started) out('  запуск: пропущен (--no-start)');
  if (linger === false) out('  linger: не включён (автозапуск после перезагрузки недоступен)');
  return 0;
}

/** `synth service status [--json]` — состояние сервиса и health. */
function createStatusCommand(deps: ServiceCommandDeps): Command {
  return new Command('status')
    .description('Состояние сервиса synth.service (unit, автозапуск, PID, linger, health)')
    .option('--json', 'машиночитаемый вывод (JSON)')
    .action(async (options: Record<string, unknown>) => {
      await runGrouped(deps, () => status(deps, options));
    });
}

/** Тело `status`. Секреты не читаются и не печатаются. */
async function status(
  deps: ServiceCommandDeps,
  options: Record<string, unknown>,
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const env = deps.env ?? process.env;
  const paths = resolveServicePaths(env, deps.homeDir ?? homedir());
  const content = await readIfExists(paths.unitPath);
  const installed = content !== null;

  let enabled: boolean | null = null;
  let active: string | null = null;
  let pid: number | null = null;
  let linger: boolean | null = null;
  let health: HealthSnapshot = { ok: false, error: 'сервис не установлен' };

  const parsed = content
    ? parseServiceUnit(content)
    : { managed: false, port: null, host: null, home: null, dataDir: null, connect: null, restartMode: null };

  if (installed) {
    const enabledResult = await tryCommand(deps, 'systemctl', ['--user', 'is-enabled', SERVICE_UNIT_FILE]);
    if (enabledResult) {
      const state = enabledResult.stdout.trim() || enabledResult.stderr.trim();
      enabled = state === 'enabled' || state === 'enabled-runtime';
    }
    const activeResult = await tryCommand(deps, 'systemctl', ['--user', 'is-active', SERVICE_UNIT_FILE]);
    if (activeResult) active = activeResult.stdout.trim() || activeResult.stderr.trim() || null;

    const pidResult = await tryCommand(deps, 'systemctl', [
      '--user',
      'show',
      SERVICE_UNIT_FILE,
      '-p',
      'MainPID',
      '--value',
    ]);
    if (pidResult) {
      const value = Number(pidResult.stdout.trim());
      pid = Number.isInteger(value) && value > 0 ? value : null;
    }

    const lingerResult = await tryCommand(deps, 'loginctl', [
      'show-user',
      currentUser(env),
      '-p',
      'Linger',
    ]);
    if (lingerResult) linger = parseLinger(lingerResult.stdout);

    const port = parsed.port ?? SERVICE_DEFAULT_PORT;
    const host = parsed.host ?? SERVICE_DEFAULT_HOST;
    health = await probeHealth(deps, healthUrl(host, port), 3_000);
  }

  if (options.json === true) {
    out(
      JSON.stringify(
        {
          unitPath: paths.unitPath,
          installed,
          managed: parsed.managed,
          enabled,
          active,
          pid,
          port: parsed.port,
          host: parsed.host,
          home: parsed.home,
          connect: parsed.connect,
          restartMode: parsed.restartMode,
          linger,
          health,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!installed) {
    out(`Сервис не установлен (юнит не найден: ${paths.unitPath}).`);
    out(`Установка: synth service install --port ${SERVICE_DEFAULT_PORT}`);
    return 0;
  }

  out(`Сервис ${SERVICE_UNIT_FILE}: ${active ?? 'состояние неизвестно'}`);
  out(`  юнит: ${paths.unitPath}${parsed.managed ? ' (управляется synth)' : ' (без маркера synth)'}`);
  out(`  адрес: http://${healthAddress(parsed.host ?? SERVICE_DEFAULT_HOST)}:${parsed.port ?? SERVICE_DEFAULT_PORT}`);
  if (parsed.home) out(`  home: ${parsed.home}`);
  if (parsed.dataDir) out(`  data-dir: ${parsed.dataDir}`);
  if (parsed.connect) out(`  гибрид: ${parsed.connect}`);
  out(`  режим рестарта: ${parsed.restartMode ?? '—'}`);
  out(`  автозапуск: ${enabled === null ? 'неизвестно' : enabled ? 'включён' : 'выключен'}`);
  if (pid) out(`  PID: ${pid}`);
  out(`  linger: ${linger === null ? 'неизвестно' : linger ? 'включён' : 'выключен'}`);
  if (health.ok) {
    const details = [
      health.version ? `версия ${health.version}` : '',
      health.startedAt ? `старт ${health.startedAt}` : '',
    ].filter(Boolean);
    out(`  health: ok${details.length ? ` (${details.join(', ')})` : ''}`);
  } else {
    out(`  health: недоступен (${health.error ?? 'нет ответа'})`);
  }
  return 0;
}

/** Подкоманды-обёртки `systemctl --user <verb> synth.service`. */
function createSystemctlCommand(
  deps: ServiceCommandDeps,
  verb: 'start' | 'stop' | 'restart' | 'enable' | 'disable',
  description: string,
): Command {
  return new Command(verb)
    .description(description)
    .action(async () => {
      await runGrouped(deps, async () => {
        const out = deps.stdout ?? ((line: string) => console.log(line));
        const env = deps.env ?? process.env;
        const paths = resolveServicePaths(env, deps.homeDir ?? homedir());
        if (!existsSync(paths.unitPath)) {
          throw new ServiceCliError(
            'NOT_INSTALLED',
            `сервис не установлен (юнит не найден: ${paths.unitPath}); выполните synth service install`,
          );
        }
        await assertSystemdUsable(deps);
        await systemctl(deps, [verb, SERVICE_UNIT_FILE]);
        out(`systemctl --user ${verb} ${SERVICE_UNIT_FILE}: готово`);
        return 0;
      });
    });
}

/** `synth service logs [-f] [-n <lines>]` — журнал через journalctl. */
function createLogsCommand(deps: ServiceCommandDeps): Command {
  return new Command('logs')
    .description('Логи сервиса (journalctl --user -u synth)')
    .option('-f, --follow', 'следить за журналом')
    .option('-n, --lines <n>', 'сколько последних строк показать (по умолчанию 100)')
    .action(async (options: Record<string, unknown>) => {
      await runGrouped(deps, async () => {
        const raw = str(options.lines);
        const lines = raw ? Number(raw) : 100;
        if (!Number.isInteger(lines) || lines < 1) {
          throw new ServiceCliError(
            'VALIDATION_ERROR',
            `-n: ожидается целое ≥ 1, получено «${raw}»`,
          );
        }
        const args = buildLogsArgs(lines, options.follow === true);
        const spawnImpl = deps.spawnImpl ?? defaultSpawn;
        const code = await spawnImpl('journalctl', args, { stdio: 'inherit' });
        return Number.isInteger(code) ? code : 1;
      });
    });
}

/** `synth service uninstall [--dry-run] [--json] [--force]`. */
function createUninstallCommand(deps: ServiceCommandDeps): Command {
  return new Command('uninstall')
    .description('Удалить unit synth.service (env-файл и данные сохраняются)')
    .option('--dry-run', 'показать план без удаления')
    .option('--force', 'удалить unit без маркера synth')
    .option('--json', 'машиночитаемый вывод (JSON)')
    .action(async (options: Record<string, unknown>) => {
      await runGrouped(deps, () => uninstall(deps, options));
    });
}

/** Тело `uninstall`: stop → disable → удаление unit → daemon-reload. */
async function uninstall(
  deps: ServiceCommandDeps,
  options: Record<string, unknown>,
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const env = deps.env ?? process.env;
  const paths = resolveServicePaths(env, deps.homeDir ?? homedir());
  const dryRun = options.dryRun === true;
  const content = await readIfExists(paths.unitPath);

  if (content === null) {
    if (options.json === true) {
      out(JSON.stringify({ removed: false, unitPath: paths.unitPath, envPath: paths.envPath }, null, 2));
    } else {
      out(`Сервис не установлен (юнит не найден: ${paths.unitPath}).`);
    }
    return 0;
  }

  if (!isManagedUnit(content) && options.force !== true) {
    throw new ServiceCliError(
      'UNIT_NOT_MANAGED',
      `юнит ${paths.unitPath} создан не synth (нет маркера «${SERVICE_MANAGED_MARKER}»); ` +
        'удаление — только с --force',
    );
  }

  if (dryRun) {
    const commands = [
      `systemctl --user stop ${SERVICE_UNIT_FILE}`,
      `systemctl --user disable ${SERVICE_UNIT_FILE}`,
      `rm ${paths.unitPath}`,
      'systemctl --user daemon-reload',
    ];
    if (options.json === true) {
      out(
        JSON.stringify(
          {
            removed: false,
            dryRun: true,
            unitPath: paths.unitPath,
            envPath: paths.envPath,
            commands,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    printInstallPlan(out, paths, commands);
    out('');
    out(`env-файл сохраняется: ${paths.envPath}`);
    out('данные инстанса не трогаются (удаление данных — synth uninstall)');
    return 0;
  }

  await assertSystemdUsable(deps);
  await tryCommand(deps, 'systemctl', ['--user', 'stop', SERVICE_UNIT_FILE]);
  await tryCommand(deps, 'systemctl', ['--user', 'disable', SERVICE_UNIT_FILE]);

  try {
    await unlink(paths.unitPath);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  await systemctl(deps, ['daemon-reload']);

  if (options.json === true) {
    out(
      JSON.stringify(
        {
          removed: true,
          unitPath: paths.unitPath,
          envPath: paths.envPath,
          envKept: true,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  out(`Сервис ${SERVICE_UNIT_FILE} удалён (${paths.unitPath}).`);
  out(`  env-файл сохранён: ${paths.envPath} (в нём могут быть настройки)`);
  out('  данные инстанса не тронуты (удаление данных — synth uninstall)');
  return 0;
}

/**
 * Собрать группу команд `synth service …` (ADR-134).
 *
 * Зависимости инъектируются целиком (внешние команды, транспорт `/health`,
 * окружение) — тесты не трогают реальный systemd и `~/.config`.
 */
export function createServiceCommand(deps: ServiceCommandDeps = {}): Command {
  return new Command('service')
    .description(
      'Сервис инстанса (systemd --user, ADR-134): установка, статус, старт/стоп, логи, удаление',
    )
    .addCommand(createInstallCommand(deps))
    .addCommand(createStatusCommand(deps))
    .addCommand(createSystemctlCommand(deps, 'start', 'Запустить сервис synth.service'))
    .addCommand(createSystemctlCommand(deps, 'stop', 'Остановить сервис synth.service'))
    .addCommand(createSystemctlCommand(deps, 'restart', 'Перезапустить сервис synth.service'))
    .addCommand(createSystemctlCommand(deps, 'enable', 'Включить автозапуск synth.service'))
    .addCommand(createSystemctlCommand(deps, 'disable', 'Выключить автозапуск synth.service'))
    .addCommand(createLogsCommand(deps))
    .addCommand(createUninstallCommand(deps));
}
