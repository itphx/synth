/**
 * Ленивый порт исполнения на динамический пул (PROP-135, Ф4b-1).
 *
 * ## Зачем
 *
 * При `provider: http` адрес пула известен **только в момент обращения** к
 * provisioner'у: пул может быть создан, пересоздан или отменён между ходами.
 * Поэтому порт нельзя собрать на старте (как при `provider: static`) — он
 * собирается **лениво**, при первом обращении.
 *
 * ## Что делает порт
 *
 * - `execute`/`spawnBackground`/`probe`/`capabilitySummary`/`fs.*` сначала
 *   `await resolve()` — дождаться адреса пула и собрать реальный порт, —
 *   затем делегируют вызов;
 * - адрес пула запрашивается **один раз**: кэшируется промис; при ошибке
 *   кэш **сбрасывается**, и следующий вызов повторяет `ensure` (пул мог
 *   появиться позже);
 * - `executorMcp` **не выставляется**: состав MCP-серверов пула на динамике
 *   не разбирается (остаток слайсов) — порт без этого поля работает, но
 *   MCP-серверы исполнителя через него не подключаются;
 * - `isRemote = true` — команды уходят за пределы процесса control plane
 *   (ADR-077), значит локальная конфигурация окружения (CA, ключи) к ним
 *   неприменима;
 * - после **любой** активности (`execute` — и при успехе, и при ошибке;
 *   успешный `spawnBackground` — долгий процесс тоже активность) пул
 *   «трогается» (`provider.touch`) **fire-and-forget**: иначе provisioner
 *   снял бы пул по idle, хотя им пользуются. Задержки в горячий путь это не
 *   добавляет, ошибки `touch` игнорируются. `ensure` уже обновляет
 *   `lastUsedAt` — там `touch` не нужен.
 */

import { ExecutionError, ExecutionFsUnavailableError, EXECUTION_BACKGROUND_UNSUPPORTED_CODE } from './ports/index.js';
import { warning } from '../logger.js';
import type {
  BrowserCallRequest,
  BrowserCallResult,
  ExecutionCapabilitySummary,
  ExecutionFs,
  ExecutionMetricsSink,
  ExecutionPort,
  ExecBackgroundProcess,
  ExecRequest,
  ExecResult,
} from './ports/index.js';
import { poolKeyString } from './pool-provider.js';
import type { ExecutionPoolKey, ExecutionPoolRef } from './pool-provider.js';

/** Опции ленивого порта на пул. */
export interface PooledExecutionPortOptions {
  /** Ключ пула (область/идентификатор/класс/профиль). */
  key: ExecutionPoolKey;
  /** Провайдер пулов (адрес и токен пула). */
  provider: {
    ensure(key: ExecutionPoolKey): Promise<ExecutionPoolRef>;
    /**
     * Продлить жизнь пула (PROP-135): вызывается после активности порта.
     * Best-effort, fire-and-forget — не задан, активность не сообщается.
     */
    touch?(key: ExecutionPoolKey): Promise<void>;
  };
  /** Приёмник метрик исполнения (ADR-094) — достаётся до клиента порта. */
  metricsSink?: ExecutionMetricsSink;
  /** Шов: собрать реальный порт по адресу пула. */
  createPort: (ref: ExecutionPoolRef) => Promise<ExecutionPort>;
}

/** Задержки прогрева пула перед повтором (мс): 10 с суммарно (4 повтора). */
const WARMUP_DELAYS_MS = [1000, 2000, 3000, 4000] as const;

/** Ошибка означает «пул ещё не отвечает», а не отказ самой операции. */
function isWarmupRetryable(err: unknown, allowNetwork = false): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (code === 'EUNREACHABLE' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
    return true;
  }
  const message = typeof e?.message === 'string' ? e.message : String(err);
  // Только «процесс ещё не слушает»: инвентарь не собрался / соединение
  // отклонено / исполнитель ответил 503. Для read-only операций сюда же
  // относятся сетевые сбои (`fetch failed`, reset) — действие можно повторить;
  // для команд/записи такие ошибки не повторяем (могли уже выполниться).
  if (/ECONNREFUSED|capabilities|не ответил|503 Service Unavailable|503/i.test(message)) return true;
  return allowNetwork && /fetch failed|ECONNRESET|socket hang up|network error/i.test(message);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Повторить операцию, пока пул прогревается (под создан, процесс ещё не
 * слушает). Повторяются только connect-ошибки — ошибки самой операции
 * возвращаются как есть (иначе можно выполнить команду дважды).
 *
 * После исчерпания попыток — понятная ошибка с профилем и ключом пула.
 */
async function withWarmup<T>(
  key: ExecutionPoolKey,
  operation: () => Promise<T>,
  allowNetwork = false,
): Promise<T> {
  let attempt = 0;
  let elapsed = 0;
  for (;;) {
    try {
      return await operation();
    } catch (err) {
      if (!isWarmupRetryable(err, allowNetwork)) throw err;
      if (attempt >= WARMUP_DELAYS_MS.length) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ExecutionError({
          message:
            `исполнитель профиля «${key.profile}» не ответил за ${Math.round(elapsed / 100) / 10} с ` +
            `(пул ${poolKeyString(key)}): ${detail}. ` +
            'Пул мог не успеть запуститься — повторите запрос через несколько секунд; ' +
            'если повторяется — проверьте provisioner и образ профиля.',
          code: 'EUNREACHABLE',
          reason: 'spawn_failed',
          durationMs: elapsed,
        });
      }
      const delay = WARMUP_DELAYS_MS[attempt]!;
      attempt += 1;
      elapsed += delay;
      await sleep(delay);
    }
  }
}

/**
 * Ленивый порт на динамический пул.
 *
 * Порт **не** создаёт пул сам: адрес запрашивает провайдер (`ensure`), порт
 * только собирается по этому адресу. Ошибка `ensure` **не** кэшируется —
 * следующий вызов повторяет попытку (пул мог появиться после сбоя).
 */
export function createPooledExecutionPort(opts: PooledExecutionPortOptions): ExecutionPort {
  const { key, provider, createPort } = opts;

  /** Кэш промиса сборки порта (`null` — ещё не собирали). */
  let pending: Promise<ExecutionPort> | null = null;

  const resolve = (): Promise<ExecutionPort> => {
    if (!pending) {
      const promise = (async (): Promise<ExecutionPort> => {
        const ref = await provider.ensure(key);
        return createPort(ref);
      })();
      pending = promise;
      // Сбой не кэшируем: следующий вызов повторяет `ensure`.
      void promise.catch(() => {
        if (pending === promise) pending = null;
      });
    }
    return pending;
  };

  /**
   * Дождаться готовности исполнителя после выдачи пула.
   *
   * Provisioner возвращает адрес, когда под Ready, но процессу нужно ещё
   * мгновение, чтобы начать отвечать. Первый `execute`/`browserCall` иначе
   * падает `fetch failed`. Проверка read-only (`capabilities`/`probe`) идёт
   * через `withWarmup` с сетевыми повторами; неудача не блокирует вызов —
   * ошибку покажет сама операция.
   */
  let readyPromise: Promise<void> | null = null;
  const waitReady = (): Promise<void> => {
    if (!readyPromise) {
      readyPromise = (async () => {
        const port = await resolve();
        try {
          if (port.capabilitySummary) {
            await withWarmup(key, () => port.capabilitySummary!('sh'), true);
          } else if (port.probe) {
            await withWarmup(key, () => port.probe!('sh'), true);
          }
        } catch {
          // Не готов — операция ниже вернёт исходную ошибку.
        }
      })();
    }
    return readyPromise;
  };

  const fs = createPooledFs(resolve, key);

  /**
   * Сообщить провайдеру об активности пула (PROP-135).
   *
   * Fire-and-forget: результат/латентность вызова не зависят от `touch`
   * (горячий путь — исполнение команды), ошибки проглатываются —
   * `touch` best-effort по контракту провайдера. `ensure` уже обновляет
   * `lastUsedAt`, поэтому при сборке порта `touch` не нужен.
   */
  const markActive = (): void => {
    if (!provider.touch) return;
    try {
      void provider.touch(key).catch(() => {});
    } catch {
      // Провайдер может бросить синхронно — активность всё равно сообщена
      // не будет, но ход ломать нечем.
    }
  };

  return {
    // Пул динамический — команды уходят за пределы control plane (ADR-077).
    isRemote: true,
    fs,

    async execute(req: ExecRequest): Promise<ExecResult> {
      const port = await resolve();
      await waitReady();
      try {
        return await withWarmup(key, () => port.execute(req));
      } finally {
        // Активность была в любом исходе: успех и ошибка команды одинаково
        // означают, что пул использовался.
        markActive();
      }
    },

    async spawnBackground(req: ExecRequest): Promise<ExecBackgroundProcess> {
      const port = await resolve();
      await waitReady();
      if (!port.spawnBackground) {
        // Тот же машинный код, что у удалённого порта старой версии
        // (протокол < 3): «фон не поддерживается» — не «есть метод, но падает».
        throw new ExecutionError({
          message: 'executor does not support background processes (features.background)',
          code: EXECUTION_BACKGROUND_UNSUPPORTED_CODE,
          reason: 'spawn_failed',
        });
      }
      const process = await withWarmup(key, () => port.spawnBackground!(req));
      // Долгий фоновый процесс — тоже активность пула (пул живёт, пока
      // процесс работает).
      markActive();
      return process;
    },

    async browserCall(req: BrowserCallRequest): Promise<BrowserCallResult> {
      const port = await resolve();
      await waitReady();
      if (!port.browserCall) {
        // Внутренний порт без browser-вызова (не удалённый клиент либо
        // старая реализация): понятный отказ, а не «тихий» пустой результат.
        return {
          content: 'browser execution is unavailable in the current execution environment',
          isError: true,
        };
      }
      try {
        // Интерактивные действия не повторяем (двойной клик); навигацию,
        // снимок, ожидание и скриншот — можно.
        const readOnly = !['browser_click','browser_type','browser_press_key'].includes(req.tool);
        return await withWarmup(key, () => port.browserCall!(req), readOnly);
      } finally {
        // Обращение к пулу — активность (как у execute): provisioner не должен
        // снять пул по idle между вызовами браузера.
        markActive();
      }
    },

    async probe(bin: string, args?: string[]): Promise<boolean> {
      const port = await resolve();
      return port.probe ? withWarmup(key, () => port.probe!(bin, args), true) : true;
    },

    async capabilitySummary(bin: string): Promise<ExecutionCapabilitySummary> {
      const port = await resolve();
      if (!port.capabilitySummary) {
        throw new Error('capabilitySummary не поддерживается портом');
      }
      return withWarmup(key, () => port.capabilitySummary!(bin), true);
    },
  };
}

/**
 * FS-часть ленивого порта: каждый метод сначала дожидается порта, затем
 * делегирует реальному порту.
 *
 * Реального порта без `fs` (исполнитель без `features.fs`) → **fail-closed**
 * (`ExecutionFsUnavailableError`): тихого возврата к чтению ФС в control
 * plane нет (PROP-135 Ф1).
 */
function createPooledFs(resolve: () => Promise<ExecutionPort>, key: ExecutionPoolKey): ExecutionFs {
  const fsOf = async (): Promise<ExecutionFs> => {
    const port = await resolve();
    if (!port.fs) {
      warning(
        'EXECUTION',
        `pooled fs unavailable: inner port ${port.constructor?.name ?? 'unknown'} ` +
        `(isRemote=${String(port.isRemote)}, key=${poolKeyString(key)})`,
      );
      throw new ExecutionFsUnavailableError();
    }
    return port.fs;
  };

  /** Вызов FS-операции с прогревом пула (connect-ошибки повторяются). */
  const call = async <T>(fn: (fs: ExecutionFs) => Promise<T>, allowNetwork = false): Promise<T> =>
    withWarmup(key, async () => fn(await fsOf()), allowNetwork);

  return {
    realpath: (path: string) => call((fs) => fs.realpath(path), true),
    stat: (path: string) => call((fs) => fs.stat(path), true),
    readdir: (path: string) => call((fs) => fs.readdir(path), true),
    readText: (path: string, opts) => call((fs) => fs.readText(path, opts), true),
    sniff: (path: string, maxBytes?: number) => call((fs) => fs.sniff(path, maxBytes), true),
    readBytes: (path: string, maxBytes: number) => call((fs) => fs.readBytes(path, maxBytes), true),
    writeFile: (path: string, content: string) => call((fs) => fs.writeFile(path, content)),
    mkdir: (path: string) => call((fs) => fs.mkdir(path)),
    remove: (path: string) => call((fs) => fs.remove(path)),
    readRawText: (path: string, maxBytes: number) => call((fs) => fs.readRawText(path, maxBytes), true),
    rename: (from: string, to: string) => call((fs) => fs.rename(from, to)),
    download: (path: string, maxBytes: number) => call((fs) => fs.download(path, maxBytes), true),
    upload: (path: string, bytes: Buffer, opts) => call((fs) => fs.upload(path, bytes, opts)),
    hash: (path: string) => call((fs) => fs.hash(path), true),
  };
}
