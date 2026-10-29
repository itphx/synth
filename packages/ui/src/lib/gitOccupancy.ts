// ADR-076: разбор машиночитаемой причины 409 у `POST /git/repos/clone`.
//
// Сервер различает три состояния занятого пути и отдаёт их в
// `error.details = {path, occupied: 'repo'|'stub'|'dir', entries?}`. Пользователю
// в каждом случае нужно РАЗНОЕ действие, поэтому выбор действия — чистая
// функция (тестируется отдельно, без React и сети).

/** Вид занятия пути (зеркалит серверный `RepoOccupancy`). */
export type RepoOccupancy = 'repo' | 'stub' | 'dir'

/** Действие, которое UI предлагает для занятого пути. */
export type RepoOccupiedAction = 'register' | 'delete-and-retry' | 'choose-path'

/** Разобранные `details` отказа клонирования. */
export interface RepoOccupiedDetails {
  /** Относительный путь внутри workspace, который занят. */
  path: string
  occupied: RepoOccupancy
  /** Число записей верхнего уровня — только у `dir`. */
  entries?: number
}

/** Максимально допустимая длина пути — защита от мусора в ответе. */
const MAX_PATH_LENGTH = 4096

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * Разбирает `details` отказа клонирования (defensive: поле аддитивное и
 * приходит из сети). `null` — деталей нет или состояние неизвестно: тогда UI
 * показывает прежний текст без кнопок.
 */
export function repoOccupiedDetails(details: unknown): RepoOccupiedDetails | null {
  const raw = asRecord(details)
  if (!raw) return null
  const occupied = raw.occupied
  if (occupied !== 'repo' && occupied !== 'stub' && occupied !== 'dir') return null
  const path = typeof raw.path === 'string' ? raw.path : ''
  if (path.length > MAX_PATH_LENGTH) return null
  const out: RepoOccupiedDetails = { path, occupied }
  if (typeof raw.entries === 'number' && Number.isFinite(raw.entries)) out.entries = raw.entries
  return out
}

/**
 * Действие по занятому пути (ADR-076):
 * - `repo` — существующий репозиторий: зарегистрировать (повторный клон не нужен);
 * - `stub` — след прерванного клона (`.git` без коммитов): удалить и повторить;
 * - `dir` — непустой каталог без git: указать другой путь.
 */
export function repoOccupiedAction(details: unknown): RepoOccupiedAction | null {
  const parsed = repoOccupiedDetails(details)
  if (!parsed) return null
  switch (parsed.occupied) {
    case 'repo':
      return 'register'
    case 'stub':
      return 'delete-and-retry'
    default:
      return 'choose-path'
  }
}

/**
 * Можно ли удалить занятый путь перед повтором клонирования: пустой путь и
 * корень workspace (`''`/`.`) удалять нельзя — это не след одного репозитория.
 */
export function canDeleteOccupiedPath(details: RepoOccupiedDetails | null): boolean {
  if (!details) return false
  const path = details.path.trim()
  return path !== '' && path !== '.'
}
