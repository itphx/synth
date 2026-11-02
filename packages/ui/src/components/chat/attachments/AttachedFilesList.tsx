// Список черновиков вложений в композере (ADR-115): изображения + чипы файлов.

import { useState } from 'react'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n, type I18nParams } from '@/lib/i18n'
import { formatFileSize } from '@/lib/attachments/file-size'
import { MAX_FILES_PER_MESSAGE, MAX_FILE_BYTES } from '@/lib/attachments/limits'
import { attachmentContentUrlFromThumb } from '@/lib/api/attachments'
import {
  useAttachmentsStore,
  type DraftAttachment,
  type AttachmentErrorReason,
} from '@/stores/attachmentsStore'

export interface AttachedFilesListProps {
  sessionId: string
  /** Клик по превью изображения — открыть галерею (индекс среди изображений). */
  onOpenImage?: (index: number) => void
  /**
   * Удалённые элементы (имена): при каскаде по `groupId` — имена всей группы.
   * Нужен композеру, чтобы убрать маркеры вложений из текста.
   */
  onRemove?: (names: string[]) => void
}

/** Иконка типа файла из реестра `Icon` (svg-наборы не тянем). */
export function attachmentFileIcon(item: Pick<DraftAttachment, 'mimeType'>): string {
  const mime = item.mimeType.toLowerCase()
  if (mime === 'application/pdf') return 'file-text'
  if (mime.startsWith('audio/')) return 'file-music'
  if (mime.startsWith('video/')) return 'file-video'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return 'file-code'
  }
  return 'file-3'
}

export function isImageAttachment(item: Pick<DraftAttachment, 'mimeType'>): boolean {
  return item.mimeType.toLowerCase().startsWith('image/')
}

/**
 * Превью изображения черновика: локальный object URL (только что добавленный
 * файл) либо серверная миниатюра (вложение, восстановленное из истории).
 * Миниатюры нет (`404`) — **однократно** подставляем полный контент; повторной
 * подмены нет, цикла ошибок не возникает.
 */
function DraftImagePreview({ src, alt }: { src: string; alt: string }) {
  const fallback = attachmentContentUrlFromThumb(src)
  const [original, setOriginal] = useState(false)
  return (
    <img
      src={original && fallback ? fallback : src}
      alt={alt}
      className="size-full object-cover"
      onError={fallback && !original ? () => setOriginal(true) : undefined}
    />
  )
}

/**
 * Процент загрузки для подписи (0..100); `undefined` — прогресс неизвестен
 * (raw-загрузка до первого кадра или мок без `onProgress`).
 */
export function attachmentUploadPercent(
  item: Pick<DraftAttachment, 'progress'>,
): number | undefined {
  if (typeof item.progress !== 'number' || !Number.isFinite(item.progress)) return undefined
  return Math.min(100, Math.max(0, Math.round(item.progress * 100)))
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
  hints?: { maxBytesPerFile?: number; maxFilesPerMessage?: number },
): string {
  if (reason === 'too_large') {
    return t(REASON_KEYS.too_large, {
      max: formatFileSize(hints?.maxBytesPerFile ?? MAX_FILE_BYTES),
    })
  }
  if (reason === 'too_many') {
    return t(REASON_KEYS.too_many, { max: String(hints?.maxFilesPerMessage ?? MAX_FILES_PER_MESSAGE) })
  }
  return t(REASON_KEYS.upload_failed)
}

/**
 * Две строки композера: превью изображений (64×64, клик — галерея) и чипы
 * прочих файлов. Показывается только когда есть что показывать.
 */
export function AttachedFilesList({ sessionId, onOpenImage, onRemove }: AttachedFilesListProps) {
  const { t } = useI18n()
  const items = useAttachmentsStore((state) => state.bySession[sessionId])
  const limits = useAttachmentsStore((state) => state.limits)
  const remove = useAttachmentsStore((state) => state.remove)
  const retry = useAttachmentsStore((state) => state.retry)

  if (!items || items.length === 0) return null

  const images = items.filter(isImageAttachment)
  const files = items.filter((item) => !isImageAttachment(item))

  /** Удаление элемента; при каскаде по `groupId` сообщаем имена всей группы. */
  const handleRemove = (item: DraftAttachment) => {
    const removed = item.groupId
      ? items.filter((entry) => entry.groupId === item.groupId)
      : [item]
    remove(sessionId, item.id)
    onRemove?.(removed.map((entry) => entry.name))
  }

  const errorText = (item: DraftAttachment): string =>
    attachmentErrorText(t, item.error, {
      maxBytesPerFile: item.maxBytes ?? limits.maxBytesPerFile,
      maxFilesPerMessage: limits.maxFilesPerMessage,
    })

  const removeLabel = (item: DraftAttachment) =>
    t('chat.attachments.removeNamed', { name: item.name })

  return (
    <div className="flex flex-col gap-2" data-testid="attached-files-list">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((item, index) => {
            const percent = item.upload === 'uploading' ? attachmentUploadPercent(item) : undefined
            return (
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
                  <DraftImagePreview src={item.previewUrl} alt={item.name} />
                ) : (
                  <span className="flex size-full items-center justify-center text-muted-foreground">
                    <Icon name="image" className="size-5" />
                  </span>
                )}
                {item.upload === 'uploading' && (
                  <span
                    className="absolute inset-0 flex items-center justify-center gap-1 bg-background/60"
                    data-testid="attachment-uploading"
                  >
                    {percent === undefined ? (
                      <>
                        <Icon name="loader-2" className="size-4 animate-spin text-foreground" />
                        <span className="sr-only">{t('chat.attachments.uploading')}</span>
                      </>
                    ) : (
                      <span
                        className="text-[10px] font-medium tabular-nums text-foreground"
                        aria-label={t('chat.attachments.uploadingPercent', { percent })}
                      >
                        {percent}%
                      </span>
                    )}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => handleRemove(item)}
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
                <div
                  className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg bg-foreground/75 p-1 text-center text-background"
                  title={errorText(item)}
                  data-testid="attachment-image-error"
                >
                  <Icon name="error-warning" className="size-3.5 shrink-0" />
                  <span className="w-full truncate text-[9px] leading-tight">{errorText(item)}</span>
                  <button
                    type="button"
                    onClick={() => void retry(sessionId, item.id)}
                    aria-label={t('chat.attachments.retry')}
                    title={t('chat.attachments.retry')}
                    className="pointer-events-auto flex size-5 shrink-0 items-center justify-center rounded bg-background/25 text-background hover:bg-background/40 pointer-coarse:size-6"
                  >
                    <Icon name="refresh" className="size-3" />
                  </button>
                </div>
              )}
            </div>
            )
          })}
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((item) => {
            const percent = item.upload === 'uploading' ? attachmentUploadPercent(item) : undefined
            return (
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
              {item.upload === 'uploading' && percent === undefined && (
                <Icon
                  name="loader-2"
                  className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                  aria-label={t('chat.attachments.uploading')}
                />
              )}
              {item.upload === 'uploading' && percent !== undefined && (
                <span
                  className="shrink-0 tabular-nums text-muted-foreground"
                  data-testid="attachment-uploading-percent"
                  aria-label={t('chat.attachments.uploadingPercent', { percent })}
                >
                  {percent}%
                </span>
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
                onClick={() => handleRemove(item)}
                aria-label={removeLabel(item)}
                title={removeLabel(item)}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground pointer-coarse:size-6"
              >
                <Icon name="close" className="size-3.5" />
              </button>
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
