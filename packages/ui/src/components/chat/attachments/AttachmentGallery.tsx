// Галерея вложений-изображений (ADR-115): просмотр превью без скачивания.

import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useAttachmentsStore } from '@/stores/attachmentsStore'
import { isImageAttachment } from './AttachedFilesList'

export interface AttachmentGalleryProps {
  sessionId: string
  /** Текущий индекс среди изображений композера. */
  index: number
  onIndexChange: (index: number) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Модальная галерея: большая картинка, стрелки, счётчик.
 *
 * `Esc`/клик по фону закрывают окно — это штатное поведение `Dialog`
 * (Base UI); фокус при открытии уходит на кнопку закрытия.
 */
export function AttachmentGallery({
  sessionId,
  index,
  onIndexChange,
  open,
  onOpenChange,
}: AttachmentGalleryProps) {
  const { t } = useI18n()
  const items = useAttachmentsStore((state) => state.bySession[sessionId])
  const images = (items ?? []).filter(isImageAttachment)

  if (images.length === 0) return null

  const current = Math.min(Math.max(index, 0), images.length - 1)
  const image = images[current]!
  const hasMany = images.length > 1

  const step = (delta: number) => {
    const next = (current + delta + images.length) % images.length
    onIndexChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid="attachment-gallery"
        className="max-w-4xl gap-0 p-0"
        onKeyDown={(event) => {
          if (!hasMany) return
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            step(-1)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            step(1)
          }
        }}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-xs text-muted-foreground" data-testid="attachment-gallery-counter">
            {t('chat.attachments.gallery.counter', { index: current + 1, total: images.length })}
          </span>
          <button
            type="button"
            autoFocus
            onClick={() => onOpenChange(false)}
            aria-label={t('chat.attachments.gallery.close')}
            title={t('chat.attachments.gallery.close')}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground pointer-coarse:size-10"
          >
            <Icon name="close" className="size-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 p-3">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={!hasMany}
            aria-label={t('chat.attachments.gallery.prev')}
            title={t('chat.attachments.gallery.prev')}
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground',
              'hover:bg-interactive-hover hover:text-foreground disabled:opacity-30 pointer-coarse:size-10',
            )}
          >
            <Icon name="arrow-right" className="size-5 rotate-180" />
          </button>

          <div className="flex min-w-0 flex-1 items-center justify-center">
            {image.previewUrl ? (
              <img
                src={image.previewUrl}
                alt={image.name}
                data-testid="attachment-gallery-image"
                className="max-h-[70vh] w-auto max-w-full rounded-lg object-contain"
              />
            ) : (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Icon name="image" className="size-5" />
                {image.name}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => step(1)}
            disabled={!hasMany}
            aria-label={t('chat.attachments.gallery.next')}
            title={t('chat.attachments.gallery.next')}
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground',
              'hover:bg-interactive-hover hover:text-foreground disabled:opacity-30 pointer-coarse:size-10',
            )}
          >
            <Icon name="arrow-right" className="size-5" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
