/**
 * Единый реестр фоновых прогонов (этап 1 roadmap 0.13 — блок 4).
 *
 * Баррель подсистемы: сервис реестра, retention-очистка и типы.
 */
export {
  BackgroundRunService,
  BACKGROUND_RUN_ID_PREFIX,
  BACKGROUND_TERMINAL_STATUSES,
  buildSubagentNotification,
  type BackgroundRunServiceOptions,
} from './service.js';
export {
  startBackgroundRunPruner,
  type BackgroundRunPrunerOptions,
} from './prune.js';
export {
  BackgroundRunError,
  BackgroundLimitExceededError,
  BACKGROUND_ERROR_CODES,
  type BackgroundErrorCode,
  type BackgroundFinalState,
  type BackgroundFinishPatch,
  type BackgroundLogger,
  type BackgroundRunLimits,
  type BackgroundRunState,
  type BackgroundSubagentInput,
} from './types.js';
