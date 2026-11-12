/**
 * Точка входа процесса provisioner'а пулов исполнения (PROP-135, Ф4b-2a).
 *
 * Provisioner — отдельный процесс (`Service`/Deployment, PROP-135 §4b-2b) с
 * узкой ролью: по запросу control plane выдать адрес и токен пула
 * исполнителя. Он не знает ни про сессии, ни про хранилище Synth.
 *
 * Порядок старта:
 *
 * 1. конфигурация из env (`resolveProvisionerConfig`) — **fail-closed**: без
 *    токена или с невалидным JSON процесс не стартует;
 * 2. токен удаляется из `process.env` (`scrubProvisionerToken`) — в окружении
 *    он не нужен никому;
 * 3. создаются провайдер, метрики и сервис пулов, запускается reaper
 *    (таймер `unref` — процесс не держит);
 * 4. поднимается HTTP-сервер (`startProvisionerServer`), в лог уходят адрес,
 *    порт, провайдер и лимиты — **никогда** не токен;
 * 5. graceful shutdown по `SIGINT`/`SIGTERM`: reaper останавливается, сервер
 *    закрывается, процесс завершается с кодом `0`.
 *
 * Запуск: `node dist/main.js`.
 */

import { pathToFileURL } from 'node:url';
import { resolveProvisionerConfig, scrubProvisionerToken } from './config.js';
import { createProvisionerMetrics } from './metrics.js';
import { PoolService } from './pool-service.js';
import { createPoolProvisioner } from './provider.js';
import { startProvisionerServer } from './server.js';

/** Код выхода при штатном завершении. */
const EXIT_OK = 0;

/** Время ожидания завершения in-flight запросов при остановке, мс. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Запустить provisioner.
 *
 * @throws Error если конфигурация невалидна (fail-closed) или порт занят.
 */
export async function main(): Promise<void> {
  const config = resolveProvisionerConfig();
  // Токен больше не нужен в окружении процесса — убираем.
  scrubProvisionerToken();

  const provider = createPoolProvisioner(config);
  const metrics = createProvisionerMetrics({ profiles: Object.keys(config.profiles) });
  const service = new PoolService({
    provider,
    metrics,
    idleTimeoutMs: config.idleTimeoutMs,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    maxLifetimeMs: config.maxLifetimeMs,
    drainGraceMs: config.drainGraceMs,
    maxPools: config.maxPools,
    reaperIntervalMs: config.reaperIntervalMs,
  });
  metrics.setPoolSource(() => service.list());
  service.startReaper();

  const handle = await startProvisionerServer({
    token: config.token,
    service,
    metrics,
    providerName: config.provider,
    limits: {
      maxPools: config.maxPools,
      idleTimeoutMs: config.idleTimeoutMs,
      sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
      maxLifetimeMs: config.maxLifetimeMs,
      drainGraceMs: config.drainGraceMs,
    },
    host: config.host,
    port: config.port,
  });

  console.log(
    `[provisioner] слушает ${handle.host}:${handle.port} ` +
      `(провайдер: ${config.provider}; профилей: ${Object.keys(config.profiles).length}; ` +
      `статических пулов: ${Object.keys(config.staticPools).length}; ` +
      `лимит пулов: ${config.maxPools}; idle: ${config.idleTimeoutMs} мс / ` +
      `сессионный: ${config.sessionIdleTimeoutMs} мс; ` +
      `maxLifetime: ${config.maxLifetimeMs} мс; drain grace: ${config.drainGraceMs} мс; ` +
      `reaper: ${config.reaperIntervalMs} мс)`,
  );

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[provisioner] получен ${signal} — останавливаюсь`);
    service.stopReaper();
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
    console.error(
      `[provisioner] запуск не удался: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
