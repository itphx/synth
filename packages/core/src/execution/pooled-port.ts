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

  const fs = createPooledFs(resolve);

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
      try {
        return await port.execute(req);
      } finally {
        // Активность была в любом исходе: успех и ошибка команды одинаково
        // означают, что пул использовался.
        markActive();
      }
    },

    async spawnBackground(req: ExecRequest): Promise<ExecBackgroundProcess> {
      const port = await resolve();
      if (!port.spawnBackground) {
        // Тот же машинный код, что у удалённого порта старой версии
        // (протокол < 3): «фон не поддерживается» — не «есть метод, но падает».
        throw new ExecutionError({
          message: 'executor does not support background processes (features.background)',
          code: EXECUTION_BACKGROUND_UNSUPPORTED_CODE,
          reason: 'spawn_failed',
        });
      }
      const process = await port.spawnBackground(req);
      // Долгий фоновый процесс — тоже активность пула (пул живёт, пока
      // процесс работает).
      markActive();
      return process;
    },

    async browserCall(req: BrowserCallRequest): Promise<BrowserCallResult> {
      const port = await resolve();
      if (!port.browserCall) {
        // Внутренний порт без browser-вызова (не удалённый клиент либо
        // старая реализация): понятный отказ, а не «тихий» пустой результат.
        return {
          content: 'browser execution is unavailable in the current execution environment',
          isError: true,
        };
      }
      try {
        return await port.browserCall(req);
      } finally {
        // Обращение к пулу — активность (как у execute): provisioner не должен
        // снять пул по idle между вызовами браузера.
        markActive();
      }
    },

    async probe(bin: string, args?: string[]): Promise<boolean> {
      const port = await resolve();
      return port.probe ? port.probe(bin, args) : true;
    },

    async capabilitySummary(bin: string): Promise<ExecutionCapabilitySummary> {
      const port = await resolve();
      if (!port.capabilitySummary) {
        throw new Error('capabilitySummary не поддерживается портом');
      }
      return port.capabilitySummary(bin);
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
function createPooledFs(resolve: () => Promise<ExecutionPort>): ExecutionFs {
  const fsOf = async (): Promise<ExecutionFs> => {
    const port = await resolve();
    if (!port.fs) {
      throw new ExecutionFsUnavailableError();
    }
    return port.fs;
  };

  return {
    async realpath(path: string): Promise<string> {
      return (await fsOf()).realpath(path);
    },
    async stat(path: string) {
      return (await fsOf()).stat(path);
    },
    async readdir(path: string) {
      return (await fsOf()).readdir(path);
    },
    async readText(path: string, opts) {
      return (await fsOf()).readText(path, opts);
    },
    async sniff(path: string, maxBytes?: number) {
      return (await fsOf()).sniff(path, maxBytes);
    },
    async readBytes(path: string, maxBytes: number) {
      return (await fsOf()).readBytes(path, maxBytes);
    },
    async writeFile(path: string, content: string): Promise<void> {
      await (await fsOf()).writeFile(path, content);
    },
    async mkdir(path: string): Promise<void> {
      await (await fsOf()).mkdir(path);
    },
    async remove(path: string): Promise<void> {
      await (await fsOf()).remove(path);
    },
    async readRawText(path: string, maxBytes: number) {
      return (await fsOf()).readRawText(path, maxBytes);
    },
    async rename(from: string, to: string): Promise<void> {
      await (await fsOf()).rename(from, to);
    },
    async download(path: string, maxBytes: number): Promise<Buffer> {
      return (await fsOf()).download(path, maxBytes);
    },
    async upload(path: string, bytes: Buffer, opts) {
      await (await fsOf()).upload(path, bytes, opts);
    },
    async hash(path: string): Promise<string> {
      return (await fsOf()).hash(path);
    },
  };
}
