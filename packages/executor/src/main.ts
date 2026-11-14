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
 * 2. токен удаляется из `process.env` (`scrubExecutorToken`), как и описание
 *    MCP-серверов (`scrubExecutorMcpServers`) — иначе они попали бы в
 *    окружение дочерних процессов и в текст команды, который видит модель;
 * 3. поднимается HTTP-сервер (`startExecutorServer`), в лог уходят адрес и
 *    порт (токен — никогда); до этого создаётся внешний чекер команд
 *    (PROP-136b): `off` — guard не создаётся, `http`/`opa` — токен читается из
 *    файла и живёт только в памяти guard'а;
 * 4. graceful shutdown по `SIGINT`/`SIGTERM`: сервер закрывается, фоновые
 *    процессы останавливаются (`SIGTERM` → `SIGKILL`), процесс завершается
 *    с кодом `0`.
 *
 * Запуск: `node dist/main.js` (в образе — `/app/dist/main.js`).
 */

import { pathToFileURL } from 'node:url';
import {
  resolveExecutorConfig,
  scrubExecutorMcpServers,
  scrubExecutorToken,
} from './config.js';
import { createCommandPolicyGuard } from './command-policy.js';
import type { ExecutorMetrics } from './metrics.js';
import { sweepStaleSshDirs, startSshSweep } from './secrets.js';
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
  // Описание MCP-серверов (в нём могут быть токены) — тоже убираем: агентская
  // команда не должна видеть секреты других MCP-серверов.
  scrubExecutorMcpServers();

  // Уборка осиротевших каталогов SSH-ключа: прерванный процесс мог не дойти
  // до `finally` — временный ключ не должен лежать в tmp (ADR-077, протокол 4).
  const swept = await sweepStaleSshDirs().catch(() => 0);
  // Периодическая уборка (раз в 10 минут, таймер `unref`): агент, чей
  // владелец умер, иначе жил бы с ключом в памяти до конца жизни инстанса.
  // Стартовая уборка уже выполнена выше — таймер начинает с periodic-тика.
  const stopSshSweep = await startSshSweep({ immediate: false }).catch(() => (): void => {});

  // ADR-094: реестр метрик создаётся **здесь**, а не в сервере, только когда
  // метрики включены: тот же экземпляр нужен чекеру команд (PROP-136b) и
  // серверу; выключенные метрики по-прежнему не тянут реестр в процесс.
  const metrics: ExecutorMetrics | undefined = config.metricsEnabled
    ? (await import('./metrics.js')).createExecutorMetrics()
    : undefined;

  // PROP-136b: внешний чекер команд (enforcement до spawn). `off` → `null`.
  // Токен читается из файла здесь (при старте) и живёт только в guard'е;
  // нечитаемый файл — ошибка старта (fail-closed).
  const policyGuard = createCommandPolicyGuard(config, metrics ? { metrics } : {});

  const handle = await startExecutorServer({
    token: config.token,
    workspaceRoot: config.workspaceRoot,
    maxConcurrency: config.maxConcurrency,
    maxTimeoutMs: config.maxTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    maxBackgroundProcesses: config.backgroundMax,
    backgroundLogMaxBytes: config.backgroundLogMaxBytes,
    ...(config.backgroundLogDir ? { backgroundLogDir: config.backgroundLogDir } : {}),
    ...(config.tlsCaFile ? { tlsCaFile: config.tlsCaFile } : {}),
    // Протокол 8: контур PTY-сессий (терминалы живут на исполнителе).
    ptyEnabled: config.pty.enabled,
    ptyMaxSessions: config.pty.maxSessions,
    ptyIdleTimeoutMs: config.pty.idleTimeoutMs,
    ptyInputMaxBytes: config.pty.inputMaxBytes,
    ...(policyGuard ? { policyGuard } : {}),
    ...(metrics ? { metrics } : {}),
    mcpServers: config.mcpServers,
    host: config.host,
    port: config.port,
    // ADR-094: `/metrics` исполнителя (по умолчанию выключен → 404).
    metricsEnabled: config.metricsEnabled,
  });

  console.log(
    `[executor] исполнитель слушает ${handle.host}:${handle.port} ` +
      `(workspace: ${config.workspaceRoot}; лимит команд: ${config.maxConcurrency}; ` +
      `потолок таймаута: ${config.maxTimeoutMs} мс; потолок вывода: ${config.maxOutputBytes} байт; ` +
      `лимит фоновых процессов: ${config.backgroundMax}; ` +
      `MCP-серверов: ${config.mcpServers.length}; ` +
      `метрики: ${config.metricsEnabled ? 'включены' : 'выключены'}; ` +
      `CA доверия: ${config.tlsCaFile ? 'задан' : 'не задан'}; ` +
      `чекер команд: ${
        config.commandPolicy.provider === 'off'
          ? 'выключен'
          : `${config.commandPolicy.provider} (failMode: ${config.commandPolicy.failMode})`
      }; ` +
      `PTY: ${
        config.pty.enabled
          ? `включён (лимит сессий: ${config.pty.maxSessions}; простой: ${config.pty.idleTimeoutMs} мс)`
          : 'выключен'
      }; ` +
      `удалено старых каталогов SSH: ${swept})`,
  );

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[executor] получен ${signal} — останавливаюсь`);
    stopSshSweep();
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
