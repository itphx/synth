import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { ProviderIcon } from './ProviderIcon'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ host: HTMLElement; root: Root }> = []

async function render(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(node)
  })
  return { host, root }
}

async function rerender(root: Root, node: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

afterEach(async () => {
  while (mounted.length > 0) {
    const { host, root } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
  document.body.innerHTML = ''
})

describe('ProviderIcon: фоллбек при ошибке загрузки картинки', () => {
  it('битый favicon заменяется иконкой-заглушкой', async () => {
    const { host } = await render(<ProviderIcon icon="" baseUrl="https://api.example.com/v1" />)
    const img = host.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()

    await act(async () => {
      img.dispatchEvent(new Event('error'))
    })

    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('[data-testid="provider-icon-fallback"]')).toBeTruthy()
  })

  it('валидный data-URL рендерит img и не показывает заглушку', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const { host } = await render(<ProviderIcon icon={dataUrl} />)
    const img = host.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe(dataUrl)
    expect(host.querySelector('[data-testid="provider-icon-fallback"]')).toBeNull()
  })

  it('битая брендовая SVG тоже уходит в заглушку', async () => {
    const { host } = await render(<ProviderIcon icon="brand:ollama" />)
    const img = host.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/assets/providers/ollama.svg')

    await act(async () => {
      img.dispatchEvent(new Event('error'))
    })

    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('[data-testid="provider-icon-fallback"]')).toBeTruthy()
  })

  it('смена src сбрасывает состояние ошибки — картинка пробуется снова', async () => {
    const { host, root } = await render(<ProviderIcon icon="" baseUrl="https://api.example.com/v1" />)
    const img = host.querySelector('img') as HTMLImageElement
    await act(async () => {
      img.dispatchEvent(new Event('error'))
    })
    expect(host.querySelector('[data-testid="provider-icon-fallback"]')).toBeTruthy()

    await rerender(root, <ProviderIcon icon="" baseUrl="https://other.example.com/v1" />)

    const nextImg = host.querySelector('img') as HTMLImageElement
    expect(nextImg).toBeTruthy()
    expect(nextImg.getAttribute('src')).toBe('https://other.example.com/favicon.ico')
  })
})
