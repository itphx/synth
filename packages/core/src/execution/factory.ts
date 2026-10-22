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
 * ## Без process-глобальных синглтонов (инвариант 24)
 *
 * Фабрика **создаёт новый экземпляр на каждый вызов**: порт — не глобальное
 * состояние, а зависимость сборки приложения. Переинициализировать порт «на
 * лету» нельзя — `execution.mode` это **параметр запуска** (смена — только
 * рестартом), поэтому экземпляр живёт столько же, сколько процесс.
 */

import type { ResolvedExecutionConfig } from '@itphx/synth-shared';
import { InlineExecutionPort } from './inline-execution-port.js';
import type { ExecutionPort } from './ports/index.js';
import { createRemoteExecutionPortFromConfig } from './remote.js';

/**
 * Собрать порт исполнения для заданного режима.
 *
 * @param config эффективная секция `execution` (`resolveExecutionConfig`);
 *                 не задана — `inline` (прежнее поведение)
 * @returns порт исполнения для оркестратора, тулов и детекта зависимостей
 */
export async function createExecutionPortForConfig(
  config?: ResolvedExecutionConfig | null,
): Promise<ExecutionPort> {
  if (!config || config.mode !== 'remote') return new InlineExecutionPort();
  return createRemoteExecutionPortFromConfig(config);
}
