import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { Toggle } from './Toggle'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderToggle(props: Parameters<typeof Toggle>[0]): Promise<HTMLButtonElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(<Toggle {...props} />)
  })
  return host.querySelector('button[role="switch"]') as HTMLButtonElement
}

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()
  }
})

describe('Toggle', () => {
  it('обычное состояние: курсор-указатель, без aria-busy и без «запрета»', async () => {
    const onToggle = vi.fn()
    const el = await renderToggle({ enabled: false, onToggle, ariaLabel: 'x' })

    expect(el.disabled).toBe(false)
    expect(el.getAttribute('aria-busy')).toBeNull()
    expect(el.classList.contains('cursor-pointer')).toBe(true)
    expect(el.classList.contains('cursor-progress')).toBe(false)
    expect(el.classList.contains('cursor-default')).toBe(false)
    expect(el.classList.contains('cursor-not-allowed')).toBe(false)

    await act(async () => {
      el.click()
    })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('pending: не disabled, aria-busy=true, курсор занятости (не «запрет»)', async () => {
    const onToggle = vi.fn()
    const el = await renderToggle({ enabled: true, onToggle, ariaLabel: 'x', pending: true })

    expect(el.disabled).toBe(false)
    expect(el.getAttribute('aria-busy')).toBe('true')
    expect(el.classList.contains('cursor-progress')).toBe(true)
    expect(el.classList.contains('cursor-pointer')).toBe(false)
    expect(el.classList.contains('cursor-not-allowed')).toBe(false)
    expect(el.classList.contains('opacity-60')).toBe(true)

    // Повторный клик на время запроса не блокируется атрибутом (его гасит обработчик).
    await act(async () => {
      el.click()
    })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('disabled: реально недоступен — атрибут disabled, серый cursor-default без «запрета»', async () => {
    const onToggle = vi.fn()
    const el = await renderToggle({ enabled: false, onToggle, ariaLabel: 'x', disabled: true })

    expect(el.disabled).toBe(true)
    expect(el.getAttribute('aria-busy')).toBeNull()
    expect(el.className).toContain('disabled:cursor-default')
    expect(el.className).not.toContain('cursor-not-allowed')
    expect(el.classList.contains('cursor-default')).toBe(true)
    expect(el.classList.contains('cursor-pointer')).toBe(false)
    expect(el.classList.contains('cursor-progress')).toBe(false)

    await act(async () => {
      el.click()
    })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('pending вместе с disabled: disabled важнее, курсор занятости не навязывается', async () => {
    const el = await renderToggle({
      enabled: false,
      onToggle: vi.fn(),
      ariaLabel: 'x',
      disabled: true,
      pending: true,
    })

    expect(el.disabled).toBe(true)
    expect(el.getAttribute('aria-busy')).toBe('true')
    expect(el.classList.contains('cursor-progress')).toBe(false)
    expect(el.classList.contains('cursor-default')).toBe(true)
    expect(el.className).not.toContain('cursor-not-allowed')
  })
})
