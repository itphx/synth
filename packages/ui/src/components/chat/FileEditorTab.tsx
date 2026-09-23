import { useEffect, useState, useCallback } from 'react'
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
