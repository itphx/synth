import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/Toggle'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import type { FileEntry, WorkspaceOutsideRootPolicy } from '@itphx/synth-shared/types'

export interface DirectoryPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Текущее значение workspace — показывается как выбранное (не обязательно внутри root). */
  value?: string | null
  /** Колбэк выбора каталога (кнопка «Выбрать этот каталог»). */
  onSelect: (path: string) => void
  /** Стартовое состояние тумблера «Показать скрытые». */
  includeHiddenDefault?: boolean
}

/** Ошибка от `fetchJSON` несёт HTTP-статус и (ADR-075) серверный `code`. */
type ApiError = { status?: number; code?: string }

type NavErrorKey = 'workspace.error.denied' | 'workspace.loadError'
type CreateErrorKey =
  | 'workspace.error.denied'
  | 'workspace.error.confirmRequired'
  | 'workspace.error.createFailed'
  | 'workspace.error.alreadyExists'

const DENIED_CODES = new Set(['WORKSPACE_OUTSIDE_ROOT_DENIED', 'PROTECTED_PATH_DENIED'])

function isDeniedError(error: unknown): boolean {
  const e = error as ApiError
  return e?.status === 403 || (e?.code ? DENIED_CODES.has(e.code) : false)
}

function navErrorKey(error: unknown): NavErrorKey {
  return isDeniedError(error) ? 'workspace.error.denied' : 'workspace.loadError'
}

function createErrorKey(error: unknown): CreateErrorKey {
  const e = error as ApiError
  if (e?.code === 'ALREADY_EXISTS') return 'workspace.error.alreadyExists'
  if (e?.code === 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED') return 'workspace.error.confirmRequired'
  if (isDeniedError(error)) return 'workspace.error.denied'
  return 'workspace.error.createFailed'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Абсолютный путь для выбора: server-канонический (относительный внутри root) → абсолютный. */
function toAbsolute(root: string, path: string): string {
  if (!path) return root
  if (path.startsWith('/')) return path
  return `${root.replace(/\/+$/, '')}/${path}`
}

/** Путь дочернего каталога: сохраняет абсолютность/относительность базы. */
function childPath(base: string, name: string): string {
  return base ? `${base.replace(/\/+$/, '')}/${name}` : name
}

/** POSIX `dirname`: родитель абсолютного пути (`/a/b` → `/a`, `/a` → `/`, `/` → ''). */
function parentDir(path: string): string {
  if (!path || path === '/') return ''
  const normalized = path.replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  if (idx < 0) return ''
  return idx === 0 ? '/' : normalized.slice(0, idx)
}

/** Защищённые сервером пути (если приходят с флагом) не показываем. */
function isEntryDenied(entry: FileEntry): boolean {
  return (entry as FileEntry & { denied?: boolean }).denied === true
}

/**
 * ADR-075: модальный диалог выбора/создания каталога против корня workspace
 * (`/fs/workspace-root*`). Источник данных — `synthApi` (работает и для managed
 * backend, и для standalone core). Подтверждение создания вне root — ConfirmDialog.
 */
export function DirectoryPickerDialog({
  open,
  onOpenChange,
  value,
  onSelect,
  includeHiddenDefault = false,
}: DirectoryPickerDialogProps) {
  const { t } = useI18n()

  const [root, setRoot] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [includeHidden, setIncludeHidden] = useState(includeHiddenDefault)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newFolder, setNewFolder] = useState('')
  const [creating, setCreating] = useState(false)
  const [pendingCreate, setPendingCreate] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [selectConfirmOpen, setSelectConfirmOpen] = useState(false)
  // ADR-075: выход за `workspacesRoot` разрешён только по политике `confirm` и не в read-only.
  const [outsideRoot, setOutsideRoot] = useState<WorkspaceOutsideRootPolicy>('deny')
  const [policyReadOnly, setPolicyReadOnly] = useState(false)

  const loadPolicy = useCallback(async () => {
    try {
      const policy = await synthApi.getWorkspacePolicy()
      setOutsideRoot(policy.outsideRoot === 'confirm' ? 'confirm' : 'deny')
      setPolicyReadOnly(policy.readOnly === true)
    } catch {
      // Безопасный дефолт: политику не удалось прочитать — считаем `deny`.
      setOutsideRoot('deny')
      setPolicyReadOnly(false)
    }
  }, [])

  const loadRoot = useCallback(async (hidden: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const res = await synthApi.getWorkspaceRoot(hidden)
      setRoot(res.root)
      setEntries(res.entries)
      setCurrentPath('')
      setHistory([])
    } catch (e) {
      setError(t(navErrorKey(e), { error: errorText(e) }))
    } finally {
      setLoading(false)
    }
  }, [t])

  const loadDirectory = useCallback(async (path: string, hidden: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const res = await synthApi.browseWorkspaceRoot(path, hidden)
      setRoot(res.root)
      setEntries(res.entries)
      setCurrentPath(res.path)
    } catch (e) {
      setError(t(navErrorKey(e), { error: errorText(e) }))
    } finally {
      setLoading(false)
    }
  }, [t])

  // Загрузка корня при открытии; сброс состояния при закрытии.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setIncludeHidden(includeHiddenDefault)
      setCurrentPath('')
      setHistory([])
      setEntries([])
      setNewFolder('')
      setError(null)
      void loadPolicy()
      void loadRoot(includeHiddenDefault)
    }
    if (!open) {
      setConfirmOpen(false)
      setSelectConfirmOpen(false)
      setPendingCreate(null)
    }
    wasOpenRef.current = open
  }, [open, includeHiddenDefault, loadRoot, loadPolicy])

  const selectablePath = toAbsolute(root, currentPath)
  const visibleEntries = entries.filter((entry) => !isEntryDenied(entry))
  // Выход за `workspacesRoot` разрешён политикой `confirm` вне read-only.
  const canGoOutside = outsideRoot === 'confirm' && !policyReadOnly
  const parent = parentDir(selectablePath)
  // `parent === ''` — уже файловая система целиком (`/`) или путь без родителя.
  const canGoUp = history.length > 0 || (canGoOutside && parent !== '')
  // Сервер вернул абсолютный `path` → мы вне корня (внутри — относительный/пустой).
  const isOutsideRoot = currentPath.startsWith('/')

  const navigateInto = (entry: FileEntry) => {
    if (isEntryDenied(entry)) return
    setHistory((h) => [...h, currentPath])
    void loadDirectory(entry.path, includeHidden)
  }

  const goUp = () => {
    // Есть история — обычный «назад».
    if (history.length > 0) {
      const previous = history[history.length - 1]
      setHistory((h) => h.slice(0, -1))
      void loadDirectory(previous, includeHidden)
      return
    }
    // Истории нет (мы в корне): по политике `confirm` поднимаемся в родителя корня.
    if (!canGoOutside || parent === '') return
    void loadDirectory(parent, includeHidden)
  }

  const toggleHidden = () => {
    const next = !includeHidden
    setIncludeHidden(next)
    void loadDirectory(currentPath, next)
  }

  const createFolder = async (confirmOutsideRoot: boolean, target: string) => {
    setCreating(true)
    setError(null)
    try {
      await synthApi.mkdirWorkspaceRoot(target, confirmOutsideRoot)
      setNewFolder('')
      await loadDirectory(currentPath, includeHidden)
    } catch (e) {
      if (!confirmOutsideRoot && (e as ApiError)?.code === 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED') {
        setPendingCreate(target)
        setConfirmOpen(true)
      } else {
        setError(t(createErrorKey(e), { error: errorText(e) }))
      }
    } finally {
      setCreating(false)
    }
  }

  const submitNewFolder = () => {
    const name = newFolder.trim()
    if (!name || creating) return
    void createFolder(false, childPath(currentPath, name))
  }

  const confirmOutsideCreate = () => {
    const target = pendingCreate
    setPendingCreate(null)
    if (target) void createFolder(true, target)
  }

  const handleSelectCurrent = () => {
    // Выбор вне корня — только после явного подтверждения.
    if (isOutsideRoot) {
      setSelectConfirmOpen(true)
      return
    }
    onSelect(selectablePath)
    onOpenChange(false)
  }

  const confirmSelectCurrent = () => {
    onSelect(selectablePath)
    setSelectConfirmOpen(false)
    onOpenChange(false)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
        <DialogContent className="max-w-xl">
          <div className="flex items-center gap-2">
            <Icon name="folder-open" className="size-5 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">{t('workspace.dialogTitle')}</h2>
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={goUp}
              disabled={!canGoUp}
              title={t('workspace.goUp')}
              aria-label={t('workspace.goUp')}
              data-testid="workspace-go-up"
            >
              <Icon name="arrow-go-back" className="size-4" />
            </Button>
            <div
              className="flex-1 min-w-0 truncate rounded-lg border border-border bg-interactive/40 px-3 py-1.5 text-xs text-muted-foreground"
              title={selectablePath}
              data-testid="workspace-current-path"
            >
              {selectablePath || t('workspace.noneSelected')}
            </div>
            <label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
              <Toggle
                enabled={includeHidden}
                onToggle={toggleHidden}
                ariaLabel={t('workspace.showHidden')}
              />
              {t('workspace.showHidden')}
            </label>
          </div>

          {isOutsideRoot && (
            <div
              className="flex items-center gap-1.5 text-xs text-status-warning"
              data-testid="workspace-outside-hint"
            >
              <Icon name="alert-triangle" className="size-3.5 shrink-0" />
              {t('workspace.outsideRootHint')}
            </div>
          )}

          <div
            className="min-h-[12rem] max-h-[45vh] overflow-y-auto rounded-lg border border-border p-1"
            data-testid="workspace-entries"
          >
            {loading ? (
              <div className="p-4 text-center text-xs text-muted-foreground" data-testid="workspace-loading">
                {t('common.loading')}
              </div>
            ) : visibleEntries.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground" data-testid="workspace-empty">
                {t('workspace.empty')}
              </div>
            ) : (
              visibleEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => navigateInto(entry)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-interactive-hover"
                  data-testid={`workspace-entry-${entry.name}`}
                >
                  <Icon name="folder" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))
            )}
          </div>

          {error && (
            <div
              role="alert"
              data-testid="workspace-error"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </div>
          )}

          {value && (
            <div className="text-xs text-muted-foreground" data-testid="workspace-value">
              {t('workspace.selected', { path: value })}
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewFolder()
              }}
              placeholder={t('workspace.newFolderPlaceholder')}
              className="flex-1 min-w-0 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              data-testid="workspace-new-folder"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={submitNewFolder}
              disabled={!newFolder.trim() || creating}
              data-testid="workspace-create"
            >
              {t('common.create')}
            </Button>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline-muted" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSelectCurrent}
              data-testid="workspace-select-current"
            >
              {t('workspace.selectCurrent')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('workspace.outsideRootConfirmTitle')}
        message={t('workspace.outsideRootConfirmMessage', { path: pendingCreate ?? '' })}
        variant="warning"
        confirmLabel={t('common.create')}
        onConfirm={confirmOutsideCreate}
      />

      <ConfirmDialog
        open={selectConfirmOpen}
        onOpenChange={setSelectConfirmOpen}
        title={t('workspace.outsideRootSelectTitle')}
        message={t('workspace.outsideRootSelectMessage', { path: selectablePath })}
        variant="warning"
        confirmLabel={t('workspace.select')}
        onConfirm={confirmSelectCurrent}
      />
    </>
  )
}
