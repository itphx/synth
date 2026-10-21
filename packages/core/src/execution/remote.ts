/**
 * Загрузчик удалённого порта исполнения (PROP-077, шаг 7b).
 *
 * Физический исполнитель — **опциональный пакет** `@itphx/synth-executor`
 * (по образцу драйвера хранилища, ADR-096/ADR-097): core **не может**
 * импортировать его статически — иначе typecheck core требовал бы `dist`
 * исполнителя, а сборка исполнителя требует `dist` core (цикл сборки).
 * Поэтому пакет подключается **динамическим `import()`** по строке-константе:
 *
 * ```ts
 * const EXECUTOR_CLIENT_PACKAGE: string = '@itphx/synth-executor/client';
 * mod = (await import(EXECUTOR_CLIENT_PACKAGE)) as ExecutorClientModule;
 * ```
 *
 * Аннотация `string` намеренная: путь не должен резолвиться TypeScript'ом на
 * этапе типов (пакет опционален). Пакет объявлен в `optionalDependencies`
 * core — `pnpm deploy` core включает его.
 *
 * ## Fail-closed
 *
 * Нет пакета / не читается токен / пустой список адресов → **понятная ошибка**,
 * а **не** молчаливый откат в `inline`: тихий возврат означал бы, что оператор
 * запросил удалённое исполнение, а получил локальное (команда ушла бы в
 * control plane с его toolchain'ом — ровно то, чего split-топология исключает).
 *
 * ## Токен
 *
 * `execution.remote.tokenSecret` — это **путь/ссылка**, а не значение
 * (инвариант 13: секреты не хранятся в конфиге). Значение читается из файла
 * по этому пути, **не логируется** и **не попадает в конфиг/ошибки**: в текст
 * ошибки идёт только путь и техническая причина.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ResolvedExecutionConfig } from '@itphx/synth-shared';
import type { ExecutionPort } from './ports/index.js';

/**
 * Пакет исполнителя (клиент удалённого порта). Аннотация `string`
 * намеренная — путь не должен резолвиться TypeScript'ом на этапе типов
 * (пакет опционален), `import()` выполняется только в рантайме.
 */
const EXECUTOR_CLIENT_PACKAGE: string = '@itphx/synth-executor/client';

/** Локальный тип формы модуля пакета (типы пакета не резолвятся статически). */
interface ExecutorClientModule {
  createRemoteExecutionPort(opts: {
    urls: string[];
    token: string;
    timeoutMs?: number;
    concurrency?: number;
    failMode?: 'fail' | 'inline-fallback';
  }): ExecutionPort;
}

/**
 * Техническая причина недоступности удалённого режима (подставляется в
 * ключ `execution.remote_unavailable` — `{reason}`). Тексты движка — EN
 * (ADR-041), поэтому причины — тоже EN.
 */
export const EXECUTOR_PACKAGE_UNAVAILABLE_REASON =
  `executor package '${EXECUTOR_CLIENT_PACKAGE}' is not installed`;

export const EXECUTOR_TOKEN_UNAVAILABLE_REASON =
  'executor token could not be read (execution.remote.tokenSecret / SYNTH_EXECUTION_TOKEN)';

export const EXECUTOR_URL_REQUIRED_REASON =
  'no executor address is configured (execution.remote.url / SYNTH_EXECUTION_REMOTE_URL)';

/**
 * Ошибка недоступности удалённого режима — **fail-closed**.
 *
 * Отдельный класс (как `StorageBackendUnavailableError` в слое хранения):
 * вызывающий отличает «удалённый режим недоступен» от прочих ошибок и не
 * путает её с ошибкой исполнения команды.
 */
export class RemoteExecutionUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RemoteExecutionUnavailableError';
  }
}

/**
 * Прочитать токен исполнителя из файла, указанного в `tokenSecret`.
 *
 * `tokenSecret` — **путь** (инвариант 13), а не значение: пустое значение
 * означает «токен не настроен» → fail-closed. Само значение токена в ошибки
 * не попадает (в текст идёт только путь).
 *
 * @param tokenSecret путь к файлу с bearer-токеном
 * @returns значение токена (без окружающих пробелов)
 */
export async function readExecutorToken(tokenSecret: string): Promise<string> {
  const rawPath = (tokenSecret ?? '').trim();
  if (rawPath.length === 0) {
    throw new RemoteExecutionUnavailableError(
      `remote execution is unavailable: ${EXECUTOR_TOKEN_UNAVAILABLE_REASON} (path is not set)`,
    );
  }
  const path = resolve(rawPath);
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    throw new RemoteExecutionUnavailableError(
      `remote execution is unavailable: ${EXECUTOR_TOKEN_UNAVAILABLE_REASON} (path '${path}')`,
      { cause: err },
    );
  }
  const token = content.trim();
  if (token.length === 0) {
    throw new RemoteExecutionUnavailableError(
      `remote execution is unavailable: ${EXECUTOR_TOKEN_UNAVAILABLE_REASON} (file '${path}' is empty)`,
    );
  }
  return token;
}

/**
 * Доступен ли пакет исполнителя (для стартовой проверки режима).
 *
 * Пакет опционален: в standalone-инстансе без исполнителя его может не быть
 * — это не ошибка сама по себе (режим `inline` не требует пакета), но при
 * `execution.mode=remote` — fail-closed.
 */
export async function isExecutorPackageAvailable(): Promise<boolean> {
  try {
    await import(EXECUTOR_CLIENT_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Собрать удалённый порт исполнения по конфигурации (`execution.mode=remote`).
 *
 * Порядок проверок — от дешёвых к дорогим, все **fail-closed**:
 * адреса → пакет → токен.
 *
 * @param config эффективная секция `execution` (`resolveExecutionConfig`)
 * @returns порт исполнения поверх HTTP-клиента пакета исполнителя
 */
export async function createRemoteExecutionPortFromConfig(
  config: ResolvedExecutionConfig,
): Promise<ExecutionPort> {
  const remote = config.remote;
  const urls = (remote.url ?? []).map((url) => url.trim()).filter((url) => url.length > 0);
  if (urls.length === 0) {
    throw new RemoteExecutionUnavailableError(
      `remote execution is unavailable: ${EXECUTOR_URL_REQUIRED_REASON}`,
    );
  }

  // Токен читается до импорта пакета: чтение локального файла дешево и не
  // зависит от установленного пакета, а значение токена в сообщения об
  // ошибках не попадает (см. `readExecutorToken`).
  const token = await readExecutorToken(remote.tokenSecret);

  let mod: ExecutorClientModule;
  try {
    mod = (await import(EXECUTOR_CLIENT_PACKAGE)) as ExecutorClientModule;
  } catch (err) {
    throw new RemoteExecutionUnavailableError(
      `remote execution is unavailable: ${EXECUTOR_PACKAGE_UNAVAILABLE_REASON} ` +
        `(install it: npm i ${EXECUTOR_CLIENT_PACKAGE})`,
      { cause: err },
    );
  }
  if (!mod || typeof mod.createRemoteExecutionPort !== 'function') {
    throw new RemoteExecutionUnavailableError(
      `remote execution is unavailable: executor package '${EXECUTOR_CLIENT_PACKAGE}' ` +
        `does not export createRemoteExecutionPort()`,
    );
  }

  return mod.createRemoteExecutionPort({
    urls,
    token,
    timeoutMs: remote.timeoutMs,
    concurrency: remote.concurrency,
    failMode: remote.failMode,
  });
}
