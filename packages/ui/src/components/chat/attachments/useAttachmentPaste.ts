// Вставка файлов из буфера обмена (ADR-115): чистый извлекатель + хук-обёртка.

import { useCallback } from 'react'
import type { DragDataTransferLike } from './useAttachmentDrop'

/**
 * Файлы из `clipboardData`.
 *
 * Порядок: `files` (скриншоты и файлы ОС) → `items` с `kind:'file'`
 * (некоторые браузеры заполняют только их). Текст в буфере не трогаем —
 * это забота обычного paste в поле ввода.
 */
export function extractClipboardFiles(
  clipboardData?: DragDataTransferLike | null,
): File[] {
  if (!clipboardData) return []

  const files = clipboardData.files ? Array.from(clipboardData.files) : []
  if (files.length > 0) return files

  const items = clipboardData.items ? Array.from(clipboardData.items) : []
  const result: File[] = []
  for (const item of items) {
    if (!item || item.kind !== 'file' || typeof item.getAsFile !== 'function') continue
    const file = item.getAsFile()
    if (file) result.push(file)
  }
  return result
}

/**
 * Обработчик `paste` для композера.
 *
 * Возвращает извлечённые файлы (композер решает, добавить их или нет) и, если
 * передан `onFiles`, сразу отдаёт их наружу. React-состояний нет — хендлер
 * стабилен и не вызывает ререндеров.
 */
export function useAttachmentPaste(
  onFiles?: (files: File[]) => void,
): (event: ClipboardEvent) => File[] {
  return useCallback(
    (event: ClipboardEvent) => {
      const files = extractClipboardFiles(event.clipboardData)
      if (files.length > 0 && onFiles) onFiles(files)
      return files
    },
    [onFiles],
  )
}
