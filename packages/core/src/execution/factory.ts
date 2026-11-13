/**
 * Выбор порта исполнения по режиму (`execution.mode`) — ADR-077, шаг 7b.
 *
 * Единственная точка, где «топология исполнения» превращается в конкретную
 * реализацию порта:
 *
 * - `inline` — `InlineExecutionPort` (исполнение в процессе control plane) —
 *   прежнее поведение, ничего не меняется;
 * - `remote` — удалённый порт из пакета `@itphx/synth-executor` (динамический
 *   `import()`, fail-closed — см. `execution/remote.ts`).
 *
 * PROP-135 Ф4b-1 добавляет **провайдера пулов** (`execution.remote.provider`):
 * при `http` адрес и токен пула приходят от provisioner'а, поэтому порт
 * собирается **лениво** (`execution/pooled-port.ts`), а не на старте.
 *
 * ## Без process-глобальных синглтонов (инвариант 24)
 *
 * Фабрика **создаёт новый экземпляр на каждый вызов**: порт — не глобальное
 * состояние, а зависимость сборки приложения. Переинициализировать порт «на
 * лету» нельзя — `execution.mode` это **параметр запуска** (смена — только
 * рестартом), поэтому экземпляр живёт столько же, сколько процесс.
 */

import type { ResolvedExecutionConfig } from '@itphx/synth-shared';
import { InlineExecutionPort } from './inline-execution-port.js';
import type { ExecutionMetricsSink, ExecutionPort } from './ports/index.js';
import { createExecutionPoolProvider, type ExecutionPoolProvider } from './pool-provider.js';
import { createPooledExecutionPort } from './pooled-port.js';
import type { ExecutionPoolRef } from './pool-provider.js';
import { createRemoteExecutionPortForPool, createRemoteExecutionPortFromConfig } from './remote.js';

/**
 * Собрать порт исполнения для заданного режима.
 *
 * @param config эффективная секция `execution` (`resolveExecutionConfig`);
 *                 не задана — `inline` (прежнее поведение)
 * @param opts приёмник метрик исполнения (ADR-094) — передаётся удалённому
 *             порту; в `inline` режиме не используется (исполнение в процессе
 *             control plane метриками пула не измеряется)
 * @returns порт исполнения для оркестратора, тулов и детекта зависимостей
 */
export async function createExecutionPortForConfig(
  config?: ResolvedExecutionConfig | null,
  opts?: { metricsSink?: ExecutionMetricsSink },
): Promise<ExecutionPort> {
  if (!config || config.mode !== 'remote') return new InlineExecutionPort();
  return createRemoteExecutionPortFromConfig(config, opts);
}

/**
 * Собрать **instance-порт** процесса (PROP-135 Ф4b-1).
 *
 * Отличие от `createExecutionPortForConfig`: при `provider: http` адреса
 * исполнителей приходят от provisioner'а, поэтому статический порт не
 * собирается (в `remote`-режиме без `execution.remote.url` он и не собрался
 * бы — fail-closed на «нет адреса»). Вместо него — **ленивый порт на
 * instance-пул**: адрес запрашивается у provisioner'а при первом обращении.
 *
 * Instance-level потребление порта (inline-shell, медиа-раннер, worktree/
 * process/MCP, детект зависимостей) остаётся на этом порте — это общий порт
 * инстанса, независимо от режима пулов (`project`/`session`).
 *
 * @param config эффективная секция `execution`
 * @param opts приёмник метрик исполнения + провайдер пулов (тесты)
 */
export async function createInstanceExecutionPort(
  config: ResolvedExecutionConfig | undefined,
  opts?: { metricsSink?: ExecutionMetricsSink; poolProvider?: ExecutionPoolProvider },
): Promise<ExecutionPort> {
  if (!config || config.mode !== 'remote') return new InlineExecutionPort();
  if (config.remote.provider !== 'http') {
    return createRemoteExecutionPortFromConfig(config, opts);
  }
  const provider = opts?.poolProvider ?? createExecutionPoolProvider(config.remote);
  return createPooledExecutionPort({
    key: {
      scope: 'instance',
      class: 'exec',
      profile: config.remote.defaultProfile,
    },
    provider,
    createPort: defaultPooledPortFactory(config, opts?.metricsSink),
  });
}

/**
 * Фабрика порта по умолчанию для пула: адрес пула → реальный порт.
 *
 * - пул выдал **токен** → удалённый порт на этот адрес и токен
 *   (`createRemoteExecutionPortForPool`);
 * - пул токена не выдал → порт по конфигурации профиля
 *   (`createExecutionPortForConfig`), токен исполнителя читается из файла
 *   (инвариант 13).
 *
 * @param profileConfig эффективная секция `execution` профиля
 * @param metricsSink приёмник метрик исполнения
 */
export function defaultPooledPortFactory(
  profileConfig: ResolvedExecutionConfig | undefined,
  metricsSink?: ExecutionMetricsSink,
): (ref: ExecutionPoolRef) => Promise<ExecutionPort> {
  return async (ref: ExecutionPoolRef): Promise<ExecutionPort> => {
    if (ref.token) {
      const remote = profileConfig?.remote;
      return createRemoteExecutionPortForPool({
        url: ref.url,
        token: ref.token,
        ...(remote?.timeoutMs !== undefined ? { timeoutMs: remote.timeoutMs } : {}),
        ...(remote?.concurrency !== undefined ? { concurrency: remote.concurrency } : {}),
        ...(remote?.failMode !== undefined ? { failMode: remote.failMode } : {}),
        ...(remote?.browserMcpServer !== undefined
          ? { browserMcpServer: remote.browserMcpServer }
          : {}),
        ...(metricsSink ? { metricsSink } : {}),
      });
    }
    return createExecutionPortForConfig(
      profileConfig,
      metricsSink ? { metricsSink } : undefined,
    );
  };
}
