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

const mocks = vi.hoisted(() => ({
  getAnalyticsUsage: vi.fn(),
  getAnalyticsActivity: vi.fn(),
  getAnalyticsDecision: vi.fn(),
  getAnalyticsPrompt: vi.fn(),
  getAnalyticsSummary: vi.fn(),
  getAnalyticsExport: vi.fn(),
  getUsers: vi.fn(),
  getProjects: vi.fn(),
  getAgents: vi.fn(),
  getModels: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { AnalyticsModal } from './AnalyticsModal'
import { useUIStore } from '@/stores/useUIStore'
import type { AnalyticsReport, AnalyticsSummary } from '@itphx/synth-shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

// jsdom + React-рендер: эффекты/промисы мок-API доводим макро-барьером.
vi.setConfig({ testTimeout: 15_000 })

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const PERIOD = { from: '2026-09-19', to: '2026-10-18' }

function usageReport(): AnalyticsReport {
  return {
    report: 'usage',
    ...PERIOD,
    groupBy: ['day'],
    rows: [
      {
        dimensions: { day: '2026-10-17' },
        measures: { input_tokens: 1000, output_tokens: 500, requests: 2 },
        costByCurrency: { USD: 0.01 },
      },
      {
        dimensions: { day: '2026-10-18' },
        measures: { input_tokens: 2000, output_tokens: 700, requests: 3 },
        costByCurrency: { USD: 0.02 },
      },
    ],
  }
}

function activityReport(): AnalyticsReport {
  return {
    report: 'activity',
    ...PERIOD,
    groupBy: ['day'],
    rows: [
      {
        dimensions: { day: '2026-10-18' },
        measures: { sessions_created: 2, messages_user: 4, tool_calls: 7, errors: 1 },
      },
    ],
  }
}

function summary(): AnalyticsSummary {
  return {
    ...PERIOD,
    usage: { input_tokens: 3000, output_tokens: 1200, total_tokens: 4200, requests: 5, cache_hit_rate: 0.25 },
    activity: { sessions_created: 2, messages_user: 4, messages_assistant: 4, messages_tool: 2, tool_calls: 7, errors: 1 },
    decision: { calls: 3, handled: 2, fallback: 1, escalated: 0, attempts: 3, rejected: 0 },
    costByCurrency: { USD: 0.03 },
  }
}

function forbidden(): Error {
  return Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' })
}

async function renderModal(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({ isAnalyticsDialogOpen: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <AnalyticsModal />
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getUsers.mockResolvedValue({ users: [] })
  mocks.getProjects.mockResolvedValue([])
  mocks.getAgents.mockResolvedValue({ agents: [], default_agent: null })
  mocks.getModels.mockResolvedValue([])
  mocks.getAnalyticsUsage.mockResolvedValue(usageReport())
  mocks.getAnalyticsActivity.mockResolvedValue(activityReport())
  mocks.getAnalyticsDecision.mockResolvedValue({
    report: 'decision',
    ...PERIOD,
    groupBy: ['day'],
    rows: [{ dimensions: { day: '2026-10-18' }, measures: { calls: 3, handled: 2 } }],
  })
  mocks.getAnalyticsPrompt.mockResolvedValue({
    report: 'prompt',
    ...PERIOD,
    groupBy: ['model', 'agent'],
    rows: [
      {
        dimensions: { model: 'm1', agent: 'assistant' },
        measures: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 60, duration_ms: 1000 },
      },
    ],
  })
  mocks.getAnalyticsSummary.mockResolvedValue(summary())
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  // Диалог/портал печати рендерятся в document.body — чистим остатки.
  document.body.innerHTML = ''
})

describe('AnalyticsModal (PROP-102, волна 2)', () => {
  it('рендерит четыре вкладки и отчёт «Расход и стоимость» с итоговой строкой', async () => {
    await renderModal()

    expect(findButton('Usage & cost')).toBeTruthy()
    expect(findButton('Activity')).toBeTruthy()
    expect(findButton('Decision')).toBeTruthy()
    expect(findButton('Cache & efficiency')).toBeTruthy()

    const table = document.body.querySelector('[data-testid="analytics-table"]')
    expect(table).toBeTruthy()
    expect(table!.textContent).toContain('2026-10-17')
    // Итоговая строка считается клиентом из сумм сырых счётчиков.
    expect(table!.textContent).toContain('Total')
    expect(table!.textContent).toContain('3k')

    // Сводка инстанса — отдельный запрос (usage + activity), карточка стоимости.
    expect(mocks.getAnalyticsUsage).toHaveBeenCalledTimes(1)
    expect(mocks.getAnalyticsSummary).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('~ 0.03 $')
  })

  it('403 на decision: понятное сообщение без повторов и падения', async () => {
    mocks.getAnalyticsDecision.mockRejectedValue(forbidden())
    mocks.getAnalyticsSummary.mockRejectedValue(forbidden())
    await renderModal()

    await act(async () => {
      findButton('Decision')!.click()
    })
    await flush()

    const notice = document.body.querySelector('[data-testid="analytics-forbidden"]')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('not available for your role')
    // Ошибка загрузки не подменяет сообщение о роли.
    expect(document.body.textContent).not.toContain('Failed to load the report')
    // 403 не ретраится: эффект зависит только от фильтров (запрос ровно один).
    expect(mocks.getAnalyticsDecision).toHaveBeenCalledTimes(1)
    await flush(2)
    expect(mocks.getAnalyticsDecision).toHaveBeenCalledTimes(1)
  })

  it('403 на summary для USER: отчёт usage остаётся, сводка помечена как недоступная', async () => {
    mocks.getAnalyticsSummary.mockRejectedValue(forbidden())
    await renderModal()

    expect(document.body.querySelector('[data-testid="analytics-table"]')).toBeTruthy()
    expect(document.body.textContent).toContain('The instance summary is not available for your role')
    expect(document.body.querySelector('[data-testid="analytics-forbidden"]')).toBeNull()
  })

  it('переключение на «Активность» грузит свой отчёт', async () => {
    await renderModal()

    await act(async () => {
      findButton('Activity')!.click()
    })
    await flush()

    expect(mocks.getAnalyticsActivity).toHaveBeenCalledTimes(1)
    const table = document.body.querySelector('[data-testid="analytics-table"]')
    expect(table).toBeTruthy()
    expect(table!.textContent).toContain('Tool calls')
    expect(table!.textContent).toContain('2026-10-18')
  })
})
