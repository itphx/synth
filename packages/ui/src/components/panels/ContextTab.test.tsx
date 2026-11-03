import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getOptimization: vi.fn(),
  updateOptimization: vi.fn(),
  notify: vi.fn(),
}))

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

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ContextTab } from './ContextTab'
import { useUIStore } from '@/stores/useUIStore'
import { useChatStore } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const OPTIMIZATION = {
  context_optimization: 'none',
  sliding_window_mode: 'messages',
  sliding_window_message_limit: 10,
  sliding_window_token_threshold: 80,
  summarization_enabled: false,
  summarization_trigger_mode: 'messages',
  summarize_after_n: 10,
  summarize_token_threshold: 50,
  summarization_keep_tokens: 5000,
  compaction_keep_tokens: 15000,
  compaction_token_threshold: 85,
}

/** Установить значение контролируемого input так, как это делает React. */
function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderContext(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ContextTab />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.getOptimization.mockResolvedValue(OPTIMIZATION)
  mocks.updateOptimization.mockResolvedValue({})

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useChatStore.setState({ stickyNotesBySession: {}, streamFinishTickBySession: {} })
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
})

describe('ContextTab — базовая отрисовка', () => {
  it('рендерит блоки оптимизации контекста и не содержит MCP-таблицы', async () => {
    const container = await renderContext()
    expect(container.querySelector('[data-testid="context-mcp-list"]')).toBeNull()
    // Отдельной кнопки Save нет — сохранение идёт по контролам (см. ниже).
    expect(container.querySelector('[data-testid="panel-tab-footer"]')).toBeNull()
    expect(container.textContent).toContain(enDict['rightPanel.context.stickyNotes'])
    expect(container.textContent).toContain(enDict['rightPanel.context.optimization.sliding_window'])
    expect(container.textContent).toContain(enDict['rightPanel.context.optimization.summarization'])
    expect(container.textContent).toContain(enDict['rightPanel.context.optimization.compaction'])
    expect(container.textContent).toContain(enDict['rightPanel.context.summarizationKeepTokens'])
    expect(container.textContent).toContain(enDict['rightPanel.context.compactionKeepTokens'])
    expect(container.textContent).toContain(enDict['rightPanel.context.compactionThreshold'])
  })

  it('тумблеры сохраняют сразу: во время сохранения — pending-индикация без «запрета»', async () => {
    let resolveUpdate: (value: unknown) => void = () => {}
    mocks.updateOptimization.mockImplementation(
      () => new Promise((resolve) => { resolveUpdate = resolve }),
    )
    const container = await renderContext()

    const switchAt = (i: number) =>
      container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')[i]
    expect(container.querySelectorAll('button[role="switch"]')).toHaveLength(3)

    await act(async () => {
      switchAt(0).click()
    })

    const pending = switchAt(0)
    expect(pending.disabled).toBe(false)
    expect(pending.getAttribute('aria-busy')).toBe('true')
    expect(pending.classList.contains('cursor-progress')).toBe(true)
    expect(container.querySelectorAll('button[role="switch"]')[1].getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      resolveUpdate({})
    })
    expect(switchAt(0).getAttribute('aria-busy')).toBeNull()
    expect(switchAt(0).classList.contains('cursor-progress')).toBe(false)
    // Тумблер сохраняет сразу: режим улетает на сервер без отдельной кнопки Save.
    expect(mocks.updateOptimization).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ context_optimization: 'sliding_window' }),
    )
  })

  it('изменение числа сохраняется сразу (без кнопки Save)', async () => {
    const container = await renderContext()
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')
    expect(input).not.toBeNull()
    expect(input!.disabled).toBe(false)

    await act(async () => {
      setNativeValue(input!, '15')
    })

    expect(mocks.updateOptimization).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sliding_window_message_limit: 15 }),
    )
  })

  it('при ошибке сохранения числа значение откатывается к прежнему', async () => {
    mocks.updateOptimization.mockRejectedValueOnce(new Error('boom'))
    const container = await renderContext()
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!
    expect(input.value).toBe('10')

    await act(async () => {
      setNativeValue(input, '15')
    })
    await act(async () => {})

    // Оптимистичное значение откатано к серверному.
    expect(container.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('10')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['panel.saveError'], type: 'error' }),
    )
  })

  it('при ошибке сохранения радио выбор откатывается к прежнему', async () => {
    mocks.updateOptimization.mockRejectedValueOnce(new Error('boom'))
    const container = await renderContext()
    // Радио-кнопки: [0] окно/сообщения, [1] окно/токены, [2] суммаризация/сообщения, [3] суммаризация/токены.
    const radios = () =>
      container.querySelectorAll<HTMLButtonElement>('button[data-compact].rounded-full')
    expect(radios()).toHaveLength(4)
    expect(radios()[0].className).toContain('bg-primary')
    expect(radios()[1].className).not.toContain('bg-primary')

    await act(async () => {
      radios()[1].click()
    })
    await act(async () => {})

    // Выбор «токены» откатан к «сообщениям».
    expect(radios()[0].className).toContain('bg-primary')
    expect(radios()[1].className).not.toContain('bg-primary')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['panel.saveError'], type: 'error' }),
    )
  })

  it('при ошибке сохранения тумблеры откатываются к серверному состоянию', async () => {
    mocks.updateOptimization.mockRejectedValueOnce(new Error('boom'))
    const container = await renderContext()
    const switchAt = (i: number) =>
      container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')[i]
    expect(switchAt(0).getAttribute('aria-checked')).toBe('false')
    expect(switchAt(1).getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      switchAt(0).click()
    })
    await act(async () => {})

    // Оптимистичное включение откатано; соседний тумблер не «залип» выключенным/включённым.
    expect(switchAt(0).getAttribute('aria-checked')).toBe('false')
    expect(switchAt(1).getAttribute('aria-checked')).toBe('false')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['panel.saveError'], type: 'error' }),
    )
  })
})

describe('ContextTab — режимы сжатия контекста', () => {
  const switches = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
  const numbers = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')]

  it('загружает режим compaction: включён третий тумблер, значения из ответа', async () => {
    mocks.getOptimization.mockResolvedValue({
      ...OPTIMIZATION,
      context_optimization: 'compaction',
      compaction_keep_tokens: 18000,
      compaction_token_threshold: 90,
    })
    const container = await renderContext()

    expect(switches(container).map((s) => s.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ])
    // [0..1] окно, [2..3] триггеры суммаризации, [4] хвост суммаризации,
    // [5] порог компактизации, [6] хвост компактизации.
    expect(numbers(container).map((i) => i.value)).toEqual([
      '10',
      '80',
      '10',
      '50',
      '5000',
      '90',
      '18000',
    ])
  })

  it('включение компактизации выключает остальные режимы, summarization_enabled=true', async () => {
    mocks.getOptimization.mockResolvedValue({
      ...OPTIMIZATION,
      context_optimization: 'summarization',
    })
    const container = await renderContext()
    expect(switches(container).map((s) => s.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ])

    await act(async () => {
      switches(container)[2].click()
    })

    expect(switches(container).map((s) => s.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ])
    expect(mocks.updateOptimization).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        context_optimization: 'compaction',
        summarization_enabled: true,
        summarization_keep_tokens: 5000,
        compaction_keep_tokens: 15000,
        compaction_token_threshold: 85,
      }),
    )
  })

  it('выключение суммаризации даёт режим none и summarization_enabled=false', async () => {
    mocks.getOptimization.mockResolvedValue({
      ...OPTIMIZATION,
      context_optimization: 'summarization',
    })
    const container = await renderContext()

    await act(async () => {
      switches(container)[1].click()
    })

    expect(mocks.updateOptimization).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        context_optimization: 'none',
        summarization_enabled: false,
      }),
    )
    expect(switches(container).map((s) => s.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'false',
    ])
  })

  it('включение скользящего окна держит legacy-флаг сжатия включённым', async () => {
    const container = await renderContext()

    await act(async () => {
      switches(container)[0].click()
    })

    expect(mocks.updateOptimization).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        context_optimization: 'sliding_window',
        summarization_enabled: true,
      }),
    )
  })

  it('legacy-сессия (none + summarization_enabled) показывается как суммаризация', async () => {
    mocks.getOptimization.mockResolvedValue({
      ...OPTIMIZATION,
      context_optimization: 'none',
      summarization_enabled: true,
    })
    const container = await renderContext()

    expect(switches(container).map((s) => s.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ])
  })

  it('правка числа в legacy-сессии не выключает сжатие', async () => {
    mocks.getOptimization.mockResolvedValue({
      ...OPTIMIZATION,
      context_optimization: 'none',
      summarization_enabled: true,
    })
    const container = await renderContext()

    await act(async () => {
      setNativeValue(numbers(container)[4], '7000')
    })

    expect(mocks.updateOptimization).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({
        context_optimization: 'summarization',
        summarization_enabled: true,
        summarization_keep_tokens: 7000,
      }),
    )
  })

  it('поля сжатия сохраняются сразу: хвост суммаризации, порог и хвост компактизации', async () => {
    const container = await renderContext()

    await act(async () => {
      setNativeValue(numbers(container)[4], '7000')
    })
    expect(mocks.updateOptimization).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ summarization_keep_tokens: 7000 }),
    )

    await act(async () => {
      setNativeValue(numbers(container)[5], '90')
    })
    expect(mocks.updateOptimization).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ compaction_token_threshold: 90 }),
    )

    await act(async () => {
      setNativeValue(numbers(container)[6], '20000')
    })
    expect(mocks.updateOptimization).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ compaction_keep_tokens: 20000 }),
    )
  })
})
