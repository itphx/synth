/**
 * Подсистема «git worktree» (ADR-114) — сервис и типизированные ошибки.
 *
 * Публичный API модуля: `WorktreeService` (поведение: создание, список,
 * удаление, prune, sweep, детект secondary) и набор ошибок с машинными кодами
 * (для HTTP-контура и будущих тулов).
 */
export { WorktreeService, resolveWorktreeName } from './service.js';
export type {
  WorktreeServiceOptions,
  WorktreeCreateResult,
  WorktreeSetupResult,
  WorktreeRemoveOptions,
  WorktreePruneResult,
  WorktreeSweepResult,
  WorktreeSecondaryInfo,
} from './service.js';
export {
  WORKTREE_ERROR_CODES,
  worktreeErrorHttpStatus,
  isWorktreeError,
  WorktreeError,
  WorktreeNotFoundError,
  WorktreeBusyError,
  WorktreeDirtyError,
  WorktreeBranchInvalidError,
  WorktreeNameInvalidError,
  WorktreeNotARepoError,
  WorktreePathExistsError,
  WorktreeDirectoryMissingError,
  WorktreeGitFailedError,
} from './errors.js';
export type { WorktreeErrorCode } from './errors.js';
