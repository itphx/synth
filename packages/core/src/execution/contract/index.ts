/**
 * Контрактный suite порта исполнения (ADR-077, шаги 1 и 7b).
 *
 * По образцу `storage/contract/` — набор проверок, обязательный для ЛЮБОЙ
 * реализации порта (`InlineExecutionPort` — исполнение в процессе, удалённый
 * порт — HTTP к исполнителю `@itphx/synth-executor`).
 *
 * Эталон контракта и прогон против удалённого исполнителя живут **в core**
 * (как `storage/contract/postgres.test.ts` против драйвера БД): дублировать
 * набор проверок в пакете исполнителя нельзя — источник истины один.
 */

export {
  describeExecutionPort,
  describeInlineOnlyExecutionChecks,
  describeRemoteOnlyExecutionChecks,
} from './execution.js';
export type { ExecutionPortHarness, ExecutionPortHarnessFactory } from './execution.js';
