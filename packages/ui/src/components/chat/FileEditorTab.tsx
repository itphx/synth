import { useEffect, useState, useCallback } from 'react'
import { useFilesStore } from '@/stores/filesStore'
import { useUIStore } from '@/stores/useUIStore'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { Icon } from '../icon/Icon'
import type { CenterTab } from '@/stores/useUIStore'

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

interface FileEditorTabProps {
  tab: CenterTab
}

export function FileEditorTab({ tab }: FileEditorTabProps) {
  const { t } = useI18n()
  const { writeFile } = useFilesStore()
  const { closeTab } = useUIStore()
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [isBinary, setIsBinary] = useState(false)
  const [binarySize, setBinarySize] = useState(0)

  const projectId = tab.data.projectId
  const filePath = tab.data.filePath

  useEffect(() => {
    if (!projectId || !filePath) {
      setLoading(false)
      setError(t('file.loadError'))
      return
    }

    setLoading(true)
    setError(null)

    synthApi.readFile(projectId, filePath)
      .then((result) => {
        if (result.encoding === 'binary') {
          setIsBinary(true)
          setBinarySize(result.size)
        } else {
          setIsBinary(false)
          setContent(result.content)
          setOriginalContent(result.content)
        }
        setLoading(false)
      })
      .catch((e) => {
        setError((e as Error).message)
        setLoading(false)
      })
  }, [projectId, filePath, t])

  const isDirty = content !== originalContent

  const handleSave = useCallback(async () => {
    if (!projectId || !filePath || !isDirty) return

    setSaveState('saving')
    const ok = await writeFile(projectId, filePath, content)
    if (ok) {
      setOriginalContent(content)
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 2000)
    } else {
      setSaveState('error')
    }
  }, [projectId, filePath, content, originalContent, isDirty, writeFile])

  const handleClose = useCallback(() => {
    if (isDirty) {
      if (!window.confirm(t('file.unsavedChanges'))) return
    }
    closeTab(tab.id)
  }, [isDirty, tab.id, closeTab, t])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave])

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
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs font-mono text-muted-foreground truncate flex-1">
          {filePath}
        </span>
        <div className="flex items-center gap-1">
          <span className={`text-xs ${saveState === 'saving' ? 'text-yellow-500' : saveState === 'saved' ? 'text-green-500' : saveState === 'error' ? 'text-red-500' : isDirty ? 'text-yellow-500' : 'text-muted-foreground'}`}>
            {saveState === 'saving' ? t('file.saving')
              : saveState === 'saved' ? t('file.saved')
              : saveState === 'error' ? t('file.saveError')
              : isDirty ? t('common.modified')
              : ''}
          </span>
          <button
            onClick={handleSave}
            disabled={!isDirty || saveState === 'saving'}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Icon name="save" className="size-3" />
            <span>{t('common.save')}</span>
          </button>
          <button
            onClick={handleClose}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-foreground hover:bg-interactive-hover transition-colors"
          >
            <Icon name="x" className="size-3" />
            <span>{t('file.close')}</span>
          </button>
        </div>
      </div>

      <textarea
        className="flex-1 w-full resize-none bg-background p-4 text-sm font-mono text-foreground outline-none border-0 focus:ring-0"
        value={content}
        onChange={(e) => {
          setContent(e.target.value)
          setSaveState('dirty')
        }}
        spellCheck={false}
      />
    </div>
  )
}
