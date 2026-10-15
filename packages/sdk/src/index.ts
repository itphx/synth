/**
 * @itphx/synth-sdk — типизированный клиент публичного API Synth (ADR-052).
 *
 * @example
 * ```ts
 * import { createSynthClient } from '@itphx/synth-sdk';
 *
 * const synth = createSynthClient({
 *   baseUrl: 'https://synth.example.com',
 *   serviceKey: 'synth_svc_…',
 * });
 *
 * const { sessionId } = await synth.events.ingest({ source: 'tg', type: 'message' });
 * ```
 */
export { SynthClient, createSynthClient, DEFAULT_API_PATH } from './client.js';
export type {
  SynthClientOptions,
  SynthQuery,
  EventsNamespace,
  SessionsNamespace,
  SchedulesNamespace,
  LlmNamespace,
  SessionsListParams,
  EventJournalParams,
  ScheduleJobsParams,
} from './client.js';
export {
  SynthApiError,
  isSynthApiError,
  parseErrorBody,
  HTTP_ERROR_CODE,
  NETWORK_ERROR_CODE,
} from './errors.js';
export type { SynthApiErrorInit } from './errors.js';
export type * from './types.js';
