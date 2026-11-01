import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore/i18n пишет в localStorage — в Node/vitest его нет.
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

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  policy: 'warn' as 'off' | 'warn' | 'enforce',
}))

vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))
vi.mock('@/lib/api/contextWindowSettings', () => ({
  useContextWindowPolicy: () => mocks.policy,
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import {
  CONTEXT_BLOCK_PERCENT,
  CONTEXT_WARN_PERCENT,
  contextLevel,
  resetContextWindowWarningState,
  useContextWindowUsage,
  useContextWindowWarning,
  type ContextWindowUsage,
} from './useContextWindowUsage'
import { useChatStore, type MessageData } from '@/stores/chatStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useSessionsStore } from '@/stores/sessionsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

let usage: ContextWindowUsage
let warnPercent = 0

function Probe({ sessionId }: { sessionId?: string }) {
  usage = useContextWindowUsage(sessionId)
  return null
}

function WarningProbe({ sessionId, percent }: { sessionId?: string; percent: number }) {
  warnPercent = percent
  useContextWindowWarning(sessionId, percent)
  return null
}

async function render(element: React.ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<I18nProvider>{element}</I18nProvider>)
  })
  await act(async () => {})
  return { root, container }
}

function message(overrides: Partial<MessageData> & { id: string }): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: 'x',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-01T17:00:00.000Z',
    ...overrides,
  } as MessageData
}

function withUsage(id: string, inputTokens: number, overrides: Partial<MessageData> = {}): MessageData {
  return message({
    id,
    usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10 },
    ...overrides,
  })
}

function setMessages(messages: MessageData[], sessionId = 's1'): void {
  useChatStore.setState({ messagesBySession: { [sessionId]: messages } } as never)
}

function setModel(contextWindow?: number): void {
  useProvidersStore.setState({
    models: contextWindow === undefined
      ? [{ id: 'mm', name: 'mm' }]
      : [{ id: 'mm', name: 'mm', context_window: contextWindow }],
    selectedModelName: null,
  } as never)
}

beforeEach(() => {
  mocks.notify.mockClear()
  mocks.policy = 'warn'
  resetContextWindowWarningState()
  try {
    window.sessionStorage.clear()
  } catch {
    // нет storage в окружении — не критично
  }
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: { model: 'mm' } }],
  } as never)
  setModel(200_000)
  setMessages([])
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

describe('useContextWindowUsage — токены и окно', () => {
  it('берёт usage последнего assistant-сообщения', async () => {
    setMessages([withUsage('m1', 195_593)])
    await render(<Probe sessionId="s1" />)
    expect(usage.inputTokens).toBe(195_593)
    expect(usage.percent).toBe(98)
    expect(usage.windowTokens).toBe(200_000)
    expect(usage.isEstimated).toBe(false)
  })

  it('сообщение без usage в конце не сбрасывает процент в 0', async () => {
    setMessages([
      withUsage('m1', 195_593),
      message({ id: 'm2', content: '' }),
    ])
    await render(<Probe sessionId="s1" />)
    expect(usage.inputTokens).toBe(195_593)
    expect(usage.percent).toBe(98)
  })

  it('пропускает disabled/hidden сообщения с usage', async () => {
    setMessages([
      withUsage('m1', 100_000),
      withUsage('m2', 195_593, { disabled: true }),
      withUsage('m3', 195_593, { hidden: true }),
    ])
    await render(<Probe sessionId="s1" />)
    expect(usage.inputTokens).toBe(100_000)
    expect(usage.percent).toBe(50)
  })

  it('live-usage стримящегося сообщения больше last → берётся live', async () => {
    setMessages([
      withUsage('m1', 10_000),
      message({ id: 'live', status: 'streaming', usage: { input_tokens: 150_000, output_tokens: 0, total_tokens: 150_000 } }),
    ])
    await render(<Probe sessionId="s1" />)
    expect(usage.inputTokens).toBe(150_000)
    expect(usage.percent).toBe(75)
    expect(usage.level).toBe('warning')
  })

  it('последний завершённый ответ больше live → берётся он', async () => {
    setMessages([
      withUsage('m1', 120_000),
      message({ id: 'live', status: 'streaming' }),
    ])
    await render(<Probe sessionId="s1" />)
    expect(usage.inputTokens).toBe(120_000)
  })

  it('окно берётся из модели сессии (поиск по id или name)', async () => {
    setModel(100_000)
    setMessages([withUsage('m1', 50_000)])
    await render(<Probe sessionId="s1" />)
    expect(usage.windowTokens).toBe(100_000)
    expect(usage.percent).toBe(50)
    expect(usage.isEstimated).toBe(false)
  })

  it('у модели нет context_window → фолбэк 200 000 и isEstimated', async () => {
    setModel(undefined)
    setMessages([withUsage('m1', 50_000)])
    await render(<Probe sessionId="s1" />)
    expect(usage.windowTokens).toBe(200_000)
    expect(usage.isEstimated).toBe(true)
    expect(usage.percent).toBe(25)
  })

  it('процент клампится в 0..100', async () => {
    setMessages([withUsage('m1', 400_000)])
    await render(<Probe sessionId="s1" />)
    expect(usage.percent).toBe(100)
  })

  it('без сессии/сообщений — ноль', async () => {
    await render(<Probe />)
    expect(usage.inputTokens).toBe(0)
    expect(usage.percent).toBe(0)
    expect(usage.level).toBe('ok')
  })

  it('реагирует на новое сообщение без пересоздания компонента', async () => {
    setMessages([withUsage('m1', 10_000)])
    const { root } = await render(<Probe sessionId="s1" />)
    expect(usage.percent).toBe(5)

    await act(async () => {
      setMessages([withUsage('m1', 10_000), withUsage('m2', 180_000)])
    })
    expect(usage.percent).toBe(90)
    expect(usage.level).toBe('critical')

    await act(async () => {
      root.render(
        <I18nProvider>
          <Probe sessionId="s1" />
        </I18nProvider>,
      )
    })
  })
})

describe('contextLevel — пороги', () => {
  it('ok < 50, notice 50..74, warning 75..89, critical ≥ 90', () => {
    expect(contextLevel(0)).toBe('ok')
    expect(contextLevel(49)).toBe('ok')
    expect(contextLevel(50)).toBe('notice')
    expect(contextLevel(74)).toBe('notice')
    expect(contextLevel(75)).toBe('warning')
    expect(contextLevel(89)).toBe('warning')
    expect(contextLevel(90)).toBe('critical')
    expect(contextLevel(100)).toBe('critical')
  })

  it('пороги предупреждений — 80 (тост) и 90 (блок)', () => {
    expect(CONTEXT_WARN_PERCENT).toBe(80)
    expect(CONTEXT_BLOCK_PERCENT).toBe(90)
  })
})

describe('useContextWindowWarning — тост на 80%', () => {
  it('не показывает тост ниже порога', async () => {
    await render(<WarningProbe sessionId="s1" percent={79} />)
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('показывает тост на 80% и не дублирует на повторном рендере/росте процента', async () => {
    const { root } = await render(<WarningProbe sessionId="s1" percent={80} />)
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(mocks.notify.mock.calls[0]![0]).toMatchObject({ type: 'warning', category: 'queue' })

    await act(async () => {
      root.render(
        <I18nProvider>
          <WarningProbe sessionId="s1" percent={80} />
        </I18nProvider>,
      )
    })
    await act(async () => {})
    expect(mocks.notify).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(
        <I18nProvider>
          <WarningProbe sessionId="s1" percent={95} />
        </I18nProvider>,
      )
    })
    await act(async () => {})
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(warnPercent).toBe(95)
  })

  it('отдельный ключ на сессию', async () => {
    useSessionsStore.setState({
      sessions: [
        { id: 's1', name: 'S', project_id: 'p1', settings: { model: 'mm' } },
        { id: 's2', name: 'S2', project_id: 'p1', settings: { model: 'mm' } },
      ],
    } as never)
    const { root } = await render(<WarningProbe sessionId="s1" percent={80} />)
    expect(mocks.notify).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(
        <I18nProvider>
          <WarningProbe sessionId="s2" percent={80} />
        </I18nProvider>,
      )
    })
    await act(async () => {})
    expect(mocks.notify).toHaveBeenCalledTimes(2)
  })

  it('политика off — тоста нет', async () => {
    mocks.policy = 'off'
    await render(<WarningProbe sessionId="s1" percent={95} />)
    expect(mocks.notify).not.toHaveBeenCalled()
  })
})
