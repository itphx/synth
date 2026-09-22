import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getProviders: vi.fn(async () => ({ providers: [] })),
    fetchJSON: vi.fn(),
  },
}))

// imageIcon замокан: реальный canvas в jsdom недоступен, а нам нужен контроль
// над сжатием, чтобы проверить именно логику панели (когда/куда применяется результат).
vi.mock('@/lib/imageIcon', () => ({
  MAX_STORED_ICON_LENGTH: 8192,
  isOversizedIcon: (value: string | null | undefined, limit = 8192) =>
    typeof value === 'string' && value.startsWith('data:image/') && value.length > limit,
  downscaleIconDataUrl: vi.fn(async () => 'data:image/png;base64,SMALL'),
}))

import { synthApi, type ProviderInfo } from '@/lib/api/synthApi'
import { downscaleIconDataUrl } from '@/lib/imageIcon'
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

async function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

describe('ProvidersPanel: тяжёлая иконка сжимается перед сохранением', () => {
  it('fetch-icon с большим data-URL → применяется сжатая иконка, сырой строки в разметке нет', async () => {
    const bigIcon = `data:image/png;base64,${'B'.repeat(9000)}`
    vi.mocked(synthApi.fetchJSON).mockResolvedValueOnce({
      icon: bigIcon,
      source: 'https://api.example.com/favicon.ico',
    })

    const host = await renderPanel()
    await act(async () => {
      findButton(host, 'admin.providers.add').click()
    })

    const urlInput = host.querySelector('input[placeholder="https://api.openai.com/v1"]') as HTMLInputElement
    expect(urlInput).toBeTruthy()
    await setInputValue(urlInput, 'https://api.example.com/v1')

    // Секция авто-определения свёрнута по умолчанию — раскрываем.
    await act(async () => {
      findButton(host, 'admin.providers.autoDetectFavicon').click()
    })

    await act(async () => {
      findButton(host, 'admin.providers.detect').click()
    })
    await act(async () => {})

    expect(synthApi.fetchJSON).toHaveBeenCalledWith(
      '/api/v2/providers/fetch-icon',
      expect.objectContaining({ method: 'POST' }),
    )
    // Превью уже сжато, сырой data-URL в разметку не попадает.
    expect(host.innerHTML).not.toContain(bigIcon)

    await act(async () => {
      findButton(host, 'admin.providers.use').click()
    })
    await act(async () => {})

    expect(downscaleIconDataUrl).toHaveBeenCalledWith(bigIcon)
    expect(host.innerHTML).not.toContain(bigIcon)
    expect(host.textContent).toContain('admin.providers.iconImage')
    const srcs = Array.from(host.querySelectorAll('img')).map((img) => img.getAttribute('src'))
    expect(srcs).toContain('data:image/png;base64,SMALL')
  })

  function mockProviderWithIcon(icon: string) {
    vi.mocked(synthApi.getProviders).mockResolvedValueOnce({
      providers: [
        {
          name: 'itphx',
          type: 'openai',
          icon,
          url: 'https://api.example.com/v1',
          model: 'model',
          enabled: true,
        },
      ],
      default_provider: 'itphx',
    })
  }

  it('сжатие успешно → в форме лёгкий data-URL, хинта нет', async () => {
    const bigIcon = `data:image/png;base64,${'C'.repeat(9000)}`
    mockProviderWithIcon(bigIcon)

    const host = await renderPanel()
    await act(async () => {
      findButtonByLabel(host, 'admin.providers.edit').click()
    })
    await act(async () => {})

    expect(downscaleIconDataUrl).toHaveBeenCalledWith(bigIcon)
    const srcs = Array.from(host.querySelectorAll('img')).map((img) => img.getAttribute('src'))
    expect(srcs).toContain('data:image/png;base64,SMALL')
    // После успешного сжатия в форме лёгкий data-URL — подсказка не нужна.
    expect(host.textContent).not.toContain('admin.providers.iconUncompressed')
  })

  it('сжатие не удалось → в форме тяжёлый data-URL и честный хинт', async () => {
    const bigIcon = `data:image/png;base64,${'F'.repeat(9000)}`
    // Мок возвращает вход как есть — эмулируем формат, который canvas не декодирует.
    vi.mocked(downscaleIconDataUrl).mockImplementationOnce(async (value: string) => value)
    mockProviderWithIcon(bigIcon)

    const host = await renderPanel()
    await act(async () => {
      findButtonByLabel(host, 'admin.providers.edit').click()
    })
    await act(async () => {})

    expect(downscaleIconDataUrl).toHaveBeenCalledWith(bigIcon)
    expect(host.textContent).toContain('admin.providers.iconUncompressed')
    const srcs = Array.from(host.querySelectorAll('img')).map((img) => img.getAttribute('src'))
    expect(srcs).toContain(bigIcon)
  })

  it('выбор брендовой иконки сбрасывает хинт', async () => {
    const bigIcon = `data:image/png;base64,${'D'.repeat(9000)}`
    // Сжатие «не удалось» (например, нечитаемый ICO) — в форме остаётся тяжёлый data-URL.
    vi.mocked(downscaleIconDataUrl).mockImplementationOnce(async (value: string) => value)
    mockProviderWithIcon(bigIcon)

    const host = await renderPanel()
    await act(async () => {
      findButtonByLabel(host, 'admin.providers.edit').click()
    })
    await act(async () => {})
    expect(host.textContent).toContain('admin.providers.iconUncompressed')

    // Раскрываем секцию «Брендовые» и выбираем лёгкую иконку.
    await act(async () => {
      findButton(host, 'admin.providers.brand').click()
    })
    const brandButton = host.querySelector('button[title="ollama"]') as HTMLButtonElement
    expect(brandButton).toBeTruthy()
    await act(async () => {
      brandButton.click()
    })

    expect(host.textContent).not.toContain('admin.providers.iconUncompressed')
    expect(host.textContent).toContain('brand:ollama')
  })

  it('«Сбросить» сбрасывает хинт', async () => {
    const bigIcon = `data:image/png;base64,${'E'.repeat(9000)}`
    vi.mocked(downscaleIconDataUrl).mockImplementationOnce(async (value: string) => value)
    mockProviderWithIcon(bigIcon)

    const host = await renderPanel()
    await act(async () => {
      findButtonByLabel(host, 'admin.providers.edit').click()
    })
    await act(async () => {})
    expect(host.textContent).toContain('admin.providers.iconUncompressed')

    await act(async () => {
      findButton(host, 'admin.providers.reset').click()
    })

    expect(host.textContent).not.toContain('admin.providers.iconUncompressed')
    expect(host.textContent).toContain('admin.providers.notSelected')
  })
})

describe('ProvidersPanel: валюта провайдера', () => {
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

  function findInputByLabel(host: HTMLElement, label: string): HTMLInputElement {
    const labelEl = Array.from(host.querySelectorAll('label')).find(
      (l) => (l.textContent ?? '').trim() === label,
    )
    expect(labelEl).toBeTruthy()
    const input = labelEl!.parentElement?.querySelector('input')
    expect(input).toBeTruthy()
    return input as HTMLInputElement
  }

  async function openCurrencySelect(host: HTMLElement): Promise<void> {
    const trigger = host.querySelector('[aria-label="admin.providers.currency"]') as HTMLElement | null
    expect(trigger).toBeTruthy()
    await act(async () => {
      trigger!.click()
    })
  }

  function currencyOptions(): HTMLElement[] {
    return [...document.body.querySelectorAll('[role="option"]')] as HTMLElement[]
  }

  async function save(host: HTMLElement): Promise<void> {
    const saveButton = host.querySelector('[data-testid="provider-save"]') as HTMLButtonElement | null
    expect(saveButton).toBeTruthy()
    await act(async () => {
      saveButton!.click()
    })
    await act(async () => {})
  }

  function savedCurrency(): unknown {
    const call = vi.mocked(synthApi.fetchJSON).mock.calls.find(([url]) => url === '/api/v2/providers')
    expect(call).toBeTruthy()
    return JSON.parse((call![1] as RequestInit).body as string).currency
  }

  it('создание отправляет currency: USD по умолчанию, валюту не трогаем', async () => {
    mockProviders([])
    const host = await renderPanel()
    await act(async () => {
      findButton(host, 'admin.providers.add').click()
    })
    await setInputValue(findInputByLabel(host, 'admin.providers.name'), 'new-provider')
    await save(host)

    expect(savedCurrency()).toBe('USD')
  })

  it('выбор RUB сохраняется в тело POST /providers', async () => {
    mockProviders([{ ...baseProvider, currency: 'USD' }])
    const host = await renderPanel()
    await act(async () => {
      findButtonByLabel(host, 'admin.providers.edit').click()
    })

    await openCurrencySelect(host)
    const option = currencyOptions().find((o) =>
      (o.textContent ?? '').includes('admin.providers.currency.RUB'),
    )
    expect(option).toBeTruthy()
    await act(async () => {
      option!.click()
    })
    await act(async () => {})
    await save(host)

    expect(savedCurrency()).toBe('RUB')
  })

  it('в списке нет опции «Не задано» (currencyNone), USD помечен как по умолчанию', async () => {
    mockProviders([])
    const host = await renderPanel()
    await act(async () => {
      findButton(host, 'admin.providers.add').click()
    })
    await openCurrencySelect(host)

    const options = currencyOptions()
    expect(options).toHaveLength(3)
    expect(options.some((o) => (o.textContent ?? '').includes('currencyNone'))).toBe(false)
    expect(options.some((o) => (o.textContent ?? '').includes('Не задано'))).toBe(false)

    const usd = options.find((o) => (o.textContent ?? '').includes('admin.providers.currency.USD'))
    expect(usd).toBeTruthy()
    expect(usd!.textContent).toContain('admin.providers.currencyDefault')

    const rub = options.find((o) => (o.textContent ?? '').includes('admin.providers.currency.RUB'))
    expect(rub).toBeTruthy()
    expect(rub!.textContent).not.toContain('admin.providers.currencyDefault')
  })

  it('редактирование с currency: RUB предзаполняет RUB', async () => {
    mockProviders([{ ...baseProvider, currency: 'RUB' }])
    const host = await renderPanel()
    await act(async () => {
      findButtonByLabel(host, 'admin.providers.edit').click()
    })
    await save(host)

    expect(savedCurrency()).toBe('RUB')
  })

  it('редактирование без валюты предзаполняет USD', async () => {
    mockProviders([{ ...baseProvider, currency: undefined }])
    const host = await renderPanel()
    await act(async () => {
      findButtonByLabel(host, 'admin.providers.edit').click()
    })
    await save(host)

    expect(savedCurrency()).toBe('USD')
  })
})
