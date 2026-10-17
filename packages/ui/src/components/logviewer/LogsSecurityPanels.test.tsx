import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getSecurityAudit: vi.fn(),
  getEgressLog: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SecurityAuditPanel, summarizePolicy } from './SecurityAuditPanel'
import { EgressLogPanel } from './EgressLogPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SECURITY_ENTRY = {
  id: 'sa_1',
  ts: '2026-10-10T10:00:00.000Z',
  actor: 'admin',
  scope: 'tools' as const,
  action: 'update' as const,
  source: 'runtime' as const,
  before: { mode: 'deny', list: ['10.0.0.0/8'], exceptions: [] },
  after: { mode: 'allow', list: ['1.1.1.1/32'], exceptions: ['api.example.com'] },
  version: 1,
}

const EGRESS_ENTRY = {
  id: 'eg_1',
  ts: '2026-10-10T11:00:00.000Z',
  scope: 'webhooks' as const,
  host: 'internal.example.com',
  url: 'https://internal.example.com/hook',
  status: 'blocked' as const,
  httpStatus: 403,
  durationMs: 12,
  reason: 'private address',
  matchedRule: '10.0.0.0/8',
}

async function renderPanel(node: React.ReactNode): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>)
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSecurityAudit.mockResolvedValue({ entries: [SECURITY_ENTRY], count: 1 })
  mocks.getEgressLog.mockResolvedValue({ entries: [EGRESS_ENTRY], count: 1 })
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
  document.body.innerHTML = ''
})

describe('summarizePolicy', () => {
  it('сворачивает снимок политики в mode: list; exc …', () => {
    expect(summarizePolicy({ mode: 'deny', list: ['10.0.0.0/8'], exceptions: [] })).toBe(
      'deny: 10.0.0.0/8',
    )
    expect(
      summarizePolicy({
        mode: 'allow',
        list: ['1.1.1.1/32'],
        exceptions: ['api.example.com', '*.corp'],
      }),
    ).toBe('allow: 1.1.1.1/32; exc api.example.com, *.corp')
    expect(summarizePolicy(null)).toBe('—')
    expect(summarizePolicy('restored')).toBe('restored')
  })
})

describe('SecurityAuditPanel — «Безопасность (политики)»', () => {
  it('показывает записи аудита политик (время/автор/скоуп/действие/before→after)', async () => {
    const container = await renderPanel(<SecurityAuditPanel />)

    expect(mocks.getSecurityAudit).toHaveBeenCalledWith(100, undefined)
    const table = container.querySelector('[data-testid="logs-security-table"]')!
    expect(table.textContent).toContain('admin')
    expect(table.textContent).toContain('tools')
    expect(table.textContent).toContain('update')
    expect(table.textContent).toContain('deny: 10.0.0.0/8')
    expect(table.textContent).toContain('allow: 1.1.1.1/32; exc api.example.com')
  })

  it('фильтр по scope перезапрашивает журнал', async () => {
    const container = await renderPanel(<SecurityAuditPanel />)
    const scope = container.querySelector('[data-testid="logs-security-scope"]') as HTMLSelectElement

    await act(async () => {
      scope.value = 'webhooks'
      scope.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})

    expect(mocks.getSecurityAudit).toHaveBeenLastCalledWith(100, 'webhooks')
  })

  it('пустой журнал — пустое состояние', async () => {
    mocks.getSecurityAudit.mockResolvedValue({ entries: [], count: 0 })
    const container = await renderPanel(<SecurityAuditPanel />)
    expect(container.querySelector('[data-testid="logs-security-empty"]')).not.toBeNull()
  })

  it('ошибка загрузки — сообщение об ошибке', async () => {
    mocks.getSecurityAudit.mockRejectedValue(new Error('boom'))
    const container = await renderPanel(<SecurityAuditPanel />)
    expect(container.querySelector('[data-testid="logs-security-error"]')!.textContent).toContain(
      'boom',
    )
  })
})

describe('EgressLogPanel — «Внешние запросы»', () => {
  it('показывает записи журнала (скоуп/host/status/код/длительность/правило)', async () => {
    const container = await renderPanel(<EgressLogPanel />)

    expect(mocks.getEgressLog).toHaveBeenCalledWith(100, undefined, undefined)
    const table = container.querySelector('[data-testid="logs-egress-table"]')!
    expect(table.textContent).toContain('webhooks')
    expect(table.textContent).toContain('internal.example.com')
    expect(table.textContent).toContain('blocked')
    expect(table.textContent).toContain('403')
    expect(table.textContent).toContain('12 ms')
    expect(table.textContent).toContain('private address')
    expect(table.textContent).toContain('10.0.0.0/8')
  })

  it('фильтры scope/status передаются в API', async () => {
    const container = await renderPanel(<EgressLogPanel />)
    const scope = container.querySelector('[data-testid="logs-egress-scope"]') as HTMLSelectElement
    const status = container.querySelector('[data-testid="logs-egress-status"]') as HTMLSelectElement

    await act(async () => {
      scope.value = 'mcp'
      scope.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      status.value = 'allowed'
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})

    expect(mocks.getEgressLog).toHaveBeenLastCalledWith(100, 'mcp', 'allowed')
  })

  it('пустой журнал — пустое состояние', async () => {
    mocks.getEgressLog.mockResolvedValue({ entries: [], count: 0 })
    const container = await renderPanel(<EgressLogPanel />)
    expect(container.querySelector('[data-testid="logs-egress-empty"]')).not.toBeNull()
  })

  it('ошибка загрузки — сообщение об ошибке', async () => {
    mocks.getEgressLog.mockRejectedValue(new Error('network down'))
    const container = await renderPanel(<EgressLogPanel />)
    expect(container.querySelector('[data-testid="logs-egress-error"]')!.textContent).toContain(
      'network down',
    )
  })
})
