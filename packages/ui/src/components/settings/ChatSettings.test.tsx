import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const profileMock = vi.hoisted(() => ({
  syncChatViewModeToProfile: vi.fn(),
  syncChatDensityToProfile: vi.fn(),
  syncChatScaleToProfile: vi.fn(),
  syncIntermediateTextDisplayToProfile: vi.fn(),
}))

vi.mock('@/lib/api/profileService', () => ({ profileService: profileMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useUIStore } from '@/stores/useUIStore'
import { CHAT_SCALE_DEFAULT, CHAT_SCALE_STORAGE_KEY } from '@/lib/uiScale'
import { ChatSettings } from './ChatSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <ChatSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

async function unmountOne(container: HTMLElement) {
  const idx = roots.findIndex((r) => r.container === container)
  if (idx < 0) return
  const [{ root, container: c }] = roots.splice(idx, 1)
  await act(async () => {
    root.unmount()
  })
  c.remove()
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

const radioByText = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll('[role="radio"]')).find(
    (r) => r.textContent?.trim() === text,
  ) as HTMLButtonElement

beforeEach(() => {
  useUIStore.setState({
    intermediateTextDisplay: 'inline',
    chatDensity: 'normal',
    chatViewMode: 'detailed',
    chatScale: CHAT_SCALE_DEFAULT,
  })
  localStorage.removeItem(CHAT_SCALE_STORAGE_KEY)
  document.documentElement.style.removeProperty('--chat-scale')
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
  document.documentElement.style.removeProperty('--chat-scale')
  document.body.innerHTML = ''
})

describe('ChatSettings — миграция на Settings UI Kit (ADR-072)', () => {
  it('каркас — SettingsPanel с единственным scroll-контейнером и без pr-2', async () => {
    const container = await renderSettings()

    const scrollers = container.querySelectorAll('.overflow-y-auto')
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0]!.classList.contains('overflow-x-hidden')).toBe(true)
    expect(container.innerHTML).not.toContain('pr-2')
  })

  it('нет grid без базового grid-cols-1', async () => {
    const container = await renderSettings()
    container.querySelectorAll('.grid').forEach((el) => {
      expect(el.classList.contains('grid-cols-1')).toBe(true)
    })
  })

  it('выбор меняет черновик, но не стор до Save', async () => {
    const container = await renderSettings()

    expect(container.textContent).toContain('Intermediate responses')
    await act(async () => {
      radioByText(container, 'At bottom').click()
    })

    expect(radioByText(container, 'At bottom').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().intermediateTextDisplay).toBe('inline')

    await act(async () => {
      byTestId(container, 'chat-save')!.click()
    })
    expect(useUIStore.getState().intermediateTextDisplay).toBe('bottom')
  })

  it('Cancel возвращает сохранённый выбор', async () => {
    const container = await renderSettings()

    await act(async () => {
      radioByText(container, 'At bottom').click()
    })
    await act(async () => {
      byTestId(container, 'chat-cancel')!.click()
    })

    expect(radioByText(container, 'Between blocks').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().intermediateTextDisplay).toBe('inline')
  })

  it('Reset сбрасывает черновик к inline, персист — только по Save', async () => {
    useUIStore.setState({ intermediateTextDisplay: 'bottom' })
    const container = await renderSettings()

    await act(async () => {
      byTestId(container, 'chat-reset')!.click()
    })

    expect(radioByText(container, 'Between blocks').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().intermediateTextDisplay).toBe('bottom')

    await act(async () => {
      byTestId(container, 'chat-save')!.click()
    })
    expect(useUIStore.getState().intermediateTextDisplay).toBe('inline')
  })

  it('закрытие (unmount) не персистит черновик', async () => {
    const container = await renderSettings()

    await act(async () => {
      radioByText(container, 'At bottom').click()
    })
    await unmountOne(container)

    expect(useUIStore.getState().intermediateTextDisplay).toBe('inline')
  })

  it('Reset серый/неактивен на дефолте и активен при изменениях', async () => {
    const container = await renderSettings()

    expect(byTestId(container, 'chat-reset')!.disabled).toBe(true)
    expect(byTestId(container, 'chat-reset')!.className).toContain('border-muted-foreground')

    await act(async () => {
      radioByText(container, 'At bottom').click()
    })

    expect(byTestId(container, 'chat-reset')!.disabled).toBe(false)
    expect(byTestId(container, 'chat-reset')!.className).toContain('border-primary')
  })

  it('плотность ленты: выбор меняет черновик, Save пишет в стор', async () => {
    const container = await renderSettings()

    expect(container.textContent).toContain('Feed density')
    await act(async () => {
      radioByText(container, 'Compact').click()
    })

    expect(radioByText(container, 'Compact').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().chatDensity).toBe('normal')

    await act(async () => {
      byTestId(container, 'chat-save')!.click()
    })
    expect(useUIStore.getState().chatDensity).toBe('compact')
  })

  it('плотность ленты: Reset возвращает normal и пишется по Save', async () => {
    useUIStore.setState({ chatDensity: 'compact' })
    const container = await renderSettings()

    await act(async () => {
      byTestId(container, 'chat-reset')!.click()
    })

    expect(radioByText(container, 'Normal').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().chatDensity).toBe('compact')

    await act(async () => {
      byTestId(container, 'chat-save')!.click()
    })
    expect(useUIStore.getState().chatDensity).toBe('normal')
  })

  it('плотность ленты: Cancel не пишет в стор', async () => {
    const container = await renderSettings()

    await act(async () => {
      radioByText(container, 'Compact').click()
    })
    await act(async () => {
      byTestId(container, 'chat-cancel')!.click()
    })

    expect(radioByText(container, 'Normal').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().chatDensity).toBe('normal')
  })

  it('вид сообщений: выбор меняет черновик, Save пишет в стор', async () => {
    const container = await renderSettings()

    expect(container.textContent).toContain('Message view')
    await act(async () => {
      radioByText(container, 'Feed').click()
    })

    expect(radioByText(container, 'Feed').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().chatViewMode).toBe('detailed')

    await act(async () => {
      byTestId(container, 'chat-save')!.click()
    })
    expect(useUIStore.getState().chatViewMode).toBe('feed')
  })

  it('вид сообщений: Reset возвращает detailed и пишется по Save', async () => {
    useUIStore.setState({ chatViewMode: 'feed' })
    const container = await renderSettings()

    await act(async () => {
      byTestId(container, 'chat-reset')!.click()
    })

    expect(radioByText(container, 'Detailed').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().chatViewMode).toBe('feed')

    await act(async () => {
      byTestId(container, 'chat-save')!.click()
    })
    expect(useUIStore.getState().chatViewMode).toBe('detailed')
  })

  it('вид сообщений: Cancel не пишет в стор', async () => {
    const container = await renderSettings()

    await act(async () => {
      radioByText(container, 'Feed').click()
    })
    await act(async () => {
      byTestId(container, 'chat-cancel')!.click()
    })

    expect(radioByText(container, 'Detailed').getAttribute('aria-checked')).toBe('true')
    expect(useUIStore.getState().chatViewMode).toBe('detailed')
  })
})

/**
 * Масштаб области чата переехал из «Внешнего вида» в раздел «Чат»: секция
 * `chat-scale`, live-preview, Save → persist + профиль, Cancel/Reset.
 */
describe('ChatSettings — масштаб области чата', () => {
  const setSliderValue = async (container: HTMLElement, value: number) => {
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')
    expect(slider).toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(slider, String(value))
      slider!.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('слайдер живёт в секции chat-scale раздела «Чат»', async () => {
    const container = await renderSettings()

    const section = container.querySelector('[data-settings-section="chat-scale"]')
    expect(section).not.toBeNull()

    const sliders = container.querySelectorAll('input[type="range"]')
    expect(sliders).toHaveLength(1)
    expect(sliders[0]!.getAttribute('aria-label')).toBe('Chat area scale')
    expect(section!.contains(sliders[0]!)).toBe(true)
  })

  it('live-preview: слайдер меняет --chat-scale и стор, но не localStorage', async () => {
    const container = await renderSettings()

    await setSliderValue(container, 1.2)

    expect(useUIStore.getState().chatScale).toBe(1.2)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.2')
    expect(localStorage.getItem(CHAT_SCALE_STORAGE_KEY)).toBeNull()
  })

  it('Save персистит масштаб и пишет личный выбор в профиль', async () => {
    const container = await renderSettings()

    await setSliderValue(container, 1.2)
    await act(async () => {
      byTestId(container, 'chat-save')!.click()
    })

    // Запись в localStorage идёт debounce'ом (~300 мс).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    expect(localStorage.getItem(CHAT_SCALE_STORAGE_KEY)).toBe('1.2')
    expect(useUIStore.getState().chatScale).toBe(1.2)
    expect(profileMock.syncChatScaleToProfile).toHaveBeenCalledWith(1.2)
    expect(profileMock.syncChatViewModeToProfile).toHaveBeenCalledWith('detailed')
    expect(profileMock.syncChatDensityToProfile).toHaveBeenCalledWith('normal')
  })

  it('Cancel откатывает предпросмотр масштаба к сохранённому', async () => {
    const container = await renderSettings()

    await setSliderValue(container, 1.35)
    expect(useUIStore.getState().chatScale).toBe(1.35)

    await act(async () => {
      byTestId(container, 'chat-cancel')!.click()
    })

    expect(useUIStore.getState().chatScale).toBe(CHAT_SCALE_DEFAULT)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1')
    expect(localStorage.getItem(CHAT_SCALE_STORAGE_KEY)).toBeNull()
  })

  it('Reset возвращает дефолтный масштаб; в localStorage — только по Save', async () => {
    useUIStore.setState({ chatScale: 1.3 })
    const container = await renderSettings()

    await act(async () => {
      byTestId(container, 'chat-reset')!.click()
    })

    expect(useUIStore.getState().chatScale).toBe(CHAT_SCALE_DEFAULT)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1')
    expect(localStorage.getItem(CHAT_SCALE_STORAGE_KEY)).toBeNull()
  })

  it('закрытие (unmount) без Save откатывает масштаб', async () => {
    const container = await renderSettings()

    await setSliderValue(container, 1.3)
    expect(useUIStore.getState().chatScale).toBe(1.3)

    await unmountOne(container)

    expect(useUIStore.getState().chatScale).toBe(CHAT_SCALE_DEFAULT)
  })
})
