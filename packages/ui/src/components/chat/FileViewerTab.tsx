import { useEffect, useState } from 'react'
import { useUIStore } from '@/stores/useUIStore'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { Icon } from '../icon/Icon'
import type { CenterTab } from '@/stores/useUIStore'

interface FileViewerTabProps {
  tab: CenterTab
}

export function FileViewerTab({ tab }: FileViewerTabProps) {
  const { t } = useI18n()
  const { openTab } = useUIStore()
  const [content, setContent] = useState<string | null>(null)
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
          setContent(null)
        } else {
          setIsBinary(false)
          setContent(result.content)
        }
        setLoading(false)
      })
      .catch((e) => {
        setError((e as Error).message)
        setLoading(false)
      })
  }, [projectId, filePath, t])

  const handleEdit = () => {
    if (!projectId || !filePath) return
    openTab({
      id: `edit-${projectId}/${filePath}`,
      type: 'file-editor',
      title: tab.title,
      data: { filePath, projectId },
    })
  }

  const handleDownload = () => {
    if (!projectId || !filePath) return
    const url = synthApi.downloadFile(projectId, filePath)
    const a = document.createElement('a')
    a.href = url
    a.download = tab.title
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

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

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs font-mono text-muted-foreground truncate flex-1">
          {filePath}
        </span>
        <div className="flex items-center gap-1">
          {!isBinary && (
            <button
              onClick={handleEdit}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-foreground hover:bg-interactive-hover transition-colors"
              title={t('file.edit')}
            >
              <Icon name="edit-2" className="size-3" />
              <span>{t('file.edit')}</span>
            </button>
          )}
          <button
            onClick={handleDownload}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-foreground hover:bg-interactive-hover transition-colors"
            title={t('file.download')}
          >
            <Icon name="download" className="size-3" />
            <span>{t('file.download')}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {isBinary ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <Icon name="file-3" className="size-12" />
              <span className="text-sm">{t('file.binaryFile', { size: String(binarySize) })}</span>
            </div>
          </div>
        ) : (
          <pre className="p-4 text-sm font-mono text-foreground whitespace-pre-wrap break-words min-h-full">
            {content}
          </pre>
        )}
      </div>
    </div>
  )
}
