import { useEffect, useState } from 'react'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { Icon } from '../icon/Icon'
import type { CenterTab } from '@/stores/useUIStore'

interface FileViewerTabProps {
  tab: CenterTab
}

export function FileViewerTab({ tab }: FileViewerTabProps) {
  const { t } = useI18n()
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

  return (
    <div className="flex flex-1 h-full flex-col bg-background">
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
