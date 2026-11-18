// ADR-076 (этап 1): чистые хелперы статуса рабочего дерева для дерева Files
// и Git-вкладки. Индекс — по пути относительно корня workspace, чтобы запись
// дерева (`entry.path`) и файл репозитория (`files[].path`) сравнивались напрямую.
import type {
  GitFileStatusKind,
  GitRepoWorktreeStatus,
} from '@itphx/synth-shared/types'

/** Запись статуса файла, приведённая к системе координат workspace. */
export interface GitStatusEntry {
  kind: GitFileStatusKind
  staged: boolean
  unstaged: boolean
  /** Путь репозитория относительно workspace (`''` — корень). */
  repoPath: string
  /** Путь файла относительно корня репозитория. */
  repoRelativePath: string
}

/** Виды из индекса — tracked-изменения (untracked/ignored в счётчик не входят). */
const TRACKED_KINDS: ReadonlySet<GitFileStatusKind> = new Set<GitFileStatusKind>([
  'added',
  'modified',
  'deleted',
  'renamed',
  'typechange',
  'conflict',
])

/** Tracked-изменение (untracked/ignored — не изменение набора). */
export function isTrackedKind(kind: GitFileStatusKind): boolean {
  return TRACKED_KINDS.has(kind)
}

/**
 * Точка-индикатор рисуется только у tracked-видов: `untracked` и `ignored`
 * показываются цветом названия (зелёное / приглушённое), без точки.
 */
export function hasVcsDot(kind: GitFileStatusKind): boolean {
  return isTrackedKind(kind)
}

/**
 * Приоритет агрегата по каталогу: конфликт важнее удаления, удаление — добавления
 * и так далее. `untracked` замыкает список (каталог с новыми файлами — зелёный),
 * `ignored` в агрегат **не** входит: игнорируемое содержимое не приглушает
 * родителей — вид `ignored` даёт только запись о самом каталоге.
 */
const KIND_PRIORITY: readonly GitFileStatusKind[] = [
  'conflict',
  'deleted',
  'added',
  'modified',
  'typechange',
  'renamed',
  'untracked',
]

/**
 * Нормализация пути: `\` → `/`, без хвостового `/` (git с `--ignored=matching`
 * отдаёт каталоги вида `node_modules/`), `.` — корень.
 */
function normalizePath(path: string | undefined): string {
  let value = (path ?? '').replace(/\\/g, '/')
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  if (value === '/' || value === '.') return ''
  while (value.startsWith('./')) value = value.slice(2)
  return value
}

/**
 * Индекс «путь от корня workspace → статус». Вложенные репозитории: побеждает
 * самый длинный `repo.path` (префикс по границе `/`), иначе файл внутреннего
 * репозитория получал бы статус внешнего.
 */
export function buildStatusIndex(repos: GitRepoWorktreeStatus[]): Map<string, GitStatusEntry> {
  const index = new Map<string, GitStatusEntry>()
  for (const repo of repos ?? []) {
    if (!repo || !Array.isArray(repo.files)) continue
    const repoPath = normalizePath(repo.path)
    for (const file of repo.files) {
      const repoRelativePath = normalizePath(file.path)
      if (!repoRelativePath) continue
      const workspacePath = repoPath ? `${repoPath}/${repoRelativePath}` : repoRelativePath
      const prev = index.get(workspacePath)
      if (prev && prev.repoPath.length > repoPath.length) continue
      index.set(workspacePath, {
        kind: file.kind,
        staged: Boolean(file.staged),
        unstaged: Boolean(file.unstaged),
        repoPath,
        repoRelativePath,
      })
    }
  }
  return index
}

/** Статус файла по пути от корня workspace (нет записи — `undefined`). */
export function fileStatus(
  index: Map<string, GitStatusEntry>,
  workspacePath: string,
): GitStatusEntry | undefined {
  return index.get(normalizePath(workspacePath))
}

/**
 * Агрегат по каталогу: вид — по приоритету (конфликт → … → untracked), `count` —
 * только tracked-изменения (untracked/ignored счётчик не увеличивают).
 *
 * Запись **ровно по пути каталога** (`node_modules/` для `ignored`, `Test/` для
 * нового каталога — после нормализации это путь без `/`) задаёт вид самому
 * каталогу: без неё новый каталог не отмечался, а игнорируемый не приглушался.
 * `ignored` из потомков вверх не агрегируется — приглушается только сам элемент.
 * Корень (`''`) агрегирует весь workspace — UI сам решает не красить его имя.
 */
export function dirStatus(
  index: Map<string, GitStatusEntry>,
  dirPath: string,
): { kind: GitFileStatusKind; count: number } | null {
  const dir = normalizePath(dirPath)
  const prefix = dir ? `${dir}/` : ''
  const ownKind = dir ? index.get(dir)?.kind : undefined
  // Собственная запись каталога: `ignored` вне списка приоритетов — держим
  // отдельным флагом, чтобы агрегат потомков (если он есть) её перекрывал.
  const ownIgnored = ownKind === 'ignored'
  let bestRank = ownKind ? KIND_PRIORITY.indexOf(ownKind) : -1
  let count = 0
  for (const [path, entry] of index) {
    if (!path || (prefix && !path.startsWith(prefix))) continue
    if (TRACKED_KINDS.has(entry.kind)) count += 1
    // Игнорируемое содержимое родителя не приглушает.
    if (entry.kind === 'ignored') continue
    const rank = KIND_PRIORITY.indexOf(entry.kind)
    if (rank >= 0 && (bestRank === -1 || rank < bestRank)) bestRank = rank
  }
  if (bestRank === -1) return ownIgnored ? { kind: 'ignored', count } : null
  return { kind: KIND_PRIORITY[bestRank]!, count }
}

/**
 * Репозиторий файла: самый длинный подходящий `repo.path` с проверкой границы
 * `/` (`sub` не матчит `submarine/x`). `null` — файл вне зарегистрированных
 * репозиториев проекта.
 */
export function repoForFile(
  repos: GitRepoWorktreeStatus[],
  workspacePath: string,
): { repoPath: string; repoRelativePath: string } | null {
  const target = normalizePath(workspacePath)
  if (!target) return null
  let best: { repoPath: string; repoRelativePath: string } | null = null
  for (const repo of repos ?? []) {
    if (!repo) continue
    const repoPath = normalizePath(repo.path)
    let repoRelativePath: string | null = null
    if (repoPath === '') {
      repoRelativePath = target
    } else if (target.startsWith(`${repoPath}/`)) {
      repoRelativePath = target.slice(repoPath.length + 1)
    }
    if (repoRelativePath === null) continue
    if (!best || repoPath.length > best.repoPath.length) {
      best = { repoPath, repoRelativePath }
    }
  }
  return best
}
