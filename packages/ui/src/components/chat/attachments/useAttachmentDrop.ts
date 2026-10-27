// Drag&drop файлов на композер (ADR-115): чистые хелперы + хук контейнера.

import { useCallback, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'

/**
 * Маркер внутреннего DnD вложений: перетаскивание чипа внутри композера
 * не должно превращаться в новое вложение.
 */
export const ATTACHMENT_DRAG_TYPE = 'application/x-synth-attachment'

/** Минимальный контракт `DataTransfer`, нужный хелперам (моки в тестах — тоже он). */
export interface DragDataTransferLike {
  types?: ArrayLike<string> | null
  files?: ArrayLike<File> | null
  items?: ArrayLike<DataTransferItemLike> | null
}

/** Минимальный контракт элемента `DataTransferItem` (kind === 'file'). */
export interface DataTransferItemLike {
  kind?: string
  getAsFile?: () => File | null
}

/** Типы, объявленные переносимыми данными. */
export function collectDragTypes(dataTransfer?: DragDataTransferLike | null): string[] {
  if (!dataTransfer?.types) return []
  return Array.from(dataTransfer.types)
}

/** Есть ли в переносимых данных файлы (браузер объявляет тип `Files`). */
export function hasDraggedFiles(dataTransfer?: DragDataTransferLike | null): boolean {
  return collectDragTypes(dataTransfer).includes('Files')
}

/** Внутренний перенос чипа вложения (не файл из ОС). */
export function isInternalAttachmentDrag(dataTransfer?: DragDataTransferLike | null): boolean {
  return collectDragTypes(dataTransfer).includes(ATTACHMENT_DRAG_TYPE)
}

/**
 * Файлы из брошенных данных.
 *
 * Сначала `files` (обычный путь ОС), затем — `items` с `kind:'file'`
 * (некоторые браузеры и виртуальные файловые менеджеры заполняют только его).
 */
export function extractDroppedFiles(dataTransfer?: DragDataTransferLike | null): File[] {
  if (!dataTransfer) return []
  const files = dataTransfer.files ? Array.from(dataTransfer.files) : []
  if (files.length > 0) return files

  const items = dataTransfer.items ? Array.from(dataTransfer.items) : []
  const result: File[] = []
  for (const item of items) {
    if (!item || item.kind !== 'file' || typeof item.getAsFile !== 'function') continue
    const file = item.getAsFile()
    if (file) result.push(file)
  }
  return result
}

export interface AttachmentDropHandlers {
  isDragging: boolean
  dropProps: {
    onDragEnter: (event: ReactDragEvent<HTMLElement>) => void
    onDragOver: (event: ReactDragEvent<HTMLElement>) => void
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => void
    onDrop: (event: ReactDragEvent<HTMLElement>) => void
  }
}

/**
 * DnD-хук контейнера композера: считает глубину входа (чтобы не гасить
 * подсветку при переходе между дочерними узлами) и отдаёт файлы наружу.
 */
export function useAttachmentDrop(onFiles: (files: File[]) => void): AttachmentDropHandlers {
  const [isDragging, setIsDragging] = useState(false)
  // Глубина dragenter/dragleave: подсветка гаснет только при выходе за контейнер.
  const depthRef = useRef(0)

  const reset = useCallback(() => {
    depthRef.current = 0
    setIsDragging(false)
  }, [])

  const onDragEnter = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    depthRef.current += 1
    setIsDragging(true)
  }, [])

  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    // Без preventDefault браузер не разрешит drop и откроет файл в новой вкладке.
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    setIsDragging(true)
  }, [])

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    depthRef.current = Math.max(0, depthRef.current - 1)
    if (depthRef.current === 0) setIsDragging(false)
  }, [])

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event.dataTransfer) && !isInternalAttachmentDrag(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      reset()
      // Внутренний перенос чипа — не вложение.
      if (isInternalAttachmentDrag(event.dataTransfer)) return
      const files = extractDroppedFiles(event.dataTransfer)
      if (files.length > 0) onFiles(files)
    },
    [onFiles, reset],
  )

  return {
    isDragging,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
