import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { extractClipboardFiles, useAttachmentPaste } from './useAttachmentPaste'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []
let captured: ReturnType<typeof useAttachmentPaste> | null = null

/** Мок `DataTransfer` буфера: jsdom не реализует ни его, ни ClipboardEvent. */
function clipboard(init: {
  files?: File[]
  items?: Array<{ kind: string; getAsFile: () => File | null }>
}): Record<string, unknown> {
  return { ...init }
}

async function renderHook(onFiles?: (files: File[]) => void): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  function Probe() {
    captured = useAttachmentPaste(onFiles)
    return null
  }
  await act(async () => {
    root.render(React.createElement(Probe))
  })
  await act(async () => {})
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
})

describe('useAttachmentPaste', () => {
  it('извлекает файлы из clipboardData.files', () => {
    const file = new File(['a'], 'a.png', { type: 'image/png' })
    expect(extractClipboardFiles(clipboard({ files: [file] }))).toEqual([file])
  })

  it('падает обратно на items с kind=file', () => {
    const file = new File(['b'], 'b.txt', { type: 'text/plain' })
    const extracted = extractClipboardFiles(
      clipboard({
        files: [],
        items: [
          { kind: 'string', getAsFile: () => null },
          { kind: 'file', getAsFile: () => file },
        ],
      }),
    )
    expect(extracted).toEqual([file])
  })

  it('возвращает пусто для текстовой вставки', () => {
    expect(extractClipboardFiles(clipboard({ files: [], items: [{ kind: 'string', getAsFile: () => null }] }))).toEqual([])
    expect(extractClipboardFiles(null)).toEqual([])
  })

  it('хендлер возвращает файлы и отдаёт их в onFiles', async () => {
    const onFiles = vi.fn()
    await renderHook(onFiles)

    const file = new File(['c'], 'c.png', { type: 'image/png' })
    const event = { clipboardData: clipboard({ files: [file] }) } as unknown as ClipboardEvent
    let result: File[] = []

    await act(async () => {
      result = captured!(event)
    })

    expect(result).toEqual([file])
    expect(onFiles).toHaveBeenCalledWith([file])
  })

  it('без onFiles просто возвращает файлы', async () => {
    await renderHook()

    const file = new File(['d'], 'd.png', { type: 'image/png' })
    const event = { clipboardData: clipboard({ files: [file] }) } as unknown as ClipboardEvent

    expect(captured!(event)).toEqual([file])
  })
})
