/**
 * ADR-090: жизненный цикл процесса плагина (Ф4б-2).
 *
 * Менеджер поднимает **отдельный процесс** Node с серверной точкой входа
 * бандла (`dist/server.js`), ждёт строку готовности в stdout
 * (`PLUGIN_SERVER_READY port=<n>`) и проверяет `GET /health`, после чего
 * отдаёт адрес `http://127.0.0.1:<port>` и bearer-токен клиенту
 * (`RemotePluginClient`, Ф4б-1).
 *
 * **Только loopback.** Порт берётся из строки готовности процесса, адрес
 * всегда `127.0.0.1` — плагин `out-of-process` не является сетевым сервисом,
 * egress-политика/прокси к нему не применяются.
 *
 * **Окружение процесса — минимальное.** Наследуется ровно необходимое:
 * `PATH` (найти node-модули не нужно, но нужен для запуска дочерних утилит
 * плагина), `NODE_ENV`, `SYNTH_PLUGIN_PORT=0` (процесс выбирает свободный порт
 * и сообщает его) и `SYNTH_PLUGIN_TOKEN`. Остальные переменные окружения
 * процесса Synth плагину **не передаются** — иначе вместе с ними утекли бы
 * секреты хоста. `shell` не используется: команда — `process.execPath` +
 * один аргумент (абсолютный путь точки входа).
 *
 * **Токен инстанса.** Файл `{secretsDir}/plugin-token`: читается, если есть,
 * иначе создаётся (`32` случайных байта hex, `0600`, каталог `0700`). Один
 * токен на инстанс (все удалённые плагины) — как в ADR-090.
 * Значение не логируется и вырезается из текстов ошибок/логов stderr.
 *
 * **Fail-closed.** Нет строки готовности за `readyTimeoutMs`, процесс вышел до
 * готовности, `health` не ответил `2xx` — процесс **останавливается**, а
 * вызывающий получает `PluginLoadError` (причина уходит в журнал аудита
 * плагинов через шаг `import`). Молчаливого «работаем без плагина» нет.
 *
 * **Падение после готовности.** Процесс считается упавшим: пишется `warn`
 * (перезапуска нет), следующий вызов точки завершится ошибкой клиента
 * (`connection_failed`) — композер/gateway применят штатную деградацию
 * (`failMode` фильтра, пустой блок промпта).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { PLUGIN_PROTOCOL_PATHS, parsePluginServerReadyLine } from '@itphx/synth-shared';

import { PluginLoadError } from '../activation.js';
import type { PluginLogger } from '../activation.js';

/** Серверная точка входа бандла по умолчанию (относительно `rootDir`). */
export const DEFAULT_PLUGIN_SERVER_ENTRY = 'dist/server.js';

/** Имя файла токена инстанса внутри каталога секретов. */
export const PLUGIN_TOKEN_FILE = 'plugin-token';

/** Таймаут ожидания строки готовности, мс. */
export const DEFAULT_PLUGIN_READY_TIMEOUT_MS = 10_000;
/** Таймаут одного запроса `GET /health`, мс. */
export const DEFAULT_PLUGIN_HEALTH_TIMEOUT_MS = 2_000;
/** Сколько ждать завершения процесса после `SIGTERM`, мс. */
export const DEFAULT_PLUGIN_STOP_TIMEOUT_MS = 5_000;

/** Интервал между попытками `health` во время ожидания готовности, мс. */
const HEALTH_POLL_INTERVAL_MS = 50;

/** Сколько ждать после `SIGKILL`, мс (страховка от «неубиваемого» процесса). */
const FORCE_KILL_GRACE_MS = 1_000;

/** Дескриптор дочернего процесса (инъекция spawn для тестов). */
export interface PluginProcessHandle {
  readonly pid?: number;
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown };
  on(event: 'exit', cb: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

/** Запущенный процесс удалённого плагина. */
export interface RemotePluginProcess {
  /** Базовый адрес процесса (`http://127.0.0.1:<port>`). */
  url: string;
  /** Bearer-токен инстанса (тот же, что в env процесса). */
  token: string;
  /** Остановить процесс (идемпотентно). */
  stop(): Promise<void>;
}

/** Опции менеджера процессов плагинов. */
export interface PluginProcessManagerOptions {
  /** Каталог секретов инстанса (`{dataDir}/secrets`) — здесь живёт `plugin-token`. */
  secretsDir: string;
  /** Таймаут готовности процесса (по умолчанию 10 000 мс). */
  readyTimeoutMs?: number;
  /** Таймаут запроса health (по умолчанию 2 000 мс). */
  healthTimeoutMs?: number;
  /** Сколько ждать завершения процесса при остановке (по умолчанию 5 000 мс). */
  stopTimeoutMs?: number;
  /** Логгер (по умолчанию `console.warn`). */
  logger?: PluginLogger;
  /**
   * Инъекция spawn — для тестов (по умолчанию `node:child_process.spawn`).
   *
   * `shell` не передаётся: реализация запускает ровно `command` + `args`.
   */
  spawn?: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ) => PluginProcessHandle;
}

/** Путь к файлу токена инстанса. */
export function pluginTokenPath(secretsDir: string): string {
  return join(secretsDir, PLUGIN_TOKEN_FILE);
}

/**
 * Менеджер процессов удалённых плагинов инстанса.
 *
 * Один экземпляр на инстанс: токен общий, процессы независимы (падение одного
 * не трогает остальные). `stopAll()` вызывается из `PluginRuntime.dispose()`.
 */
export class PluginProcessManager {
  private readonly _secretsDir: string;
  private readonly _readyTimeoutMs: number;
  private readonly _healthTimeoutMs: number;
  private readonly _stopTimeoutMs: number;
  private readonly _logger: PluginLogger;
  private readonly _spawn: NonNullable<PluginProcessManagerOptions['spawn']>;
  /** Живые процессы (убираются при выходе). */
  private readonly _processes = new Set<ManagedPluginProcess>();
  /** Кэш токена инстанса (один на все процессы). */
  private _token: string | undefined;
  /** Идущее чтение/создание токена — сериализует параллельные `start`. */
  private _tokenLoading: Promise<string> | undefined;

  constructor(options: PluginProcessManagerOptions) {
    this._secretsDir = options.secretsDir;
    this._readyTimeoutMs = pickPositive(
      options.readyTimeoutMs,
      DEFAULT_PLUGIN_READY_TIMEOUT_MS,
    );
    this._healthTimeoutMs = pickPositive(
      options.healthTimeoutMs,
      DEFAULT_PLUGIN_HEALTH_TIMEOUT_MS,
    );
    this._stopTimeoutMs = pickPositive(options.stopTimeoutMs, DEFAULT_PLUGIN_STOP_TIMEOUT_MS);
    this._logger = options.logger ?? {
      warn: (message: string) => {
        console.warn(`[plugin-process] ${message}`);
      },
    };
    this._spawn = options.spawn ?? defaultSpawn;
  }

  /**
   * Запустить процесс плагина.
   *
   * @param plugin имя плагина (для сообщений/лога), корень бандла и
   *   относительный путь серверной точки входа (по умолчанию `dist/server.js`).
   * @throws {PluginLoadError} нет точки входа, процесс не сообщил о готовности,
   *   вышел до готовности или `health` не ответил `2xx`.
   */
  async start(plugin: {
    name: string;
    rootDir: string;
    entry?: string;
  }): Promise<RemotePluginProcess> {
    const name = typeof plugin.name === 'string' ? plugin.name.trim() : '';
    if (!name) {
      throw new PluginLoadError('процесс плагина: имя плагина не задано — запуск отклонён.');
    }
    const rootDir = typeof plugin.rootDir === 'string' ? plugin.rootDir.trim() : '';
    if (!rootDir) {
      throw new PluginLoadError(
        `процесс плагина «${name}»: не задан корень бандла (rootDir) — запуск отклонён.`,
      );
    }

    // Токен — до spawn: файл секрета создаётся один раз на инстанс.
    const token = await this._ensureToken();

    let command: string;
    try {
      command = resolveServerEntry(rootDir, plugin.entry);
    } catch (err) {
      throw asLoadError(name, token, err);
    }
    let isFile = false;
    try {
      isFile = (await stat(command)).isFile();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new PluginLoadError(
        `процесс плагина «${name}»: серверная точка входа ` +
          `«${relativeEntry(plugin.entry)}» не найдена в бандле` +
          (code === 'ENOENT' ? '' : ` (${redact(describeError(err), token)})`) +
          ' — запуск отклонён.',
      );
    }
    if (!isFile) {
      throw new PluginLoadError(
        `процесс плагина «${name}»: серверная точка входа ` +
          `«${relativeEntry(plugin.entry)}» — не файл — запуск отклонён.`,
      );
    }

    let child: PluginProcessHandle;
    try {
      child = this._spawn(process.execPath, [command], {
        cwd: resolve(rootDir),
        env: buildPluginEnv(token),
      });
    } catch (err) {
      throw asLoadError(
        name,
        token,
        new Error(`не удалось запустить процесс: ${describeError(err)}`),
      );
    }

    const proc = new ManagedPluginProcess({
      name,
      token,
      child,
      logger: this._logger,
      stopTimeoutMs: this._stopTimeoutMs,
      onExit: (exited) => this._processes.delete(exited),
    });
    this._processes.add(proc);

    let port: number;
    try {
      port = await this._awaitReady(proc, name, token);
    } catch (err) {
      await proc.stop();
      throw asLoadError(name, token, err);
    }

    const url = `http://127.0.0.1:${port}`;
    proc.markReady(url);

    if (!(await this._awaitHealth(url))) {
      await proc.stop();
      throw new PluginLoadError(
        `процесс плагина «${name}»: health не ответил 2xx за ${this._readyTimeoutMs} мс ` +
          `(порт ${port}) — процесс остановлен.`,
      );
    }

    return proc;
  }

  /** Остановить все запущенные процессы; ошибки изолированы. */
  async stopAll(): Promise<void> {
    const processes = [...this._processes];
    const results = await Promise.allSettled(processes.map((proc) => proc.stop()));
    for (const result of results) {
      if (result.status === 'rejected') {
        this._logger.warn(
          `не удалось остановить процесс плагина: ${describeError(result.reason)}`,
        );
      }
    }
    this._processes.clear();
  }

  // ── Готовность и health ─────────────────────────────────────────────

  /**
   * Дождаться строки `SYNTH_PLUGIN_READY port=<n>` в stdout.
   *
   * Строки буферизуются по `\n` (stdout приходит с `\n`/`\r\n`), поэтому
   * разбор не зависит от границ чанков. Выход процесса до готовности —
   * ошибка (процесс мог упасть на старте: текст — в stderr, он логируется).
   */
  private _awaitReady(
    proc: ManagedPluginProcess,
    name: string,
    token: string,
  ): Promise<number> {
    return new Promise<number>((resolvePromise, rejectPromise) => {
      let buffer = '';
      let settled = false;
      const finish = (error?: Error, port?: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise(port as number);
      };

      const timer = setTimeout(() => {
        finish(
          new Error(
            `процесс плагина не сообщил о готовности за ${this._readyTimeoutMs} мс ` +
              '(ожидалась строка SYNTH_PLUGIN_READY port=<n> в stdout)',
          ),
        );
      }, this._readyTimeoutMs);

      proc.child.stdout.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        buffer += chunk.toString();
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const ready = parsePluginServerReadyLine(line);
          if (ready) {
            finish(undefined, ready.port);
            return;
          }
          newline = buffer.indexOf('\n');
        }
      });

      proc.child.on('exit', (code: number | null) => {
        finish(
          new Error(
            `процесс плагина завершился до готовности (код ${code ?? 'null'})`,
          ),
        );
      });

      proc.child.stderr.on('data', (chunk: Buffer | string) => {
        const text = redact(chunk.toString(), token).trim();
        if (text.length === 0) return;
        this._logger.warn(`плагин «${name}» (stderr): ${text}`);
      });
    });
  }

  /** Опрос `GET /health` до `readyTimeoutMs` после строки готовности. */
  private async _awaitHealth(url: string): Promise<boolean> {
    const deadline = Date.now() + this._readyTimeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      try {
        const response = await fetch(`${url}${PLUGIN_PROTOCOL_PATHS.health}`, {
          method: 'GET',
          signal: AbortSignal.timeout(Math.max(1, Math.min(this._healthTimeoutMs, remaining))),
        });
        if (response.body) await response.body.cancel().catch(() => undefined);
        if (response.ok) return true;
      } catch {
        // Процесс мог ещё не начать слушать порт — повторяем до дедлайна.
      }
      const wait = Math.min(HEALTH_POLL_INTERVAL_MS, deadline - Date.now());
      if (wait <= 0) return false;
      await delay(wait);
    }
  }

  // ── Токен ───────────────────────────────────────────────────────────

  /** Прочитать или создать `{secretsDir}/plugin-token` (значение не логируется). */
  private async _ensureToken(): Promise<string> {
    if (this._token) return this._token;
    if (!this._tokenLoading) {
      this._tokenLoading = this._readOrCreateToken()
        .then((token) => {
          this._token = token;
          return token;
        })
        .catch((err: unknown) => {
          // Сбой не кэшируем: следующий `start` попробует снова.
          this._tokenLoading = undefined;
          throw err;
        });
    }
    return this._tokenLoading;
  }

  /** Чтение существующего токена или атомарное создание нового (`0600`). */
  private async _readOrCreateToken(): Promise<string> {
    const path = pluginTokenPath(this._secretsDir);
    try {
      const existing = (await readFile(path, 'utf-8')).trim();
      if (existing.length > 0) return existing;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new PluginLoadError(
          `не удалось прочитать файл токена плагинов «${path}»: ${describeError(err)}`,
        );
      }
    }

    const token = randomBytes(32).toString('hex');
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Каталог мог существовать с более широкими правами — сужаем (best-effort).
    await chmod(dir, 0o700).catch(() => undefined);
    const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
      await chmod(tmp, 0o600).catch(() => undefined);
      await rename(tmp, path);
      await chmod(path, 0o600).catch(() => undefined);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new PluginLoadError(
        `не удалось создать файл токена плагинов «${path}»: ${describeError(err)}`,
      );
    }
    // Несколько реплик инстанса могут создать файл одновременно (общий PVC).
    // После записи перечитываем файл: побеждает тот, кто записал последним, —
    // так все реплики сойдутся на одном токене.
    try {
      const after = (await readFile(path, 'utf-8')).trim();
      if (after.length > 0) return after;
    } catch {
      // Файл мог быть удалён — возвращаем свой токен (созданный корректно).
    }
    return token;
  }
}

/**
 * Процесс плагина с отслеживанием выхода и идемпотентной остановкой.
 *
 * `url` появляется только после строки готовности (`markReady`) — до этого
 * обращаться к нему нельзя (менеджер его не отдаёт наружу).
 */
class ManagedPluginProcess implements RemotePluginProcess {
  readonly token: string;
  readonly child: PluginProcessHandle;
  private readonly _name: string;
  private readonly _logger: PluginLogger;
  private readonly _stopTimeoutMs: number;
  private readonly _onExit: ((proc: ManagedPluginProcess) => void) | undefined;
  private readonly _exitedPromise: Promise<void>;
  private _resolveExited!: () => void;
  private _url = '';
  private _exited = false;
  private _exitCode: number | null = null;
  private _ready = false;
  private _stopping = false;
  private _stopPromise: Promise<void> | undefined;

  constructor(input: {
    name: string;
    token: string;
    child: PluginProcessHandle;
    logger: PluginLogger;
    stopTimeoutMs: number;
    onExit?: (proc: ManagedPluginProcess) => void;
  }) {
    this._name = input.name;
    this.token = input.token;
    this.child = input.child;
    this._logger = input.logger;
    this._stopTimeoutMs = input.stopTimeoutMs;
    this._onExit = input.onExit;
    this._exitedPromise = new Promise<void>((resolvePromise) => {
      this._resolveExited = resolvePromise;
    });
    this.child.on('exit', (code: number | null) => {
      this._exited = true;
      this._exitCode = code;
      this._resolveExited();
      this._onExit?.(this);
      if (this._ready && !this._stopping) {
        this._logger.warn(
          `процесс плагина «${this._name}» неожиданно завершился (код ${code ?? 'null'}) — ` +
            'вызовы точки будут завершаться ошибкой клиента (failMode фильтра/деградация блока).',
        );
      }
    });
  }

  get url(): string {
    return this._url;
  }

  /** Зафиксировать готовность и адрес процесса. */
  markReady(url: string): void {
    this._url = url;
    this._ready = true;
  }

  /** Остановить процесс: `SIGTERM` → ожидание → `SIGKILL`. Идемпотентно. */
  async stop(): Promise<void> {
    if (!this._stopPromise) this._stopPromise = this._stop();
    return this._stopPromise;
  }

  private async _stop(): Promise<void> {
    if (this._exited) return;
    this._stopping = true;
    this._signal('SIGTERM');
    if (await this._waitExit(this._stopTimeoutMs)) return;
    this._signal('SIGKILL');
    await this._waitExit(FORCE_KILL_GRACE_MS);
  }

  private _signal(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch (err) {
      this._logger.warn(
        `не удалось отправить ${signal} процессу плагина «${this._name}»: ${describeError(err)}`,
      );
    }
  }

  private async _waitExit(timeoutMs: number): Promise<boolean> {
    if (this._exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(false), timeoutMs);
    });
    const exited = this._exitedPromise.then(() => true);
    const result = await Promise.race([exited, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }
}

// ── Вспомогательное ─────────────────────────────────────────────────────

/** Окружение процесса плагина — ровно четыре переменные. */
function buildPluginEnv(token: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    NODE_ENV: process.env.NODE_ENV ?? 'production',
    SYNTH_PLUGIN_PORT: '0',
    SYNTH_PLUGIN_TOKEN: token,
  };
}

/** `spawn` по умолчанию: node + точка входа, без shell, stdin закрыт. */
function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): PluginProcessHandle {
  return nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  }) as unknown as PluginProcessHandle;
}

/** Относительный путь серверной точки входа (для сообщений). */
function relativeEntry(entry: string | undefined): string {
  const trimmed = typeof entry === 'string' ? entry.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_PLUGIN_SERVER_ENTRY;
}

/**
 * Абсолютный путь точки входа с containment внутри `rootDir`.
 *
 * Абсолютный путь, windows-диск, `..`, `.` и пустые сегменты отвергаются —
 * процесс не должен запускать файл вне бандла плагина.
 */
function resolveServerEntry(rootDir: string, entry: string | undefined): string {
  const relative = relativeEntry(entry).replace(/\\/g, '/');
  const segments = relative.split('/');
  const invalid =
    isAbsolute(relative) ||
    /^[a-zA-Z]:/.test(relative) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..');
  if (invalid) {
    throw new Error(
      `недопустимая серверная точка входа «${relative}»: ожидается относительный путь ` +
        'внутри бандла (без «..», без абсолютного пути).',
    );
  }
  const root = resolve(rootDir);
  const target = resolve(root, relative);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(
      `недопустимая серверная точка входа «${relative}»: выходит за пределы каталога бандла.`,
    );
  }
  return target;
}

/** Ошибка загрузки без утечки токена в текст. */
function asLoadError(name: string, token: string, err: unknown): PluginLoadError {
  if (err instanceof PluginLoadError) {
    return new PluginLoadError(redact(err.message, token), err.reason);
  }
  return new PluginLoadError(
    `процесс плагина «${name}»: ${redact(describeError(err), token)}`,
  );
}

/** Текст ошибки (без стека). */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Вырезать значение токена из любого текста (лог/сообщение). */
function redact(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join('***') : text;
}

/** Положительное целое из опции (иначе — дефолт). */
function pickPositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/** Пауза (без `unref`: ожидание держит вызывающий). */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
