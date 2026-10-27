// Вложения отправленного сообщения (ADR-115): миниатюры, плееры и чипы файлов.

import { useState } from 'react'
import type { MediaPartData, Part } from '@itphx/synth-shared/types'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { formatFileSize } from '@/lib/attachments/file-size'
import { attachmentContentUrl } from '@/lib/api/attachments'
import { attachmentFileIcon } from './AttachedFilesList'
import { AttachmentGallery, type AttachmentGalleryImage } from './AttachmentGallery'

export interface MessageAttachmentsProps {
  sessionId: string
  parts: Part[]
}

/** Медиа-часть сообщения с типизированными данными (ADR-115). */
export interface MediaPart {
  id: string
  type: 'image' | 'audio' | 'video' | 'file'
  data: MediaPartData
}

const MEDIA_PART_TYPES = new Set(['image', 'audio', 'video', 'file'])

/** Данные части похожи на `MediaPartData` (mime обязателен, остальное — по возможности). */
function isMediaPartData(data: unknown): data is MediaPartData {
  if (!data || typeof data !== 'object') return false
  const mime = (data as { mime?: unknown }).mime
  return typeof mime === 'string' && mime.length > 0
}

/** Часть сообщения → медиа-часть; текстовые/служебные части дают `null`. */
export function toMediaPart(part: Part): MediaPart | null {
  if (!part || typeof part.id !== 'string' || !MEDIA_PART_TYPES.has(part.type)) return null
  if (!isMediaPartData(part.data)) return null
  return { id: part.id, type: part.type as MediaPart['type'], data: part.data }
}

/** Медиа-части сообщения в исходном порядке (текст и тулы отбрасываются). */
export function mediaPartsOf(parts: Part[] | null | undefined): MediaPart[] {
  if (!parts || parts.length === 0) return []
  const result: MediaPart[] = []
  for (const part of parts) {
    const media = toMediaPart(part)
    if (media) result.push(media)
  }
  return result
}

/** Есть ли у сообщения хоть одно вложение — чтобы не схлопнуть ответ, состоящий только из картинки. */
export function hasMediaParts(parts: Part[] | null | undefined): boolean {
  return mediaPartsOf(parts).length > 0
}

/**
 * Вложения в теле сообщения: изображения сеткой миниатюр (клик — галерея),
 * аудио и видео — компактные плееры, прочие файлы — чипы с именем, размером
 * и ссылкой «открыть». Байты отдаёт `GET /sessions/:id/attachments/:partId`.
 *
 * Пустой список частей не оставляет в разметке ничего (`null`).
 */
export function MessageAttachments({ sessionId, parts }: MessageAttachmentsProps) {
  const { t } = useI18n()
  const [gallery, setGallery] = useState<{ open: boolean; index: number }>({ open: false, index: 0 })

  const media = mediaPartsOf(parts)
  if (media.length === 0) return null

  const images = media.filter((part) => part.type === 'image')
  const audio = media.filter((part) => part.type === 'audio')
  const video = media.filter((part) => part.type === 'video')
  const files = media.filter((part) => part.type === 'file')

  // Имя — из метаданных части; без имени показываем нейтральное «Файл».
  const nameOf = (part: MediaPart): string =>
    part.data.name?.trim() || t('chat.message.attachments.file')
  const urlOf = (part: MediaPart): string => attachmentContentUrl(sessionId, part.id)
  const imageAltOf = (part: MediaPart): string =>
    t('chat.message.attachments.imageAlt', { name: nameOf(part) })

  const galleryImages: AttachmentGalleryImage[] = images.map((part) => ({
    url: urlOf(part),
    name: nameOf(part),
  }))

  return (
    <div className="mb-2 flex flex-col gap-2" data-testid="message-attachments">
      {images.length > 0 && (
        <div className="grid max-w-[18rem] grid-cols-4 gap-2" data-testid="message-attachments-images">
          {images.map((part, index) => (
            <button
              key={part.id}
              type="button"
              onClick={() => setGallery({ open: true, index })}
              aria-label={imageAltOf(part)}
              title={nameOf(part)}
              data-testid="message-attachment-image"
              className="aspect-square overflow-hidden rounded-lg border border-border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <img
                src={urlOf(part)}
                alt={imageAltOf(part)}
                loading="lazy"
                className="size-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      {audio.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="message-attachments-audio">
          {audio.map((part) => (
            <div
              key={part.id}
              data-testid="message-attachment-audio"
              className="flex max-w-full flex-col gap-1 rounded-lg border border-border px-2 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <Icon name="file-music" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 max-w-[16rem] truncate">{nameOf(part)}</span>
                <span className="sr-only">{t('chat.message.attachments.audio')}</span>
              </span>
              <audio
                controls
                preload="metadata"
                src={urlOf(part)}
                aria-label={nameOf(part)}
                data-testid="message-attachment-audio-player"
                className="h-9 w-full max-w-[280px]"
              />
            </div>
          ))}
        </div>
      )}

      {video.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="message-attachments-video">
          {video.map((part) => (
            <div key={part.id} data-testid="message-attachment-video" className="flex flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <Icon name="file-3" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 max-w-[16rem] truncate">{nameOf(part)}</span>
                <span className="sr-only">{t('chat.message.attachments.video')}</span>
              </span>
              <video
                controls
                preload="metadata"
                src={urlOf(part)}
                aria-label={nameOf(part)}
                data-testid="message-attachment-video-player"
                className="max-h-[240px] w-full max-w-[320px] rounded-lg border border-border bg-muted"
              />
            </div>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="message-attachments-files">
          {files.map((part) => (
            <div
              key={part.id}
              data-testid="message-attachment-file"
              title={nameOf(part)}
              className="flex max-w-full items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs"
            >
              <Icon
                name={attachmentFileIcon({ mimeType: part.data.mime })}
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 max-w-[12rem] truncate">{nameOf(part)}</span>
              {part.data.size > 0 && (
                <span className="shrink-0 text-muted-foreground">{formatFileSize(part.data.size)}</span>
              )}
              <span className="sr-only">{t('chat.message.attachments.file')}</span>
              <a
                href={urlOf(part)}
                target="_blank"
                rel="noreferrer"
                data-testid="message-attachment-open"
                aria-label={`${t('chat.message.attachments.open')}: ${nameOf(part)}`}
                title={`${t('chat.message.attachments.open')}: ${nameOf(part)}`}
                className="flex shrink-0 items-center gap-1 rounded px-1 text-primary hover:bg-primary/10 pointer-coarse:min-h-10"
              >
                <Icon name="external-link" className="size-3.5" />
                {t('chat.message.attachments.open')}
              </a>
            </div>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <AttachmentGallery
          sessionId={sessionId}
          images={galleryImages}
          open={gallery.open}
          index={gallery.index}
          onIndexChange={(index) => setGallery({ open: true, index })}
          onOpenChange={(open) => setGallery((prev) => ({ ...prev, open }))}
        />
      )}
    </div>
  )
}
