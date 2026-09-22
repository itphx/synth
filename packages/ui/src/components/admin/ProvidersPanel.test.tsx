import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getProviders: vi.fn(async () => ({ providers: [] })),
  },
}))

import { synthApi, type ProviderInfo } from '@/lib/api/synthApi'
import { ProvidersPanel } from './ProvidersPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: { host: HTMLElement; root: Root }[] = []

async function renderPanel(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<ProvidersPanel />)
  })
  // load() в useEffect асинхронный — даём микротаскам завершиться
  await act(async () => {})
  return host
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(label))
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function findButtonByLabel(host: HTMLElement, label: string): HTMLButtonElement {
  const button = host.querySelector(`button[aria-label="${label}"]`)
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
  vi.restoreAllMocks()
})

describe('ProvidersPanel: поле API-ключа провайдера не предлагается для сохранения', () => {
  it('размечено id/name/autocomplete и анти-атрибутами менеджеров паролей', async () => {
    const host = await renderPanel()
    await act(async () => {
      findButton(host, 'admin.providers.add').click()
    })

    const input = host.querySelector('#admin-provider-api-key') as HTMLInputElement | null
    expect(input).toBeTruthy()
    expect(input!.tagName).toBe('INPUT')
    expect(input!.getAttribute('type')).toBe('password')

    // Браузер/менеджеры паролей не должны предлагать сохранить значение
    expect(input!.getAttribute('autocomplete')).toBe('off')
    expect(input!.getAttribute('name')).toBe('providerApiKey')
    expect(input!.getAttribute('data-1p-ignore')).toBe('')
    expect(input!.getAttribute('data-lpignore')).toBe('true')
    expect(input!.getAttribute('data-bwignore')).toBe('')
    expect(input!.getAttribute('data-form-type')).toBe('other')

    // name не выглядит как логин/пароль учётной записи
    const name = input!.getAttribute('name') ?? ''
    expect(name).not.toMatch(/password|username|login|account/i)

    // label связан с полем через htmlFor
    const label = host.querySelector('label[for="admin-provider-api-key"]')
    expect(label).toBeTruthy()
    expect((label as HTMLLabelElement).htmlFor).toBe(input!.id)
  })
})

describe('ProvidersPanel: иконка провайдера в форме показывается человекочитаемо', () => {
  const baseProvider: ProviderInfo = {
    name: 'itphx',
    type: 'openai',
    icon: '',
    url: 'https://api.example.com/v1',
    model: 'model',
    enabled: true,
  }

  function mockProviders(providers: ProviderInfo[]) {
    vi.mocked(synthApi.getProviders).mockResolvedValueOnce({
      providers,
      default_provider: providers[0]?.name ?? '',
    })
  }

  async function openEdit(host: HTMLElement) {
    await act(async () => {
      findButtonByLabel(host, 'admin.providers.edit').click()
    })
  }

  it('data:image base64 — подпись ключом iconImage, сырой base64 в тексте отсутствует', async () => {
    const longIcon = `data:image/png;base64,${'A'.repeat(600)}`
    mockProviders([{ ...baseProvider, icon: longIcon }])
    const host = await renderPanel()
    await openEdit(host)

    expect(host.textContent).toContain('admin.providers.iconImage')
    expect(host.textContent).not.toContain('base64')
    expect(host.textContent).not.toContain(longIcon)
  })

  it('brand — подпись равна исходному значению', async () => {
    mockProviders([{ ...baseProvider, icon: 'brand:ollama' }])
    const host = await renderPanel()
    await openEdit(host)

    expect(host.textContent).toContain('brand:ollama')
  })

  it('url — подпись host, полный URL в тексте не показывается', async () => {
    mockProviders([{ ...baseProvider, icon: 'https://openrouter.ai/api/v1' }])
    const host = await renderPanel()
    await openEdit(host)

    expect(host.textContent).toContain('openrouter.ai')
    expect(host.textContent).not.toContain('/api/v1')
  })
})
