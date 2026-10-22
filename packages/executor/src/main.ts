/**
 * Точка входа процесса исполнителя (ADR-077, шаг 7a).
 *
 * Исполнитель — отдельный процесс (контейнер `synth-executor`): он не знает
 * ни про сессии, ни про хранилище Synth — только корень workspace, в котором
 * выполняются команды агента, и токен доступа к своему API.
 *
 * Порядок старта:
 *
 * 1. конфигурация из env (`resolveExecutorConfig`) — **fail-closed**: без
 *    токена или без корня workspace процесс не стартует;
 * 2. токен удаляется из `process.env` (`scrubExecutorToken`) — иначе он попал бы
 *    в окружение дочерних процессов и утек в текст команды, который видит
 *    модель;
 * 3. поднимается HTTP-сервер (`startExecutorServer`), в лог уходят адрес и
 *    порт (токен — никогда);
 * 4. graceful shutdown по `SIGINT`/`SIGTERM`: сервер закрывается, процесс
 *    завершается с кодом `0`.
 *
 * Запуск: `node dist/main.js` (в образе — `/app/dist/main.js`).
 */

import { pathToFileURL } from 'node:url';
import { resolveExecutorConfig, scrubExecutorToken } from './config.js';
import { startExecutorServer } from './server.js';

/** Код выхода при штатном завершении. */
const EXIT_OK = 0;

/** Время ожидания завершения in-flight запросов при остановке, мс. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Запустить исполнитель.
 *
 * @throws Error если конфигурация невалидна (fail-closed) или порт занят.
 */
export async function main(): Promise<void> {
  const config = resolveExecutorConfig();
  // Токен больше не нужен в окружении процесса — убираем (см. модуль config).
  scrubExecutorToken();

  const handle = await startExecutorServer({
    token: config.token,
    workspaceRoot: config.workspaceRoot,
    maxConcurrency: config.maxConcurrency,
    maxTimeoutMs: config.maxTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    host: config.host,
    port: config.port,
  });

  console.log(
    `[executor] исполнитель слушает ${handle.host}:${handle.port} ` +
      `(workspace: ${config.workspaceRoot}; лимит команд: ${config.maxConcurrency}; ` +
      `потолок таймаута: ${config.maxTimeoutMs} мс; потолок вывода: ${config.maxOutputBytes} байт)`,
  );

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[executor] получен ${signal} — останавливаюсь`);
    const timer = setTimeout(() => process.exit(EXIT_OK), SHUTDOWN_GRACE_MS);
    timer.unref?.();
    handle
      .close()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        process.exit(EXIT_OK);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** Этот модуль запущен как точка входа (`node dist/main.js`). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err: unknown) => {
    console.error(`[executor] запуск не удался: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
