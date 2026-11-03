import { useEffect, useState } from 'react'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { Icon } from '../icon/Icon'
import type { CenterTab } from '@/stores/useUIStore'

interface FileViewerTabProps {
  tab: CenterTab
}

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

export function FileViewerTab({ tab }: FileViewerTabProps) {
  const { t } = useI18n()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isBinary, setIsBinary] = useState(false)
  const [binarySize, setBinarySize] = useState(0)
  const [tooLarge, setTooLarge] = useState<ReadTooLarge | null>(null)

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
    setTooLarge(null)

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
        if (isTooLargeError(e)) {
          // Файл больше лимита чтения (или бинарный) — понятное сообщение
          // вместо пустого экрана.
          setTooLarge({
            size: Number(e.details?.size ?? 0),
            limit: Number(e.details?.maxReadBytes ?? 0),
            reason: String(e.details?.reason ?? 'size'),
          })
          setLoading(false)
          return
        }
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
          {!isBinaryReason && projectId && filePath && (
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
