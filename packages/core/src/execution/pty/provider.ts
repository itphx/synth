/**
 * Провайдер PTY (план терминалов, Ф1) — абстракция над нативным модулем
 * терминала.
 *
 * ## Зачем интерфейс
 *
 * Нативный модуль — **деталь реализации**: сервис терминалов работает через
 * `PtyProvider`, поэтому форк можно заменить (свой билд, другой модуль) без
 * правок сервиса и порта. Плюс тесты получают подделку без нативного кода.
 *
 * ## Почему ленивый `import()`
 *
 * Модуль нативный и тяжёлый (N-API addon + prebuild'ы): в процесс control
 * plane его не тащат при старте. Загрузка — **ленивая**, по первому
 * обращению (как драйвер хранилища в `storage/storage-context.ts` и пакет
 * исполнителя в `execution/remote.ts`): отсутствие модуля не должно ломать
 * старт инстанса — PTY просто недоступен.
 *
 * ## Отсутствие модуля — не падение процесса
 *
 * `loadNodePtyModule()` возвращает `null` вместо броска: решение «PTY
 * недоступен» принимает вызывающий (провайдер → `PtyUnavailableError` → порт
 * → `ExecutionError` с `code: 'EPTY'` и `reason: 'dependency_missing'`).
 *
 * ## Почему упаковочный форк
 *
 * Официальный `node-pty` кладёт prebuild'ы только под darwin/win32 — на Linux
 * установка уходит в `node-gyp rebuild` (нужны python3/make/g++).
 * `@homebridge/node-pty-prebuilt-multiarch` (MIT) кладёт prebuild'ы в тарбол
 * (linux glibc/musl x64/arm64/arm/ia32, darwin, win32), поэтому установка
 * не требует тулчейна.
 */

import { warning } from '../../logger.js';

/**
 * Запрос запуска PTY-сессии — нормализованный вид (дефолты порта уже
 * применены: оболочка, аргументы, окружение, cwd).
 */
export interface PtySpawnRequest {
  /** Оболочка (путь к бинарю). */
  shell: string;
  /** Аргументы оболочки. */
  args: string[];
  /** Рабочий каталог (абсолютный путь). */
  cwd: string;
  /** Ширина терминала (колонки). */
  cols: number;
  /** Высота терминала (строки). */
  rows: number;
  /** Окружение дочернего процесса (полный набор — ambient не наследуется). */
  env: Record<string, string>;
}

/**
 * Живая PTY-сессия — минимальная поверхность, нужная порту.
 *
 * Обратна `PtyHandle` из контракта порта: порт добавляет `id`, идемпотентность
 * закрытия и гарантию «`onExit` — один раз».
 */
export interface PtySession {
  /** pid процесса ОС (лидер PTY-сессии) — если процесс запустился. */
  readonly pid?: number;
  /** Записать данные во вход терминала. */
  write(data: string): void;
  /** Изменить размер терминала (колонки/строки). */
  resize(cols: number, rows: number): void;
  /** Подписаться на вывод; возвращает функцию отписки. */
  onData(cb: (chunk: string) => void): () => void;
  /** Подписаться на завершение; возвращает функцию отписки. */
  onExit(cb: (e: { exitCode?: number; signal?: string }) => void): () => void;
  /** Отправить сигнал процессу (бросает, если процесс уже завершён). */
  kill(signal?: string): void;
}

/** Провайдер PTY: умеет заспавнить PTY-сессию. */
export interface PtyProvider {
  /** Запустить сессию; бросает ошибку, если запустить не удалось. */
  spawn(req: PtySpawnRequest): PtySession;
}

/**
 * Ошибка «PTY недоступен» — нативный модуль не загрузился (нет пакета, нет
 * prebuild'а под платформу, не загрузился addon).
 *
 * Отдельный класс (как `RemoteExecutionUnavailableError` в `execution/remote.ts`
 * и `StorageBackendUnavailableError` в слое хранения): вызывающий отличает
 * «PTY недоступен» от прочих ошибок исполнения.
 */
export class PtyUnavailableError extends Error {
  /** Машинный код причины — совпадает с `ExecutionError.code` порта. */
  readonly code = 'EPTY';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PtyUnavailableError';
  }
}

/**
 * Пакет с нативным модулем PTY. Аннотация `string` намеренная — путь не
 * должен резолвиться TypeScript'ом на этапе типов (модуль опционален по
 * факту загрузки), `import()` выполняется только в рантайме.
 */
const NODE_PTY_PACKAGE: string = '@homebridge/node-pty-prebuilt-multiarch';

/** Тип `TERM`, который объявляется терминалу. */
export const PTY_TERM = 'xterm-256color';

/** Значение `COLORTERM` — 24-битный цвет. */
export const PTY_COLORTERM = 'truecolor';

/** Подписка node-pty (её `dispose` снимает подписку). */
interface NodePtyDisposable {
  dispose(): void;
}

/** Терминал node-pty — используемая часть API. */
interface NodePtyTerminal {
  readonly pid: number;
  onData(cb: (data: string) => void): NodePtyDisposable;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): NodePtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Модуль node-pty — используемая часть API. */
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): NodePtyTerminal;
}

/**
 * Имена сигналов по номерам — node-pty отдаёт номер, а контракт порта ждёт
 * имя (`signal?: string`).
 */
const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  6: 'SIGABRT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
  24: 'SIGXCPU',
  25: 'SIGXFSZ',
};

/** Номер сигнала → имя (`undefined` — выход без сигнала). */
function signalName(signal?: number): string | undefined {
  if (!signal) return undefined;
  return SIGNAL_NAMES[signal] ?? `SIG${signal}`;
}

/** Текст ошибки загрузки — без стектрейса (в лог идёт только суть). */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Выбрать форму модуля: пакет — CommonJS, поэтому `import()` отдаёт
 * namespace с `default` (и, возможно, именованными экспортами).
 */
function pickModule(mod: unknown): NodePtyModule | null {
  if (!mod || typeof mod !== 'object') return null;
  const candidate = mod as { spawn?: unknown; default?: unknown };
  if (typeof candidate.spawn === 'function') return candidate as NodePtyModule;
  const fallback = candidate.default as { spawn?: unknown } | undefined;
  if (fallback && typeof fallback.spawn === 'function') return fallback as NodePtyModule;
  return null;
}

/**
 * Промис загрузки модуля — **кэшируется** (в том числе неуспешный): модуль
 * либо есть, либо нет, а повторные `import()` только тратят время. Одновременные
 * обращения разделяют один промис.
 */
let modulePromise: Promise<NodePtyModule | null> | undefined;

/**
 * Ленивая загрузка нативного модуля PTY.
 *
 * @returns модуль или `null`, если он недоступен (ошибка — в лог, не бросок).
 */
function loadNodePtyModule(): Promise<NodePtyModule | null> {
  modulePromise ??= (async () => {
    try {
      const mod = await import(NODE_PTY_PACKAGE);
      const resolved = pickModule(mod);
      if (!resolved) {
        warning('EXECUTION', `PTY-модуль '${NODE_PTY_PACKAGE}' не экспортирует spawn()`);
        return null;
      }
      return resolved;
    } catch (err) {
      warning('EXECUTION', `PTY-модуль '${NODE_PTY_PACKAGE}' не загрузился: ${errorText(err)}`);
      return null;
    }
  })();
  return modulePromise;
}

/** Провайдер поверх загруженного модуля node-pty. */
function createNodePtyProvider(mod: NodePtyModule): PtyProvider {
  return {
    spawn(req: PtySpawnRequest): PtySession {
      const terminal = mod.spawn(req.shell, req.args, {
        name: PTY_TERM,
        cols: req.cols,
        rows: req.rows,
        cwd: req.cwd,
        env: req.env,
      });
      return {
        pid: terminal.pid,
        write: (data: string) => terminal.write(data),
        resize: (cols: number, rows: number) => terminal.resize(cols, rows),
        onData: (cb: (chunk: string) => void) => {
          const subscription = terminal.onData(cb);
          return () => subscription.dispose();
        },
        onExit: (cb: (e: { exitCode?: number; signal?: string }) => void) => {
          const subscription = terminal.onExit((e) => {
            cb({ exitCode: e.exitCode, signal: signalName(e.signal) });
          });
          return () => subscription.dispose();
        },
        kill: (signal?: string) => terminal.kill(signal),
      };
    },
  };
}

/**
 * Провайдер PTY по умолчанию (нативный модуль node-pty).
 *
 * @throws `PtyUnavailableError` — модуль не загрузился (нет пакета/prebuild'а).
 */
export async function getPtyProvider(): Promise<PtyProvider> {
  const mod = await loadNodePtyModule();
  if (!mod) {
    throw new PtyUnavailableError(
      `PTY недоступен: не удалось загрузить модуль '${NODE_PTY_PACKAGE}'`,
    );
  }
  return createNodePtyProvider(mod);
}

/**
 * Доступен ли PTY в этом окружении.
 *
 * Проба **безопасно**: отсутствие модуля — `false`, а не исключение (модуль
 * нативный и может отсутствовать в тонком образе control plane).
 */
export async function isPtyAvailable(): Promise<boolean> {
  return (await loadNodePtyModule()) !== null;
}
