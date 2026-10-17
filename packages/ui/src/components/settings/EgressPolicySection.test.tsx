import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getEgressPolicy: vi.fn(),
  saveEgressPolicy: vi.fn(),
  resetEgressPolicy: vi.fn(),
  checkEgress: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { EgressPolicySection } from './EgressPolicySection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const DEFAULTS = { mode: 'deny' as const, list: ['10.0.0.0/8', '127.0.0.0/8'], exceptions: [] }
const OVERRIDDEN = {
  mode: 'deny' as const,
  list: ['10.0.0.0/8'],
  exceptions: ['*.internal.example.com'],
}

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderSection(
  scope: 'tools' | 'webhooks',
  allowOff = false,
): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <EgressPolicySection
          scope={scope}
          allowOff={allowOff}
          titleKey={scope === 'tools' ? 'egress.tools.title' : 'egress.webhooks.title'}
          descriptionKey={
            scope === 'tools' ? 'egress.tools.description' : 'egress.webhooks.description'
          }
          testIdPrefix={`egress-${scope}`}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

async function openOptions(trigger: HTMLElement): Promise<HTMLElement[]> {
  await act(async () => {
    trigger.click()
  })
  return [...document.body.querySelectorAll('[role="option"]')] as HTMLElement[]
}

async function selectOption(trigger: HTMLElement, label: string): Promise<void> {
  const options = await openOptions(trigger)
  const option = options.find((o) => o.textContent?.trim().startsWith(label)) as
    | HTMLElement
    | undefined
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getEgressPolicy.mockResolvedValue({
    policy: OVERRIDDEN,
    isOverridden: true,
    defaults: DEFAULTS,
  })
  mocks.saveEgressPolicy.mockImplementation(async (_scope: string, policy: unknown) => policy)
  mocks.resetEgressPolicy.mockResolvedValue(DEFAULTS)
  mocks.checkEgress.mockResolvedValue({
    allowed: true,
    matchedRule: '*.internal.example.com',
    addresses: ['93.184.216.34'],
    policy: OVERRIDDEN,
  })
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

describe('EgressPolicySection — адресная egress-политика (ADR-071/ADR-072)', () => {
  it('загружает политику и рендерит заголовок/список/исключения', async () => {
    const container = await renderSection('tools')

    expect(mocks.getEgressPolicy).toHaveBeenCalledWith('tools')
    expect(container.textContent).toContain('Outgoing requests of built-in tools')
    expect(container.textContent).toContain('10.0.0.0/8')
    expect(container.textContent).toContain('*.internal.example.com')
    // Текущее значение не равно серверному дефолту → Reset активен.
    const reset = byTestId(container, 'egress-tools-reset') as HTMLButtonElement
    expect(reset.disabled).toBe(false)
  })

  it('для tools в режимах нет off (только deny/allow)', async () => {
    const container = await renderSection('tools')
    const trigger = byTestId(container, 'egress-tools-mode')!
    const options = (await openOptions(trigger)).map((o) => o.textContent?.trim() ?? '')
    expect(options.some((o) => o.startsWith('deny'))).toBe(true)
    expect(options.some((o) => o.startsWith('allow'))).toBe(true)
    expect(options.some((o) => o.startsWith('off'))).toBe(false)
  })

  it('для webhooks доступен off и показывается красное предупреждение', async () => {
    mocks.getEgressPolicy.mockResolvedValue({
      policy: { mode: 'off', list: [], exceptions: [] },
      isOverridden: true,
      defaults: DEFAULTS,
    })
    const container = await renderSection('webhooks', true)

    expect(byTestId(container, 'egress-webhooks-off-warning')).not.toBeNull()
    expect(byTestId(container, 'egress-webhooks-off-warning')!.textContent).toContain(
      'disables egress checks',
    )

    // Переключение на allow убирает предупреждение.
    await selectOption(byTestId(container, 'egress-webhooks-mode')!, 'allow')
    expect(byTestId(container, 'egress-webhooks-off-warning')).toBeNull()
  })

  it('сохраняет изменённую политику и показывает success-тост', async () => {
    const container = await renderSection('tools')

    await selectOption(byTestId(container, 'egress-tools-mode')!, 'allow')

    const input = container.querySelector('input[placeholder="10.0.0.0/8"]') as HTMLInputElement
    await act(async () => {
      setInputValue(input, '192.168.0.0/16')
    })
    const add = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Add',
    ) as HTMLButtonElement
    await act(async () => {
      add.click()
    })

    const save = byTestId(container, 'egress-tools-save') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(mocks.saveEgressPolicy).toHaveBeenCalledWith('tools', {
      mode: 'allow',
      list: ['10.0.0.0/8', '192.168.0.0/16'],
      exceptions: ['*.internal.example.com'],
    })
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
  })

  it('ошибка 400 при сохранении — error-тост, значение не теряется', async () => {
    mocks.saveEgressPolicy.mockRejectedValue(new Error('policy: invalid CIDR'))
    const container = await renderSection('tools')

    await selectOption(byTestId(container, 'egress-tools-mode')!, 'allow')
    const save = byTestId(container, 'egress-tools-save') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('policy: invalid CIDR'),
      }),
    )
    // Правка осталась несохранённой (Save по-прежнему активен).
    expect((byTestId(container, 'egress-tools-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Reset вызывает API сброса и возвращает серверный дефолт', async () => {
    const container = await renderSection('tools')

    const reset = byTestId(container, 'egress-tools-reset') as HTMLButtonElement
    await act(async () => {
      reset.click()
    })
    await act(async () => {})

    expect(mocks.resetEgressPolicy).toHaveBeenCalledWith('tools')
    expect(container.textContent).toContain('127.0.0.0/8')
    // После сброса сохранять нечего.
    expect((byTestId(container, 'egress-tools-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('«Проверить»: allowed показывает вердикт, правило и адреса', async () => {
    const container = await renderSection('tools')
    const url = byTestId(container, 'egress-tools-check-url') as HTMLInputElement
    await act(async () => {
      setInputValue(url, 'https://api.example.com/hook')
    })
    await act(async () => {
      ;(byTestId(container, 'egress-tools-check-button') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.checkEgress).toHaveBeenCalledWith('tools', 'https://api.example.com/hook')
    const result = byTestId(container, 'egress-tools-check-result')!
    expect(result.textContent).toContain('Allowed')
    expect(result.textContent).toContain('*.internal.example.com')
    expect(result.textContent).toContain('93.184.216.34')
  })

  it('«Проверить»: blocked показывает причину и сработавшее правило', async () => {
    mocks.checkEgress.mockResolvedValue({
      allowed: false,
      reason: 'private address',
      matchedRule: '10.0.0.0/8',
      addresses: ['10.1.2.3'],
      policy: OVERRIDDEN,
    })
    const container = await renderSection('tools')
    await act(async () => {
      setInputValue(byTestId(container, 'egress-tools-check-url') as HTMLInputElement, 'http://10.1.2.3/x')
    })
    await act(async () => {
      ;(byTestId(container, 'egress-tools-check-button') as HTMLButtonElement).click()
    })
    await act(async () => {})

    const result = byTestId(container, 'egress-tools-check-result')!
    expect(result.textContent).toContain('Blocked: private address')
    expect(result.textContent).toContain('10.0.0.0/8')
    expect(result.textContent).toContain('10.1.2.3')
  })

  it('ошибка загрузки политики показывается в секции', async () => {
    mocks.getEgressPolicy.mockRejectedValue(new Error('boom'))
    const container = await renderSection('tools')
    expect(container.textContent).toContain('Failed to load egress policy: boom')
  })
})
