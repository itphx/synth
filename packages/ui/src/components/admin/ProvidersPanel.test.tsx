import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getProviders: vi.fn(async () => ({ providers: [] })),
    fetchProviderIcon: vi.fn(),
    createProvider: vi.fn(async () => ({})),
    updateProvider: vi.fn(async () => ({})),
    deleteProvider: vi.fn(async () => undefined),
    testProvider: vi.fn(async () => ({ status: 'ok' })),
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProvidersPanel } from './ProvidersPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: { host: HTMLElement; root: Root }[] = []

async function renderPanel(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ProvidersPanel />
      </TooltipProvider>,
    )
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

describe('ProvidersPanel: провайдер не помечается как «по умолчанию»', () => {
  it('is_default из ответа API не рендерит бейдж', async () => {
    vi.mocked(synthApi.getProviders).mockResolvedValueOnce({
      providers: [
        {
          name: 'itphx',
          type: 'openai',
          icon: '',
          url: 'https://api.example.com/v1',
          model: 'model',
          enabled: true,
          is_default: true,
        },
      ],
      default_provider: 'itphx',
    })
    const host = await renderPanel()

    expect(host.textContent).toContain('itphx')
    expect(host.textContent).not.toContain('admin.providers.default_2')
    expect(host.textContent).not.toContain('по умолчанию')
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
    vi.mocked(synthApi.fetchProviderIcon).mockResolvedValueOnce({
      icon: bigIcon,
      source: 'https://api.example.com/favicon.ico',
    })

    const host = await renderPanel()
    await act(async () => {
      findButton(host, 'admin.providers.add').click()
    })

    const urlInput = host.querySelector('input[placeholder="https://api.example.com/v1"]') as HTMLInputElement
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

    expect(synthApi.fetchProviderIcon).toHaveBeenCalledWith('https://api.example.com/v1')
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
    const call = vi.mocked(synthApi.createProvider).mock.calls.at(-1)
    expect(call).toBeTruthy()
    return (call![0] as { currency?: unknown }).currency
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

describe('ProvidersPanel: модель по умолчанию провайдера', () => {
  it('подпись и подсказка объясняют смысл fallback-модели', async () => {
    const host = await renderPanel()
    await act(async () => {
      findButton(host, 'admin.providers.add').click()
    })

    // i18n в этом тесте замокан: тексты — это ключи словаря.
    const label = Array.from(host.querySelectorAll('label')).find(
      (l) => (l.textContent ?? '').trim() === 'admin.providers.defaultModel',
    )
    expect(label).toBeTruthy()

    const tooltips = Array.from(host.querySelectorAll('[data-testid="settings-field-tooltip"]'))
    expect(tooltips.some((el) => el.getAttribute('aria-label') === 'admin.providers.defaultModelHint')).toBe(true)
  })
})

describe('ProvidersPanel: расширенные параметры (совместимость)', () => {
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

  async function openAdd(host: HTMLElement) {
    await act(async () => {
      findButton(host, 'admin.providers.add').click()
    })
  }

  async function openEdit(host: HTMLElement) {
    await act(async () => {
      findButtonByLabel(host, 'admin.providers.edit').click()
    })
  }

  async function toggleCompatibility(host: HTMLElement) {
    await act(async () => {
      (host.querySelector('[data-testid="compatibility-toggle"]') as HTMLElement).click()
    })
  }

  /** Выбрать пункт в select по data-testid триггера и подстроке текста пункта. */
  async function pickOption(host: HTMLElement, triggerTestId: string, optionText: string) {
    const trigger = host.querySelector(`[data-testid="${triggerTestId}"]`) as HTMLElement | null
    expect(trigger).toBeTruthy()
    await act(async () => {
      trigger!.click()
    })
    const option = [...document.body.querySelectorAll('[role="option"]')].find((o) =>
      (o.textContent ?? '').includes(optionText),
    ) as HTMLElement | undefined
    expect(option).toBeTruthy()
    await act(async () => {
      option!.click()
    })
    await act(async () => {})
  }

  async function save(host: HTMLElement) {
    const saveButton = host.querySelector('[data-testid="provider-save"]') as HTMLButtonElement | null
    expect(saveButton).toBeTruthy()
    await act(async () => {
      saveButton!.click()
    })
    await act(async () => {})
  }

  function savedBody(): Record<string, unknown> {
    const call = vi.mocked(synthApi.createProvider).mock.calls.at(-1)
    expect(call).toBeTruthy()
    return call![0] as Record<string, unknown>
  }

  it('у новой сущности блок свёрнут, у сохранённой совместимости — раскрыт', async () => {
    mockProviders([{ ...baseProvider, compatibility: { reasoningField: 'reasoning' } }])
    const host = await renderPanel()

    await openAdd(host)
    expect(host.querySelector('[data-testid="compatibility-panel"]')).toBeNull()
    expect(host.textContent).toContain('admin.compatibility.title')

    await act(async () => {
      findButton(host, 'admin.providers.cancel').click()
    })
    await openEdit(host)
    // Сохранённые параметры видны сразу — не нужно искать по свёрнутому блоку.
    expect(host.querySelector('[data-testid="compatibility-panel"]')).toBeTruthy()
    const reasoningTrigger = host.querySelector('[data-testid="compatibility-reasoning-field"]')
    expect(reasoningTrigger!.textContent).toContain('reasoning')
  })

  it('сохранённые значения раскрываются в контролах и уходят обратно без изменений', async () => {
    mockProviders([{
      ...baseProvider,
      compatibility: { reasoningField: 'reasoning', requireReasoning: false },
    }])
    const host = await renderPanel()
    await openEdit(host)

    expect(
      host.querySelector('[data-testid="compatibility-require-reasoning"]')!.textContent,
    ).toContain('admin.compatibility.no')

    await save(host)
    expect(savedBody().compatibility).toEqual({ reasoningField: 'reasoning', requireReasoning: false })
  })

  it('tri-state: «Нет» уходит явным false, «Авто» — поле отсутствует', async () => {
    mockProviders([])
    const host = await renderPanel()
    await openAdd(host)
    await setInputValue(
      host.querySelector('input[placeholder="https://api.example.com/v1"]') as HTMLInputElement,
      'https://api.example.com/v1',
    )
    const nameLabel = Array.from(host.querySelectorAll('label')).find(
      (l) => (l.textContent ?? '').trim() === 'admin.providers.name',
    )!
    await setInputValue(nameLabel.parentElement!.querySelector('input') as HTMLInputElement, 'new-provider')

    await toggleCompatibility(host)
    await pickOption(host, 'compatibility-require-reasoning', 'admin.compatibility.no')
    await save(host)

    expect(savedBody().compatibility).toEqual({ requireReasoning: false })
  })

  it('всё «авто» у новой сущности → поле compatibility не отправляется', async () => {
    mockProviders([])
    const host = await renderPanel()
    await openAdd(host)
    const nameLabel = Array.from(host.querySelectorAll('label')).find(
      (l) => (l.textContent ?? '').trim() === 'admin.providers.name',
    )!
    await setInputValue(nameLabel.parentElement!.querySelector('input') as HTMLInputElement, 'new-provider')
    await save(host)

    expect('compatibility' in savedBody()).toBe(false)
  })

  it('очистка всех полей у существующей сущности отправляет compatibility: null', async () => {
    mockProviders([{ ...baseProvider, compatibility: { requireReasoning: true } }])
    const host = await renderPanel()
    await openEdit(host)

    await pickOption(host, 'compatibility-require-reasoning', 'admin.compatibility.auto')
    await save(host)

    expect('compatibility' in savedBody()).toBe(true)
    expect(savedBody().compatibility).toBeNull()
  })

  it('произвольное имя поля рассуждений сохраняется через «своё значение»', async () => {
    mockProviders([{ ...baseProvider, compatibility: { reasoningField: 'reasoning_details' } }])
    const host = await renderPanel()
    await openEdit(host)

    // «Своё значение» выбрано автоматически, input заполнен сохранённым именем.
    const custom = host.querySelector('[data-testid="compatibility-reasoning-custom"]') as HTMLInputElement | null
    expect(custom).toBeTruthy()
    expect(custom!.value).toBe('reasoning_details')

    await save(host)
    expect(savedBody().compatibility).toEqual({ reasoningField: 'reasoning_details' })
  })

  it('контролы нативных видео/аудио есть в блоке расширенных параметров', async () => {
    mockProviders([baseProvider])
    const host = await renderPanel()
    await openEdit(host)
    await toggleCompatibility(host)

    expect(host.querySelector('[data-testid="compatibility-supports-native-video"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="compatibility-native-audio-formats"]')).toBeTruthy()
    // Мульти-селект форматов — только в режиме «задать список».
    expect(host.querySelector('[data-testid="compatibility-native-audio-format-wav"]')).toBeNull()
  })

  it('явный «Нет» по нативному видео уходит false, а не схлопывается в «авто»', async () => {
    mockProviders([baseProvider])
    const host = await renderPanel()
    await openEdit(host)
    await toggleCompatibility(host)

    await pickOption(host, 'compatibility-supports-native-video', 'admin.compatibility.no')
    await save(host)

    expect(savedBody().compatibility).toEqual({ supportsNativeVideo: false })
  })

  it('явный список нативных форматов аудио уходит массивом', async () => {
    mockProviders([baseProvider])
    const host = await renderPanel()
    await openEdit(host)
    await toggleCompatibility(host)

    await pickOption(host, 'compatibility-native-audio-formats', 'admin.compatibility.nativeAudioCustom')
    const chip = host.querySelector('[data-testid="compatibility-native-audio-format-wav"]') as HTMLElement
    expect(chip).toBeTruthy()
    await act(async () => {
      chip.click()
    })
    await save(host)

    expect(savedBody().compatibility).toEqual({ nativeAudioFormats: ['wav'] })
  })

  it('«не принимает нативно» уходит пустым списком, а не «авто»', async () => {
    mockProviders([baseProvider])
    const host = await renderPanel()
    await openEdit(host)
    await toggleCompatibility(host)

    await pickOption(host, 'compatibility-native-audio-formats', 'admin.compatibility.nativeAudioNone')
    await save(host)

    expect(savedBody().compatibility).toEqual({ nativeAudioFormats: [] })
  })

  it('сохранённые нативные параметры раскрываются в контролах', async () => {
    mockProviders([{
      ...baseProvider,
      compatibility: { supportsNativeVideo: false, nativeAudioFormats: ['wav'] },
    }])
    const host = await renderPanel()
    await openEdit(host)

    expect(
      host.querySelector('[data-testid="compatibility-supports-native-video"]')!.textContent,
    ).toContain('admin.compatibility.no')
    // Непустой список — режим «задать список»: чип формата уже нажат.
    const chip = host.querySelector('[data-testid="compatibility-native-audio-format-wav"]') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.getAttribute('aria-pressed')).toBe('true')

    await save(host)
    expect(savedBody().compatibility).toEqual({
      supportsNativeVideo: false,
      nativeAudioFormats: ['wav'],
    })
  })
})
