import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import {
  ATTACHMENT_DRAG_TYPE,
  extractDroppedFiles,
  hasDraggedFiles,
  isInternalAttachmentDrag,
  useAttachmentDrop,
} from './useAttachmentDrop'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type HookResult = ReturnType<typeof useAttachmentDrop>
type DragHandler = (event: never) => void
type DropEvent = Parameters<HookResult['dropProps']['onDrop']>[0]

const roots: Array<{ root: Root; container: HTMLElement }> = []
let captured: HookResult | null = null

/** Мок `DataTransfer`: jsdom не реализует его вовсе. */
function dataTransfer(init: {
  types?: string[]
  files?: File[]
  items?: Array<{ kind: string; getAsFile: () => File | null }>
}): Record<string, unknown> {
  return { dropEffect: 'none', ...init }
}

function dragEvent(dt: Record<string, unknown>): DropEvent {
  return { preventDefault: vi.fn(), dataTransfer: dt } as unknown as DropEvent
}

async function renderHook(onFiles: (files: File[]) => void): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  function Probe() {
    captured = useAttachmentDrop(onFiles)
    return null
  }
  await act(async () => {
    root.render(React.createElement(Probe))
  })
  await act(async () => {})
}

function handler(name: keyof HookResult['dropProps']): DragHandler {
  return captured!.dropProps[name] as unknown as DragHandler
}

async function call(name: keyof HookResult['dropProps'], event: DropEvent): Promise<void> {
  await act(async () => {
    ;(handler(name) as unknown as (e: DropEvent) => void)(event)
  })
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  captured = null
  vi.restoreAllMocks()
})

describe('useAttachmentDrop: чистые хелперы', () => {
  it('распознаёт файлы по типу Files и внутренний DnD', () => {
    expect(hasDraggedFiles(dataTransfer({ types: ['Files'] }))).toBe(true)
    expect(hasDraggedFiles(dataTransfer({ types: ['text/plain'] }))).toBe(false)
    expect(hasDraggedFiles(null)).toBe(false)
    expect(isInternalAttachmentDrag(dataTransfer({ types: [ATTACHMENT_DRAG_TYPE] }))).toBe(true)
    expect(isInternalAttachmentDrag(dataTransfer({ types: ['Files'] }))).toBe(false)
  })

  it('берёт files, а при их отсутствии — items с kind=file', () => {
    const direct = new File(['a'], 'a.txt', { type: 'text/plain' })
    expect(extractDroppedFiles(dataTransfer({ files: [direct] }))).toEqual([direct])

    const fromItem = new File(['b'], 'b.png', { type: 'image/png' })
    const extracted = extractDroppedFiles(
      dataTransfer({
        files: [],
        items: [
          { kind: 'string', getAsFile: () => null },
          { kind: 'file', getAsFile: () => fromItem },
          { kind: 'file', getAsFile: () => null },
        ],
      }),
    )
    expect(extracted).toEqual([fromItem])
    expect(extractDroppedFiles(null)).toEqual([])
  })
})

describe('useAttachmentDrop: хук', () => {
  it('отдаёт брошенные файлы и гасит подсветку', async () => {
    const onFiles = vi.fn()
    await renderHook(onFiles)

    const file = new File(['a'], 'a.txt', { type: 'text/plain' })
    const event = dragEvent(dataTransfer({ types: ['Files'], files: [file] }))

    await call('onDragEnter', event)
    expect(captured!.isDragging).toBe(true)

    await call('onDrop', event)
    expect(onFiles).toHaveBeenCalledWith([file])
    expect((event as unknown as { preventDefault: () => void }).preventDefault).toHaveBeenCalled()
    expect(captured!.isDragging).toBe(false)
  })

  it('подсветка гаснет только при выходе за контейнер', async () => {
    await renderHook(vi.fn())

    const dt = dataTransfer({ types: ['Files'] })
    await call('onDragEnter', dragEvent(dt))
    await call('onDragEnter', dragEvent(dt))
    await call('onDragLeave', dragEvent(dt))
    expect(captured!.isDragging).toBe(true)

    await call('onDragLeave', dragEvent(dt))
    expect(captured!.isDragging).toBe(false)
  })

  it('игнорирует внутренний перенос чипа вложения', async () => {
    const onFiles = vi.fn()
    await renderHook(onFiles)

    const file = new File(['a'], 'a.txt', { type: 'text/plain' })
    await call('onDrop', dragEvent(dataTransfer({ types: [ATTACHMENT_DRAG_TYPE], files: [file] })))

    expect(onFiles).not.toHaveBeenCalled()
  })

  it('не перехватывает drop без файлов', async () => {
    const onFiles = vi.fn()
    await renderHook(onFiles)

    const event = dragEvent(dataTransfer({ types: ['text/plain'] }))
    await call('onDrop', event)

    expect(onFiles).not.toHaveBeenCalled()
    expect((event as unknown as { preventDefault: () => void }).preventDefault).not.toHaveBeenCalled()
  })
})
