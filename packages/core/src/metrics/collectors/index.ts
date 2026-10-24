/**
 * ADR-094: доменные коллекторы метрик.
 *
 * Каждый модуль регистрирует метрики в общем `MetricsRegistry` и, если нужно,
 * возвращает колбэк/функцию остановки. Ошибки метрик не должны влиять на
 * основной поток — все записи обёрнуты вызывающими точками.
 */
export { attachBusMetrics } from './bus.js';
export type { TurnOutcome } from './bus.js';
export { startSessionMetrics, SESSIONS_METRICS_INTERVAL_MS } from './sessions.js';
export {
  startStorageMetrics,
  DATADIR_KINDS,
  STORAGE_BYTES_INTERVAL_MS,
  STORAGE_RECORDS_INTERVAL_MS,
} from './storage.js';
export type { StorageMetricsSources } from './storage.js';
export {
  createEventMetrics,
  startEventJournalMetrics,
  EVENT_JOURNAL_INTERVAL_MS,
} from './events.js';
export type { EventMetricsHooks } from './events.js';
export { createSchedulerMetrics } from './scheduler.js';
export type { SchedulerJobInfo, SchedulerJobMetrics } from './scheduler.js';
export {
  createPipelineMetrics,
  normalizePipelineRunStatus,
  normalizePipelineStepOutcome,
  normalizePipelineNodeKind,
  normalizePipelineGateKind,
  normalizePipelineTriggerSource,
  PIPELINE_RUN_DURATION_BUCKETS,
  PIPELINE_STEP_DURATION_BUCKETS,
  PIPELINE_WAIT_DURATION_BUCKETS,
} from './pipelines.js';
export type {
  PipelineGateMetricKind,
  PipelineMetricsHooks,
  PipelineNodeMetricKind,
  PipelineRunMetricStatus,
  PipelineStepMetricOutcome,
  PipelineTriggerMetricSource,
} from './pipelines.js';
export { createWebhookMetrics } from './webhooks.js';
export type {
  WebhookDeliveryInfo,
  WebhookDeliveryMetrics,
  WebhookDeliveryOutcome,
} from './webhooks.js';
export { registerDecisionMetrics } from './decision.js';
export {
  createAuthorityMetrics,
  normalizeAuthorityAction,
  normalizeAuthorityEffect,
  normalizeAuthoritySource,
} from './authority.js';
export type {
  AuthorityMetricAction,
  AuthorityMetricEffect,
  AuthorityMetricSource,
  AuthorityMetricsHooks,
} from './authority.js';
export { attachHybridMetrics, normalizeRemoteOp } from './hybrid.js';
export type { HybridMetricsHooks, RemoteRequestInfo } from './hybrid.js';
export {
  startMemoryMetrics,
  MEMORY_FACTS_METRIC,
  MEMORY_INDEXES_METRIC,
  MEMORY_METRIC_FACT_STATUSES,
  MEMORY_METRIC_INDEX_STATES,
} from './memory.js';
export type { MemoryMetricsSources } from './memory.js';
export { setSynthReady } from './ready.js';
export { createLlmCallRecorder } from './llm.js';
export type { LlmCallInfo, LlmCallOutcome } from './llm.js';
