/**
 * Среда исполнения инструментов — вид системного блока `[СРЕДА ИСПОЛНЕНИЯ]`
 * (`prompts/system/ENVIRONMENT.<kind>.{ru,en}.md`).
 *
 * Вид среды — константа инстанса: топология исполнения задаётся при старте
 * процесса (инвариант 24), поэтому блок кэшируется в stable-префиксе промпта
 * (ADR-070 §2.1) и не меняется от хода к ходу.
 */

import type { ExecutionMode, ExecutionPooling } from '@itphx/synth-shared';

/** Виды среды исполнения, для которых есть системный промпт. */
export const EXECUTION_ENVIRONMENT_KINDS = [
  'inline',
  'remote-instance',
  'remote-project',
] as const;

/**
 * - `inline` — исполнение в процессе Synth (машина пользователя, без контейнера);
 * - `remote-instance` — удалённый исполнитель, общий пул на инстанс;
 * - `remote-project` — удалённый исполнитель, пул на проект (или сессию).
 */
export type ExecutionEnvironmentKind = (typeof EXECUTION_ENVIRONMENT_KINDS)[number];

/**
 * Вид среды по эффективной конфигурации исполнения: режим + режим пула.
 *
 * `inline` → `inline`; `remote` + пул инстанса → `remote-instance`;
 * `remote` + пул проекта/сессии → `remote-project`.
 */
export function resolveExecutionEnvironmentKind(
  mode: ExecutionMode,
  pooling: ExecutionPooling,
): ExecutionEnvironmentKind {
  if (mode !== 'remote') return 'inline';
  return pooling === 'instance' ? 'remote-instance' : 'remote-project';
}
