import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import type { MediaPartData, Part } from '@itphx/synth-shared/types'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MessageAttachments, hasMediaParts, mediaPartsOf } from './MessageAttachments'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'
const roots: Array<{ root: Root; container: HTMLElement }> = []

function mediaPart(
  id: string,
  type: 'image' | 'audio' | 'video' | 'file',
  data: Partial<MediaPartData> = {},
): Part {
  const base: MediaPartData = {
    blobPath: `attachments/ab/${id}`,
    sha256: `sha-${id}`,
    mime: 'application/octet-stream',
    size: 2048,
    ...data,
  }
  return { id, type, data: base }
}

async function renderAttachments(parts: Part[]): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <MessageAttachments sessionId={SESSION} parts={parts} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('MessageAttachments: вложения отправленного сообщения', () => {
  it('изображение — миниатюра с URL байтов и alt с именем', async () => {
    const container = await renderAttachments([
      mediaPart('p1', 'image', { mime: 'image/png', name: 'shot.png', width: 800, height: 600 }),
    ])

    const img = container.querySelector('[data-testid="message-attachment-image"] img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/p1')
    expect(img.getAttribute('alt')).toContain('shot.png')
    expect(img.getAttribute('loading')).toBe('lazy')
    // Сетка миниатюр — не больше 4 в ряд.
    const grid = container.querySelector('[data-testid="message-attachments-images"]') as HTMLElement
    expect(grid.className).toContain('grid-cols-4')
  })

  it('аудио — плеер с именем файла', async () => {
    const container = await renderAttachments([
      mediaPart('p2', 'audio', { mime: 'audio/mpeg', name: 'voice.mp3' }),
    ])

    const audio = container.querySelector('[data-testid="message-attachment-audio-player"]') as HTMLAudioElement
    expect(audio).not.toBeNull()
    expect(audio.tagName).toBe('AUDIO')
    expect(audio.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/p2')
    expect(audio.hasAttribute('controls')).toBe(true)
    expect(audio.getAttribute('preload')).toBe('metadata')
    expect(audio.getAttribute('aria-label')).toBe('voice.mp3')
    expect(container.textContent).toContain('voice.mp3')
  })

  it('видео — плеер без автоплея, ограничен по размеру', async () => {
    const container = await renderAttachments([
      mediaPart('p3', 'video', { mime: 'video/mp4', name: 'clip.mp4' }),
    ])

    const video = container.querySelector('[data-testid="message-attachment-video-player"]') as HTMLVideoElement
    expect(video).not.toBeNull()
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/p3')
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.hasAttribute('autoplay')).toBe(false)
    expect(video.className).toContain('max-w-[320px]')
    expect(video.className).toContain('max-h-[240px]')
  })

  it('файл — чип с именем, размером и ссылкой «открыть»', async () => {
    const container = await renderAttachments([
      mediaPart('p4', 'file', { mime: 'application/pdf', name: 'report.pdf', size: 2048 }),
    ])

    const chip = container.querySelector('[data-testid="message-attachment-file"]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toContain('report.pdf')
    expect(chip.textContent).toContain('2.0 KB')

    const link = container.querySelector('[data-testid="message-attachment-open"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/api/v2/sessions/s1/attachments/p4')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
    expect(link.textContent).toContain('Open')
  })

  it('без медиа-частей ничего не рендерит (нулевой DOM)', async () => {
    const container = await renderAttachments([])
    expect(container.innerHTML).toBe('')

    const textOnly = await renderAttachments([{ id: 't1', type: 'text', data: { text: 'привет' } }])
    expect(textOnly.innerHTML).toBe('')
    expect(hasMediaParts([{ id: 't1', type: 'text', data: { text: 'привет' } }])).toBe(false)
  })

  it('клик по миниатюре открывает галерею с этим изображением', async () => {
    const container = await renderAttachments([
      mediaPart('p1', 'image', { mime: 'image/png', name: 'a.png' }),
      mediaPart('p2', 'image', { mime: 'image/png', name: 'b.png' }),
    ])

    const thumbs = container.querySelectorAll('[data-testid="message-attachment-image"]')
    expect(thumbs.length).toBe(2)
    expect(document.querySelector('[data-testid="attachment-gallery"]')).toBeNull()

    await act(async () => {
      ;(thumbs[1] as HTMLButtonElement).click()
    })
    await act(async () => {})

    const galleryImage = document.querySelector('[data-testid="attachment-gallery-image"]') as HTMLImageElement
    expect(galleryImage).not.toBeNull()
    expect(galleryImage.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/p2')
    const counter = document.querySelector('[data-testid="attachment-gallery-counter"]')
    expect(counter?.textContent).toContain('2 / 2')
  })

  it('отбрасывает текстовые части и сохраняет порядок медиа', () => {
    const parts: Part[] = [
      { id: 't1', type: 'text', data: { text: 'до' } },
      mediaPart('p1', 'image', { mime: 'image/png', name: 'a.png' }),
      mediaPart('p2', 'file', { mime: 'text/plain', name: 'b.txt' }),
    ]
    expect(mediaPartsOf(parts).map((part) => part.id)).toEqual(['p1', 'p2'])
  })
})
