// Кнопка «прикрепить файл» в композере (ADR-115).

import { useRef } from 'react'
import type { ChangeEvent } from 'react'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { ATTACHMENT_ACCEPT } from '@/lib/attachments/accept'
import { useDevice } from '@/hooks/useDevice'
import { useAttachmentsStore } from '@/stores/attachmentsStore'

export interface AttachmentButtonProps {
  sessionId: string
  disabled?: boolean
}

/**
 * Кнопка со скрытым `<input type="file" multiple>`.
 *
 * Меню выбора источника (файлы/контекст) пока не нужно: на телефоне и на
 * десктопе работает один и тот же системный диалог (ADR-044).
 */
export function AttachmentButton({ sessionId, disabled = false }: AttachmentButtonProps) {
  const { t } = useI18n()
  const { deviceType } = useDevice()
  const inputRef = useRef<HTMLInputElement>(null)
  const addFiles = useAttachmentsStore((state) => state.addFiles)

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // Сбрасываем значение: повторный выбор того же файла должен снова срабатывать.
    event.target.value = ''
    if (files.length > 0) void addFiles(sessionId, files)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        data-device={deviceType}
        aria-label={t('chat.attachments.attach')}
        title={t('chat.attachments.attach')}
        className={cn(
          'inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground',
          'transition-colors hover:bg-interactive-hover hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:size-10',
        )}
      >
        <Icon name="attachment-2" className="size-4" />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="attachment-input"
        onChange={handleChange}
      />
    </>
  )
}
