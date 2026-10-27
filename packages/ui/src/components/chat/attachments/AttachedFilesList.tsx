// Список черновиков вложений в композере (ADR-115): изображения + чипы файлов.

import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n, type I18nParams } from '@/lib/i18n'
import { formatFileSize } from '@/lib/attachments/file-size'
import {
  MAX_FILES_PER_MESSAGE,
  MAX_FILE_BYTES,
  useAttachmentsStore,
  type DraftAttachment,
  type AttachmentErrorReason,
} from '@/stores/attachmentsStore'

export interface AttachedFilesListProps {
  sessionId: string
  /** Клик по превью изображения — открыть галерею (индекс среди изображений). */
  onOpenImage?: (index: number) => void
}

/** Иконка типа файла из реестра `Icon` (svg-наборы не тянем). */
export function attachmentFileIcon(item: Pick<DraftAttachment, 'mimeType'>): string {
  const mime = item.mimeType.toLowerCase()
  if (mime === 'application/pdf') return 'file-text'
  if (mime.startsWith('audio/')) return 'file-music'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return 'file-code'
  }
  return 'file-3'
}

export function isImageAttachment(item: Pick<DraftAttachment, 'mimeType'>): boolean {
  return item.mimeType.toLowerCase().startsWith('image/')
}

const REASON_KEYS: Record<AttachmentErrorReason, string> = {
  too_large: 'chat.attachments.error.tooLarge',
  too_many: 'chat.attachments.error.tooMany',
  upload_failed: 'chat.attachments.error.upload',
}

/** Текст причины отказа вложения (i18n-ключ по коду ошибки стора). */
export function attachmentErrorText(
  t: (key: string, params?: I18nParams) => string,
  reason: AttachmentErrorReason | undefined,
): string {
  if (reason === 'too_large') {
    return t(REASON_KEYS.too_large, { max: formatFileSize(MAX_FILE_BYTES) })
  }
  if (reason === 'too_many') {
    return t(REASON_KEYS.too_many, { max: String(MAX_FILES_PER_MESSAGE) })
  }
  return t(REASON_KEYS.upload_failed)
}

/**
 * Две строки композера: превью изображений (64×64, клик — галерея) и чипы
 * прочих файлов. Показывается только когда есть что показывать.
 */
export function AttachedFilesList({ sessionId, onOpenImage }: AttachedFilesListProps) {
  const { t } = useI18n()
  const items = useAttachmentsStore((state) => state.bySession[sessionId])
  const remove = useAttachmentsStore((state) => state.remove)
  const retry = useAttachmentsStore((state) => state.retry)

  if (!items || items.length === 0) return null

  const images = items.filter(isImageAttachment)
  const files = items.filter((item) => !isImageAttachment(item))

  const errorText = (item: DraftAttachment): string =>
    attachmentErrorText(t, item.error)

  const removeLabel = (item: DraftAttachment) =>
    t('chat.attachments.removeNamed', { name: item.name })

  return (
    <div className="flex flex-col gap-2" data-testid="attached-files-list">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((item, index) => (
            <div key={item.id} className="relative" data-testid="attachment-image" data-state={item.upload}>
              <button
                type="button"
                onClick={() => onOpenImage?.(index)}
                aria-label={item.name}
                title={item.name}
                data-testid="attachment-preview"
                className={cn(
                  'group relative size-16 overflow-hidden rounded-lg border bg-muted',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  item.upload === 'error' ? 'border-destructive/60' : 'border-border',
                )}
              >
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt={item.name} className="size-full object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center text-muted-foreground">
                    <Icon name="image" className="size-5" />
                  </span>
                )}
                {item.upload === 'uploading' && (
                  <span
                    className="absolute inset-0 flex items-center justify-center bg-background/60"
                    data-testid="attachment-uploading"
                  >
                    <Icon name="loader-2" className="size-4 animate-spin text-foreground" />
                    <span className="sr-only">{t('chat.attachments.uploading')}</span>
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => remove(sessionId, item.id)}
                aria-label={removeLabel(item)}
                title={removeLabel(item)}
                className={cn(
                  'absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full',
                  'bg-background text-muted-foreground ring-1 ring-border',
                  'hover:bg-interactive-hover hover:text-foreground',
                  'pointer-coarse:size-6',
                )}
              >
                <Icon name="close" className="size-3" />
              </button>
              {item.upload === 'error' && (
                <span
                  className="absolute inset-x-0 bottom-0 truncate bg-destructive/90 px-1 text-[10px] leading-4 text-destructive-foreground"
                  title={errorText(item)}
                >
                  {errorText(item)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((item) => (
            <div
              key={item.id}
              data-testid="attachment-file"
              data-state={item.upload}
              title={item.upload === 'error' ? errorText(item) : item.name}
              className={cn(
                'flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-xs',
                item.upload === 'error' ? 'border-destructive/60' : 'border-border',
                item.upload === 'uploading' && 'opacity-60',
              )}
            >
              <Icon name={attachmentFileIcon(item)} className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 max-w-[12rem] truncate">{item.name}</span>
              {item.size > 0 && (
                <span className="shrink-0 text-muted-foreground">{formatFileSize(item.size)}</span>
              )}
              {item.upload === 'uploading' && (
                <Icon
                  name="loader-2"
                  className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                  aria-label={t('chat.attachments.uploading')}
                />
              )}
              {item.upload === 'error' && (
                <button
                  type="button"
                  onClick={() => void retry(sessionId, item.id)}
                  aria-label={t('chat.attachments.retry')}
                  title={t('chat.attachments.retry')}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-destructive hover:bg-destructive/10 pointer-coarse:size-6"
                >
                  <Icon name="refresh" className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => remove(sessionId, item.id)}
                aria-label={removeLabel(item)}
                title={removeLabel(item)}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground pointer-coarse:size-6"
              >
                <Icon name="close" className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
