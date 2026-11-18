import { useEffect, useState, useCallback, useRef } from 'react'
import { useFilesStore } from '@/stores/filesStore'
import { useUIStore } from '@/stores/useUIStore'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { isCodeViewSupported } from '@/lib/codeEditor'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { CodeEditor } from './CodeEditor'
import type { CenterTab } from '@/stores/useUIStore'

interface FileEditorTabProps {
  tab: CenterTab
}

/** Состояние сохранения (панель вкладки): подпись и цвет статуса. */
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** Отказ чтения: файл больше лимита (или бинарный) — `413 FILE_TOO_LARGE`. */
interface ReadTooLarge {
  size: number
  limit: number
  reason: string
}

/** Размер файла для сообщения: байты → KiB/MiB. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Признак отказа «файл слишком большой/бинарный» (машинный код сервера). */
function isTooLargeError(
  e: unknown,
): e is { status: number; code: string; details?: Record<string, unknown> } {
  const err = e as { status?: number; code?: string; details?: Record<string, unknown> } | null
  return err?.status === 413 && err?.code === 'FILE_TOO_LARGE'
}

export function FileEditorTab({ tab }: FileEditorTabProps) {
  const { t } = useI18n()
  const writeFile = useFilesStore(s => s.writeFile)
  const setTabEditingState = useUIStore(s => s.setTabEditingState)
  const closeTab = useUIStore(s => s.closeTab)
  const [content, setContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isBinary, setIsBinary] = useState(false)
  const [binarySize, setBinarySize] = useState(0)
  // Файл не прочитан: сервер отказал по лимиту чтения (413 FILE_TOO_LARGE).
  const [tooLarge, setTooLarge] = useState<ReadTooLarge | null>(null)
  // fs.changed: файл изменён агентом на диске, но у пользователя есть правки.
  const [changedOnDisk, setChangedOnDisk] = useState(false)

  const projectId = tab.data.projectId
  const filePath = tab.data.filePath

  const loadFromServer = useCallback(async () => {
    if (!projectId || !filePath) return
    setLoading(true)
    setError(null)
    setTooLarge(null)
    try {
      const result = await synthApi.readFile(projectId, filePath)
      if (result.encoding === 'binary') {
        setIsBinary(true)
        setBinarySize(result.size)
      } else {
        setIsBinary(false)
        // Восстанавливаем несохранённый черновик (если есть): файл остаётся
        // «грязным», а актуальное серверное содержимое становится оригиналом.
        const draft = useFilesStore.getState().draftContents[`${projectId}::${filePath}`]
        if (draft !== undefined && draft !== result.content) {
          setContent(draft)
          setOriginalContent(result.content)
        } else {
          setContent(result.content)
          setOriginalContent(result.content)
          useFilesStore.getState().clearDraft(projectId, filePath)
        }
        // Файл успешно перечитан — пометка «удалён агентом» больше не актуальна.
        useFilesStore.getState().clearDeletedFile(projectId, filePath)
      }
      setChangedOnDisk(false)
    } catch (e) {
      // Файл отсутствует на диске — сервер отдаёт 404/NOT_FOUND. Так удаляют
      // «широкие» тулы (`execute_shell rm`, `git_checkout`), для которых в
      // `fs.changed` нет `op:'delete'`. Помечаем удаление: рендерится
      // `file.deletedOnDisk` с кнопкой «Перечитать». Иначе не затираем уже
      // выставленное состояние удаления ошибкой.
      const e2 = e as { status?: number; code?: string; details?: Record<string, unknown> }
      const key = `${projectId}::${filePath}`
      if (isTooLargeError(e)) {
        // Файл больше лимита чтения (или бинарный) — понятное сообщение вместо
        // пустого редактора: причина, размер и лимит.
        setTooLarge({
          size: Number(e.details?.size ?? 0),
          limit: Number(e.details?.maxReadBytes ?? 0),
          reason: String(e.details?.reason ?? 'size'),
        })
        setError(null)
      } else if (e2.status === 404 || e2.code === 'NOT_FOUND') {
        useFilesStore.getState().markDeletedFile(projectId, filePath)
      } else if (!useFilesStore.getState().deletedFiles[key]) {
        setError((e as Error).message)
      }
    } finally {
      setLoading(false)
    }
  }, [projectId, filePath])

  useEffect(() => {
    if (!projectId || !filePath) {
      setLoading(false)
      setError(t('file.loadError'))
      return
    }
    void loadFromServer()
  }, [projectId, filePath, t, loadFromServer])

  // fs.changed (fsStore.revisionByProject/fileRevisions): если файл не грязный —
  // молча перечитываем с диска; если у пользователя есть правки — не затираем их,
  // показываем баннер с кнопкой «Перечитать»; если файл удалён агентом — состояние
  // «Файл удалён» с кнопкой «Перечитать».
  const revision = useFilesStore((s) => (projectId ? s.revisionByProject[projectId] : undefined))
  const fileKey = projectId && filePath ? `${projectId}::${filePath}` : ''
  const fileRevision = useFilesStore((s) => (fileKey ? s.fileRevisions[fileKey] : undefined))
  const isDeleted = useFilesStore((s) => (fileKey ? Boolean(s.deletedFiles[fileKey]) : false))
  const revisionRef = useRef(revision)
  const fileRevisionRef = useRef(fileRevision)
  useEffect(() => {
    const revisionChanged = revision !== revisionRef.current
    const fileRevisionChanged = fileRevision !== fileRevisionRef.current
    revisionRef.current = revision
    fileRevisionRef.current = fileRevision
    if (!revisionChanged && !fileRevisionChanged) return
    if (!projectId || !filePath) return
    if (isDeleted) {
      setChangedOnDisk(false)
      return
    }
    if (content !== originalContent) {
      setChangedOnDisk(true)
      return
    }
    void loadFromServer()
  }, [revision, fileRevision, projectId, filePath, content, originalContent, isDeleted, loadFromServer])

  const isDirty = content !== originalContent

  const syncEditingState = useCallback((state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error') => {
    setTabEditingState(tab.id, state)
  }, [tab.id, setTabEditingState])

  useEffect(() => {
    if (!loading && !isBinary) {
      syncEditingState(isDirty ? 'dirty' : 'idle')
    }
  }, [isDirty, loading, isBinary, syncEditingState])

  const doSave = useCallback(async () => {
    if (!projectId || !filePath || !isDirty) return

    setSaveState('saving')
    syncEditingState('saving')
    const ok = await writeFile(projectId, filePath, content)
    if (ok) {
      setOriginalContent(content)
      useFilesStore.getState().clearDraft(projectId, filePath)
      setChangedOnDisk(false)
      setSaveState('saved')
      syncEditingState('saved')
      setTimeout(() => {
        setSaveState('idle')
        syncEditingState('idle')
      }, 2000)
    } else {
      setSaveState('error')
      syncEditingState('error')
    }
  }, [projectId, filePath, content, isDirty, writeFile, syncEditingState])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        doSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [doSave])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.tabId === tab.id) {
        doSave()
      }
    }
    window.addEventListener('synth:save-file', handler)
    return () => window.removeEventListener('synth:save-file', handler)
  }, [tab.id, doSave])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Icon name="loader-2" className="size-8 animate-spin" />
          <span className="text-sm">{t('common.loading')}...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Icon name="alert-triangle" className="size-8 text-status-error" />
          <span className="text-sm">{error}</span>
        </div>
      </div>
    )
  }

  if (tooLarge) {
    const isBinaryReason = tooLarge.reason === 'binary'
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="flex max-w-md flex-col items-center gap-3 px-4 text-center text-muted-foreground">
          <Icon name="file-3" className="size-12" />
          <span className="text-sm" data-testid="file-too-large">
            {isBinaryReason
              ? t('file.binaryNotReadable')
              : t('file.tooLarge', { size: formatSize(tooLarge.size), limit: formatSize(tooLarge.limit) })}
          </span>
          {projectId && filePath && (
            <a
              href={synthApi.downloadFile(projectId, filePath)}
              download={filePath.split('/').pop()}
              className="rounded border border-border px-3 py-1 text-xs text-foreground hover:bg-muted"
            >
              {t('file.download')}
            </a>
          )}
        </div>
      </div>
    )
  }

  if (isBinary) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Icon name="file-3" className="size-12" />
          <span className="text-sm">{t('file.binaryFile', { size: String(binarySize) })}</span>
          {projectId && filePath && (
            <a
              href={synthApi.downloadFile(projectId, filePath)}
              download={filePath.split('/').pop()}
              className="rounded border border-border px-3 py-1 text-xs text-foreground hover:bg-muted"
            >
              {t('file.download')}
            </a>
          )}
        </div>
      </div>
    )
  }

  if (isDeleted) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Icon name="delete-bin" className="size-12" />
          <span className="text-sm">{t('file.deletedOnDisk')}</span>
          <button
            type="button"
            onClick={() => void loadFromServer()}
            className="rounded border border-border px-3 py-1 text-xs text-foreground hover:bg-muted"
          >
            {t('file.reload')}
          </button>
        </div>
      </div>
    )
  }

  const statusLabel =
    saveState === 'saving'
      ? t('file.saving')
      : saveState === 'saved'
        ? t('file.saved')
        : saveState === 'error'
          ? t('file.saveError')
          : isDirty
            ? t('common.modified')
            : ''

  const statusClass =
    saveState === 'saving'
      ? 'text-status-warning'
      : saveState === 'saved'
        ? 'text-status-success'
        : saveState === 'error'
          ? 'text-status-error'
          : isDirty
            ? 'text-status-warning'
            : 'text-muted-foreground'

  /** Разметка панели: слева — действия с иконками и статус, справа — пусто. */
  const toolButton =
    'inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted pointer-coarse:min-h-10'

  return (
    <div className="flex h-full flex-1 flex-col bg-background">
      <div
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1"
        data-testid="file-editor-toolbar"
      >
        <button
          type="button"
          onClick={() => void doSave()}
          disabled={!isDirty || saveState === 'saving'}
          data-testid="file-save"
          title={t('common.save')}
          className={cn(
            toolButton,
            isDirty && saveState !== 'saving'
              ? 'border-primary/50 bg-primary/10'
              : 'opacity-50 cursor-default',
          )}
        >
          <Icon name="save" className="size-3.5 shrink-0" />
          <span className="whitespace-nowrap">
            {saveState === 'saving' ? t('file.saving') : t('common.save')}
          </span>
        </button>
        {projectId && filePath && (
          <a
            href={synthApi.downloadFile(projectId, filePath)}
            download={filePath.split('/').pop()}
            data-testid="file-download"
            title={t('file.download')}
            className={toolButton}
          >
            <Icon name="download" className="size-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t('file.download')}</span>
          </a>
        )}
        <button
          type="button"
          onClick={() => closeTab(tab.id)}
          data-testid="file-close"
          title={t('common.close')}
          className={toolButton}
        >
          <Icon name="close" className="size-3.5 shrink-0" />
          <span className="whitespace-nowrap">{t('common.close')}</span>
        </button>
        <span className={cn('px-1 text-xs', statusClass)} data-testid="file-editor-status">
          {statusLabel}
        </span>
      </div>
      {changedOnDisk && (
        <div className="flex items-center justify-between gap-3 border-b border-status-warning/40 bg-status-warning/10 px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-xs text-status-warning">
            <Icon name="alert-triangle" className="size-3.5 shrink-0" />
            {t('file.changedOnDisk')}
          </span>
          <button
            type="button"
            onClick={() => void loadFromServer()}
            className="shrink-0 rounded border border-status-warning/50 px-2 py-0.5 text-xs text-status-warning hover:bg-status-warning/15"
          >
            {t('file.reload')}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {isCodeViewSupported(content) ? (
          <CodeEditor
            value={content}
            filePath={filePath ?? ''}
            onChange={(value) => {
              setContent(value)
              if (projectId && filePath) {
                useFilesStore.getState().setDraft(projectId, filePath, value, originalContent)
              }
            }}
            testId="file-editor-code"
          />
        ) : (
          <>
            <div
              className="border-b border-border px-4 py-1 text-xs text-muted-foreground"
              data-testid="file-plain-large"
            >
              {t('file.plainLarge')}
            </div>
            <textarea
              className="h-full w-full resize-none border-0 bg-background p-4 font-mono text-sm text-foreground outline-none focus:ring-0"
              value={content}
              onChange={(e) => {
                const v = e.target.value
                setContent(v)
                if (projectId && filePath) {
                  useFilesStore.getState().setDraft(projectId, filePath, v, originalContent)
                }
              }}
              spellCheck={false}
            />
          </>
        )}
      </div>
    </div>
  )
}
