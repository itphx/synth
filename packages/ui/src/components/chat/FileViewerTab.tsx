import { useEffect, useState } from 'react'
import { fileKind } from '@itphx/synth-shared/types'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { Icon } from '../icon/Icon'
import { MarkdownContent } from './MarkdownContent'
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

/** Ссылка «Скачать» — доступна во всех режимах (в т.ч. для медиа). */
function DownloadLink({ projectId, filePath }: { projectId?: string; filePath?: string }) {
  const { t } = useI18n()
  if (!projectId || !filePath) return null
  return (
    <a
      href={synthApi.downloadFile(projectId, filePath)}
      download={filePath.split('/').pop()}
      className="rounded border border-border px-3 py-1 text-xs text-foreground hover:bg-muted"
    >
      {t('file.download')}
    </a>
  )
}

export function FileViewerTab({ tab }: FileViewerTabProps) {
  const { t } = useI18n()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isBinary, setIsBinary] = useState(false)
  const [binarySize, setBinarySize] = useState(0)
  const [tooLarge, setTooLarge] = useState<ReadTooLarge | null>(null)
  // Медиа не удалось показать браузером (битый файл / отвергнутый предпросмотр).
  const [previewFailed, setPreviewFailed] = useState(false)
  // Markdown: по умолчанию рендер, «Исходник» — `<pre>`.
  const [markdownSource, setMarkdownSource] = useState(false)

  const projectId = tab.data.projectId
  const filePath = tab.data.filePath
  const fileName = filePath ? (filePath.split('/').pop() ?? filePath) : ''
  const kind = filePath ? fileKind(filePath) : 'binary'
  // Медиа отдаётся inline через `/fs/raw`; текст/код/markdown/неизвестное — чтением.
  const isMedia = kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf'
  const isMarkdown = kind === 'markdown'

  useEffect(() => {
    setContent(null)
    setIsBinary(false)
    setBinarySize(0)
    setTooLarge(null)
    setPreviewFailed(false)
    setMarkdownSource(false)
    setError(null)

    if (!projectId || !filePath) {
      setLoading(false)
      setError(t('file.loadError'))
      return
    }

    let cancelled = false
    setLoading(true)

    if (isMedia) {
      // Предпросмотр может быть отвергнут до загрузки байтов: 413 по
      // `storage.maxPreviewBytes`, 404/403. Показываем причину и «Скачать».
      synthApi
        .probeRawFile(projectId, filePath)
        .then((probe) => {
          if (cancelled) return
          if (!probe.ok && probe.status !== 0) {
            if (probe.status === 413 && probe.reason === 'preview_size') {
              setTooLarge({ size: probe.size, limit: probe.limit ?? 0, reason: 'preview_size' })
            } else {
              setError(probe.message || t('file.previewFailed'))
            }
          }
          setLoading(false)
        })
        .catch(() => {
          // Проверка недоступна — пробуем показать элемент; его собственная
          // ошибка (`onError`) переведёт экран в «не удалось показать».
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
      }
    }

    synthApi
      .readFile(projectId, filePath)
      .then((result) => {
        if (cancelled) return
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
        if (cancelled) return
        if (isTooLargeError(e)) {
          // Файл больше лимита чтения (или бинарный) — понятное сообщение
          // вместо пустого экрана.
          setTooLarge({
            size: Number(e.details?.size ?? 0),
            limit: Number(e.details?.maxReadBytes ?? e.details?.maxPreviewBytes ?? 0),
            reason: String(e.details?.reason ?? 'size'),
          })
        } else {
          setError((e as Error).message)
        }
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, filePath, isMedia, t])

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
        <div className="flex max-w-md flex-col items-center gap-3 px-4 text-center text-muted-foreground">
          <Icon name="alert-triangle" className="size-8 text-status-error" />
          <span className="text-sm">{error}</span>
          {/* Любой отказ (404/403/сеть) оставляет возможность скачать файл. */}
          <DownloadLink projectId={projectId} filePath={filePath} />
        </div>
      </div>
    )
  }

  if (tooLarge) {
    const isBinaryReason = tooLarge.reason === 'binary'
    const isPreviewSize = tooLarge.reason === 'preview_size'
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="flex max-w-md flex-col items-center gap-3 px-4 text-center text-muted-foreground">
          <Icon name="file-3" className="size-12" />
          <span className="text-sm" data-testid="file-too-large">
            {isBinaryReason
              ? t('file.binaryNotReadable')
              : isPreviewSize
                ? t('file.previewTooLarge', {
                    size: formatSize(tooLarge.size),
                    limit: formatSize(tooLarge.limit),
                  })
                : t('file.tooLarge', {
                    size: formatSize(tooLarge.size),
                    limit: formatSize(tooLarge.limit),
                  })}
          </span>
          {/* Кнопка «Скачать» есть всегда — в т.ч. для бинарного файла и медиа. */}
          <DownloadLink projectId={projectId} filePath={filePath} />
        </div>
      </div>
    )
  }

  if (previewFailed) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="flex max-w-md flex-col items-center gap-3 px-4 text-center text-muted-foreground">
          <Icon name="alert-triangle" className="size-12 text-status-error" />
          <span className="text-sm" data-testid="file-preview-failed">
            {t('file.previewFailed')}
          </span>
          <DownloadLink projectId={projectId} filePath={filePath} />
        </div>
      </div>
    )
  }

  // Медиа: inline-предпросмотр через `/fs/raw` (Range/ETag — на сервере).
  if (isMedia && projectId && filePath) {
    const url = synthApi.rawFileUrl(projectId, filePath)
    const handleMediaError = () => setPreviewFailed(true)
    return (
      <div className="flex flex-1 h-full flex-col bg-background">
        <div className="flex shrink-0 items-center justify-end gap-3 border-b border-border px-3 py-1">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {t('file.openInNewTab')}
          </a>
          <DownloadLink projectId={projectId} filePath={filePath} />
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          {kind === 'image' && (
            <img
              src={url}
              alt={fileName}
              className="max-h-full max-w-full object-contain"
              onError={handleMediaError}
            />
          )}
          {kind === 'video' && (
            <video
              controls
              preload="metadata"
              src={url}
              className="max-h-full max-w-full"
              onError={handleMediaError}
            />
          )}
          {kind === 'audio' && (
            <audio controls preload="metadata" src={url} onError={handleMediaError} />
          )}
          {kind === 'pdf' && (
            <iframe src={url} className="h-full w-full border-0" title={fileName} />
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
          <DownloadLink projectId={projectId} filePath={filePath} />
        </div>
      </div>
    )
  }

  const showMarkdown = isMarkdown && content !== null
  return (
    <div className="flex flex-1 h-full flex-col bg-background">
      {showMarkdown && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1">
          <button
            type="button"
            onClick={() => setMarkdownSource(false)}
            aria-pressed={!markdownSource}
            className={
              markdownSource
                ? 'rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted'
                : 'rounded bg-muted px-2 py-1 text-xs text-foreground'
            }
          >
            {t('file.markdownPreview')}
          </button>
          <button
            type="button"
            onClick={() => setMarkdownSource(true)}
            aria-pressed={markdownSource}
            className={
              markdownSource
                ? 'rounded bg-muted px-2 py-1 text-xs text-foreground'
                : 'rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted'
            }
          >
            {t('file.markdownSource')}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {showMarkdown && !markdownSource ? (
          <div className="p-4">
            <MarkdownContent content={content ?? ''} />
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
