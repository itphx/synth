/**
 * Sweep осиротевших записей worktree'ов при старте процесса (ADR-114 §7.4).
 *
 * Запись инвентаря переживает исчезновение каталога: пользователь мог удалить
 * каталог руками, а `git worktree prune` — убрать метаданные. Такая запись
 * показывалась бы в UI как «worktree без каталога», а удаление падало бы с
 * «нет каталога» (ADR-114 §1.2, §7.3). Sweep удаляет **только записи без
 * каталога**: живые записи не трогаются, каталоги не удаляются, `git worktree
 * prune` здесь **не** выполняется (чистку метаданных делает prune проекта).
 *
 * Характер запуска — **фоновый, best-effort**:
 *
 * - старт процесса **не блокируется** (обещание не ожидается);
 * - ошибка sweep **не роняет старт** — уходит в лог (`warning`, ADR-036/ADR-094:
 *   без стектрейсов и без секретов);
 * - повторный запуск в том же процессе не нужен: sweep одноразовый.
 *
 * По образцу соседних фоновых уборок (`engine/background/prune.ts`,
 * `engine/processes/prune.ts`, `engine/events/journal-prune.ts`): ошибка
 * логируется и не пробрасывается.
 */
import { warning } from '../../logger.js';

/** Минимальный контракт для sweep'а — структурно совместим с `WorktreeService`. */
export interface WorktreeSweeperTarget {
  /** Удалить записи без каталога; возвращает число удалённых записей. */
  sweepOrphans(): Promise<{ recordsRemoved: number }>;
}

/**
 * Запустить sweep осиротевших записей worktree'ов (фоново, без падения).
 *
 * Вызывается при старте процесса (core `server/app/deps.ts` и backend
 * `app/deps.ts`) — после сборки сервиса worktree'ов и порта инвентаря.
 *
 * @param service Сервис worktree'ов (или любой объект с `sweepOrphans`).
 */
export function startWorktreeSweeper(service: WorktreeSweeperTarget): void {
  void service
    .sweepOrphans()
    .then((result) => {
      if (result.recordsRemoved > 0) {
        warning('WORKTREE', `вычищено осиротевших записей worktree: ${result.recordsRemoved}`);
      }
    })
    .catch((err: unknown) => {
      warning(
        'WORKTREE',
        `sweep осиротевших записей worktree не удался: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}
