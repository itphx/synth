import { useEffect, useState, useCallback, useRef } from 'react'
import { useFilesStore } from '@/stores/filesStore'
import { useUIStore } from '@/stores/useUIStore'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { Icon } from '../icon/Icon'
import type { CenterTab } from '@/stores/useUIStore'

interface FileEditorTabProps {
  tab: CenterTab
}

export function FileEditorTab({ tab }: FileEditorTabProps) {
  const { t } = useI18n()
  const writeFile = useFilesStore(s => s.writeFile)
  const setTabEditingState = useUIStore(s => s.setTabEditingState)
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isBinary, setIsBinary] = useState(false)
  const [binarySize, setBinarySize] = useState(0)
  // fs.changed: файл изменён агентом на диске, но у пользователя есть правки.
  const [changedOnDisk, setChangedOnDisk] = useState(false)

  const projectId = tab.data.projectId
  const filePath = tab.data.filePath

  const loadFromServer = useCallback(async () => {
    if (!projectId || !filePath) return
    setLoading(true)
    setError(null)
    try {
      const result = await synthApi.readFile(projectId, filePath)
      if (result.encoding === 'binary') {
        setIsBinary(true)
        setBinarySize(result.size)
      } else {
        setIsBinary(false)
        setContent(result.content)
        setOriginalContent(result.content)
      }
      setChangedOnDisk(false)
    } catch (e) {
      setError((e as Error).message)
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

  // fs.changed (fsStore.revisionByProject): если файл не грязный — молча
  // перечитываем с диска; если у пользователя есть правки — не затираем их,
  // показываем баннер с кнопкой «Перечитать».
  const revision = useFilesStore((s) => (projectId ? s.revisionByProject[projectId] : undefined))
  const revisionRef = useRef(revision)
  useEffect(() => {
    if (revision === revisionRef.current) return
    revisionRef.current = revision
    if (!projectId || !filePath) return
    if (content !== originalContent) {
      setChangedOnDisk(true)
      return
    }
    void loadFromServer()
  }, [revision, projectId, filePath, content, originalContent, loadFromServer])

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

    syncEditingState('saving')
    const ok = await writeFile(projectId, filePath, content)
    if (ok) {
      setOriginalContent(content)
      setChangedOnDisk(false)
      syncEditingState('saved')
      setTimeout(() => syncEditingState('idle'), 2000)
    } else {
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
          <Icon name="alert-triangle" className="size-8 text-red-500" />
          <span className="text-sm">{error}</span>
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
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 h-full flex-col bg-background">
      {changedOnDisk && (
        <div className="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <Icon name="alert-triangle" className="size-3.5 shrink-0" />
            {t('file.changedOnDisk')}
          </span>
          <button
            type="button"
            onClick={() => void loadFromServer()}
            className="shrink-0 rounded border border-amber-500/50 px-2 py-0.5 text-xs text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
          >
            {t('file.reload')}
          </button>
        </div>
      )}
      <textarea
        className="flex-1 w-full resize-none bg-background p-4 text-sm font-mono text-foreground outline-none border-0 focus:ring-0"
        value={content}
        onChange={(e) => {
          setContent(e.target.value)
        }}
        spellCheck={false}
      />
    </div>
  )
}
