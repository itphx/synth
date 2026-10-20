import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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

import React from 'react'

const apiMock = vi.hoisted(() => ({
  getModels: vi.fn(),
  getDefaultModel: vi.fn(async (): Promise<{
    defaultModel: { provider: string; model: string } | null
    isOverridden: boolean
    defaults: { provider: string; model: string } | null
  }> => ({ defaultModel: null, isOverridden: false, defaults: null })),
  setDefaultModel: vi.fn(async (pair: { provider: string; model: string }) => ({ defaultModel: pair })),
  resetDefaultModel: vi.fn(async () => ({ status: 'restored', defaultModel: null, isOverridden: false, defaults: null })),
  fetchModels: vi.fn(async () => ({ fetched: 0, new: 0, enriched: 0 })),
  saveModel: vi.fn(async () => ({})),
  deleteModel: vi.fn(async () => undefined),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useProvidersStore } from '@/stores/providersStore'
import { ModelsPanel } from './ModelsPanel'

// Radix Popover внутри использует floating-ui/ResizeObserver — в jsdom его нет.
if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

// jsdom не считает layout (offsetHeight/offsetWidth = 0), а виртуализатор
// измеряет именно их; getBoundingClientRect мокаем тем же значением для
// позиционирования/совместимости. Высота скролл-контейнера ~560 → в окне
// рендерится первая порция строк, а не весь список.
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

// Скролл-контейнер списка моделей — тело панели настроек (ADR-072: один
// вертикальный скролл, у таблицы своего скролла нет). Виртуализатор меряет
// именно его, поэтому телу панели в mock достаётся высота окна (560).
const isScroller = (el: Element) => (el as HTMLElement).classList?.contains('settings-scroll-container')
const mockWidth = (el: Element) => (isScroller(el) ? 800 : 600)
const mockHeight = (el: Element) => (isScroller(el) ? 560 : 33)

function mockLayout() {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const width = mockWidth(this)
    const height = mockHeight(this)
    return {
      x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height,
      toJSON: () => ({}),
    } as unknown as DOMRect
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) { return mockHeight(this) },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) { return mockWidth(this) },
  })
}

function restoreLayout() {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
  if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
}

async function renderPanel(opts: { showAdvanced?: boolean } = {}): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({
    settingsShowAdvanced: opts.showAdvanced ?? true,
    settingsFocus: null,
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ModelsPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mockLayout()
  // Кэш стора обнуляем: панель показывает его сразу (cache-first) и иначе
  // протекал бы между тестами.
  useProvidersStore.setState({
    providers: [],
    modelGroups: [],
    models: [],
    selectedProviderName: null,
    selectedModelName: null,
  })
  apiMock.getModels.mockResolvedValue([
    {
      provider: { name: 'itphx', type: 'openai', icon: '', defaultModel: '', currency: 'USD' },
      models: [
        {
          id: 'itphx/m1',
          name: 'm1',
          provider: 'itphx',
          enabled: true,
          isDefault: false,
          input_price: 3.28,
          output_price: 1.5,
          cache_read_price: 0.1,
          cache_write_price: 0.2,
          currency: 'USD',
        },
      ],
    },
  ])
})

afterEach(async () => {
  restoreLayout()
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

describe('ModelsPanel: валюта цен и инлайн-инпуты', () => {
  it('value числовых инпутов цен — сырое число без символа валюты (регрессия warning)', async () => {
    const container = await renderPanel()
    const inputs = (['in', 'out', 'cr', 'cw'] as const).map(
      (placeholder) => container.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement,
    )
    expect(inputs.every(Boolean)).toBe(true)
    expect(inputs.map((i) => i.value)).toEqual(['3.28', '1.5', '0.1', '0.2'])
    for (const input of inputs) {
      expect(input.value).not.toContain('$')
      expect(input.value).not.toContain('₽')
      expect(input.value).not.toContain('¥')
    }
  })

  it('кнопка валюты открывает поповер и сохраняет выбранную валюту через POST /models', async () => {
    const container = await renderPanel()
    const trigger = container.querySelector('button[aria-label="Price currency"]') as HTMLButtonElement
    expect(trigger).toBeTruthy()

    await act(async () => {
      trigger.click()
    })
    const rubOption = [...document.body.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Ruble'),
    ) as HTMLButtonElement | undefined
    expect(rubOption).toBeTruthy()

    await act(async () => {
      rubOption!.click()
    })
    await act(async () => {})

    expect(apiMock.saveModel).toHaveBeenCalledWith({
      id: 'itphx/m1',
      currency: 'RUB',
    })
  })

  it('символ валюты кнопки наследуется от провайдера, если у модели не задан', async () => {
    apiMock.getModels.mockResolvedValue([
      {
        provider: { name: 'itphx', type: 'openai', icon: '', defaultModel: '', currency: 'RUB' },
        models: [
          { id: 'itphx/m1', name: 'm1', provider: 'itphx', enabled: true, isDefault: false },
        ],
      },
    ])
    const container = await renderPanel()
    const trigger = container.querySelector('button[aria-label="Price currency"]') as HTMLButtonElement
    expect(trigger.textContent).toContain('₽')
  })

  it('очистка поля цены отправляет null (сброс), а не пропускает поле', async () => {
    const container = await renderPanel()
    const input = container.querySelector('input[placeholder="in"]') as HTMLInputElement
    expect(input.value).toBe('3.28')

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // updatePriceField сохраняет с debounce 500 мс.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650))
    })

    expect(apiMock.saveModel).toHaveBeenCalledWith({
      id: 'itphx/m1',
      input_price: null,
    })
  })
})

describe('ModelsPanel: виртуализация списка и сворачивание крупных групп', () => {
  it('группа >50 моделей стартует свёрнутой, после раскрытия рендерится виртуальное окно', async () => {
    const models = Array.from({ length: 60 }, (_, i) => ({
      id: `big/m${i}`,
      name: `big-model-${i}`,
      provider: 'big',
      enabled: true,
      isDefault: false,
    }))
    apiMock.getModels.mockResolvedValue([
      { provider: { name: 'big', type: 'openai', icon: '', defaultModel: '' }, models },
    ])

    const container = await renderPanel()
    // Свёрнутая группа: строк моделей в DOM нет.
    expect(container.textContent).not.toContain('big-model-0')

    const toggle = container.querySelector('button[aria-label="big"]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    await act(async () => {
      toggle.click()
    })

    // Рендерится первая порция виртуального окна, а не все 60 строк.
    expect(container.textContent).toContain('big-model-0')
    const rowCount = container.querySelectorAll('input[placeholder="in"]').length
    expect(rowCount).toBeGreaterThan(0)
    expect(rowCount).toBeLessThan(60)
    expect(container.textContent).not.toContain('big-model-59')
    // Порционной кнопки «Показать ещё» больше нет.
    expect(container.querySelector('[data-testid="models-show-more-big"]')).toBeNull()
    // Полный список живёт в скролле: виртуальный слой выше окна > 1000px.
    const virtualList = container.querySelector('[data-testid="models-virtual-list"]') as HTMLDivElement
    expect(virtualList).toBeTruthy()
    expect(parseFloat(virtualList.style.height)).toBeGreaterThan(1000)
  })

  it('небольшая группа остаётся раскрытой', async () => {
    const container = await renderPanel()
    expect(container.querySelector('input[placeholder="in"]')).toBeTruthy()
  })

  it('крупная группа из кэша стора свёрнута уже в первом коммите (без эффекта)', async () => {
    const bigModels = Array.from({ length: 120 }, (_, i) => ({
      id: `cached/m${i}`,
      name: `cached-model-${i}`,
      provider: 'cached',
      enabled: true,
      isDefault: false,
    }))
    useProvidersStore.setState({
      modelGroups: [
        { provider: { name: 'cached', type: 'openai', icon: '', defaultModel: '' }, models: bigModels },
      ],
    })
    // Загрузка не завершается: проверяем именно первый коммит из кэша стора.
    apiMock.getModels.mockReturnValue(new Promise(() => {}))

    useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
    useUIStore.setState({ settingsShowAdvanced: true, settingsFocus: null })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, container })

    // Layout-эффект соседа выполняется после мутаций DOM первого коммита,
    // но до пассивных эффектов панели — видно, что реально попало на кадр.
    const rowCounts: number[] = []
    const Probe = () => {
      useLayoutEffect(() => {
        rowCounts.push(container.querySelectorAll('input[placeholder="in"]').length)
      })
      return null
    }

    await act(async () => {
      root.render(
        <I18nProvider>
          <ModelsPanel />
          <Probe />
        </I18nProvider>,
      )
    })

    expect(rowCounts[0]).toBe(0)
    // Заголовок группы при этом на месте — группа скрыта, а не потеряна.
    expect(container.textContent).toContain('cached')
  })
})

describe('ModelsPanel: модель по умолчанию', () => {
  it('показывает пару и активную кнопку сброса только при override', async () => {
    apiMock.getDefaultModel.mockResolvedValueOnce({
      defaultModel: { provider: 'itphx', model: 'm1' },
      isOverridden: true,
      defaults: null,
    })
    const container = await renderPanel()

    const providerTrigger = container.querySelector('[data-testid="default-model-provider"]')
    const modelTrigger = container.querySelector('[data-testid="default-model-model"]')
    expect(providerTrigger).toBeTruthy()
    expect(modelTrigger).toBeTruthy()
    expect(providerTrigger!.textContent).toContain('itphx')
    expect(modelTrigger!.textContent).toContain('m1')

    const reset = container.querySelector('[data-testid="default-model-reset"]') as HTMLButtonElement
    expect(reset).toBeTruthy()
    expect(reset.disabled).toBe(false)
  })

  it('сброс пары вызывает DELETE /settings/default-model', async () => {
    apiMock.getDefaultModel.mockResolvedValueOnce({
      defaultModel: { provider: 'itphx', model: 'm1' },
      isOverridden: true,
      defaults: null,
    })
    const container = await renderPanel()
    const reset = container.querySelector('[data-testid="default-model-reset"]') as HTMLButtonElement
    await act(async () => {
      reset.click()
    })
    await act(async () => {})
    expect(apiMock.resetDefaultModel).toHaveBeenCalled()
  })

  it('пушпин строки ставит пару через setDefaultModel', async () => {
    const container = await renderPanel()
    const pin = container.querySelector('button[aria-label="Make default model"]') as HTMLButtonElement
    expect(pin).toBeTruthy()
    await act(async () => {
      pin.click()
    })
    await act(async () => {})
    expect(apiMock.setDefaultModel).toHaveBeenCalledWith({ provider: 'itphx', model: 'm1' })
  })

  it('у выключенной модели пушпин disabled и не назначает её по умолчанию', async () => {
    apiMock.getModels.mockResolvedValue([
      {
        provider: { name: 'itphx', type: 'openai', icon: '', defaultModel: '', currency: 'USD' },
        models: [
          { id: 'itphx/off', name: 'off', provider: 'itphx', enabled: false, isDefault: false },
        ],
      },
    ])
    const container = await renderPanel()

    const pin = container.querySelector(
      'button[aria-label="Enable the model before making it the default"]',
    ) as HTMLButtonElement | null
    expect(pin).toBeTruthy()
    expect(pin!.disabled).toBe(true)

    await act(async () => {
      pin!.click()
    })
    await act(async () => {})
    expect(apiMock.setDefaultModel).not.toHaveBeenCalled()
  })
})

describe('ModelsPanel: базовые элементы (поиск, добавление) и один скролл', () => {
  it('поиск и «Добавить модель» видны без раскрытия дополнительных настроек', async () => {
    const container = await renderPanel({ showAdvanced: false })

    expect(container.querySelector('#models-search')).toBeTruthy()
    expect(container.querySelector('[data-testid="models-add-button"]')).toBeTruthy()
    // Дополнительные фильтры — под тумблером.
    expect(container.querySelector('[data-settings-section="models-filters-advanced"]')).toBeNull()
  })

  it('кнопка раскрытия дополнительных настроек — в шапке панели, до таблицы', async () => {
    const container = await renderPanel({ showAdvanced: false })

    const reveal = container.querySelector(
      '[data-testid="settings-advanced-reveal"]',
    ) as HTMLButtonElement
    expect(reveal).toBeTruthy()
    const header = container.querySelector('header') as HTMLElement
    expect(header.contains(reveal)).toBe(true)

    const table = container.querySelector('[data-testid="models-scroll"]') as HTMLElement
    expect(
      reveal.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('раскрытие дополнительных настроек открывает фильтры списка', async () => {
    const container = await renderPanel({ showAdvanced: false })
    const reveal = container.querySelector(
      '[data-testid="settings-advanced-reveal"]',
    ) as HTMLButtonElement

    await act(async () => {
      reveal.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('[data-settings-section="models-filters-advanced"]')).toBeTruthy()
  })

  it('таблица — последний элемент тела панели и не создаёт второго скролла', async () => {
    const container = await renderPanel()

    const table = container.querySelector('[data-testid="models-scroll"]') as HTMLElement
    expect(table).toBeTruthy()
    // У таблицы нет собственного скролл-контейнера (ADR-072: скроллится тело).
    expect(table.className).not.toContain('overflow-auto')
    expect(table.className).not.toContain('overflow-y-')
    expect(table.className).not.toContain('max-h-')

    const body = container.querySelector('.settings-scroll-container') as HTMLElement
    const content = body.firstElementChild as HTMLElement
    expect(content.lastElementChild).toBe(table)
  })

  it('таблица виртуализируется: в DOM только окно строк, а не весь список', async () => {
    const models = Array.from({ length: 200 }, (_, i) => ({
      id: `virt/m${i}`,
      name: `virt-model-${i}`,
      provider: 'virt',
      enabled: true,
      isDefault: false,
    }))
    apiMock.getModels.mockResolvedValue([
      { provider: { name: 'virt', type: 'openai', icon: '', defaultModel: '' }, models },
    ])

    const container = await renderPanel()
    // Крупная группа свёрнута — раскрываем её.
    const toggle = container.querySelector('button[aria-label="virt"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })

    const rowCount = container.querySelectorAll('input[placeholder="in"]').length
    expect(rowCount).toBeGreaterThan(0)
    expect(rowCount).toBeLessThan(200)
  })
})

describe('ModelsPanel: телефон — карточка вместо таблицы', () => {
  const originalMatchMedia = window.matchMedia

  /** Эмулируем зону «телефон» (≤768px) для `useDevice`/`useMediaQuery`. */
  const mockPhoneViewport = () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width: 768px'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('строка перестраивается в карточку: все поля и все действия доступны', async () => {
    mockPhoneViewport()
    const container = await renderPanel()

    // Фиксированной ширины таблицы на телефоне нет — карточка тянется по месту.
    const table = container.querySelector('[data-testid="models-scroll"]') as HTMLElement
    const tableBody = table.firstElementChild as HTMLElement
    expect(tableBody.className).not.toContain('min-w-[35rem]')

    // Строка — карточка (колонка), а не строка таблицы.
    const card = [...container.querySelectorAll('[data-testid="models-virtual-list"] [data-index] > div')]
      .find((el) => el.querySelector('input[placeholder="in"]')) as HTMLElement
    expect(card).toBeTruthy()
    expect(card.className).toContain('flex-col')

    // Контекст и все четыре цены — на месте.
    expect(container.querySelector('input[type="number"]')).toBeTruthy()
    for (const placeholder of ['in', 'out', 'cr', 'cw']) {
      expect(container.querySelector(`input[placeholder="${placeholder}"]`)).toBeTruthy()
    }
    // Подписи полей (смысл цены без тултипа) и тумблер включения.
    expect(container.textContent).toContain('Context')
    expect(container.textContent).toContain('Prices /1M')
    expect(container.textContent).toContain('ON')
    // Действия строки: «по умолчанию» (пушпин) и удаление.
    expect(container.querySelector('button[aria-label="Make default model"]')).toBeTruthy()
    const del = container.querySelector('button[aria-label="Delete model"]') as HTMLElement
    expect(del).toBeTruthy()
    // Touch-таргет ≥40px (ADR-044, --control-height-touch).
    expect(del.className).toContain('control-height-touch')
  })

  it('на телефоне шапка — компактная легенда, горизонтального скролла нет', async () => {
    mockPhoneViewport()
    const container = await renderPanel()

    const table = container.querySelector('[data-testid="models-scroll"]') as HTMLElement
    // У таблицы и её содержимого нет ни собственного скролла, ни overflow.
    expect(table.className).not.toContain('overflow')
    expect(table.firstElementChild!.className).not.toContain('overflow')
    // Шапка колонок остаётся sticky и перечисляет поля карточки.
    const header = table.querySelector('div.sticky') as HTMLElement
    expect(header).toBeTruthy()
    expect(header.className).toContain('sticky')
    expect(header.textContent).toContain('Model')
    expect(header.textContent).toContain('Context')
    expect(header.textContent).toContain('Prices /1M')
  })

  it('на десктопе раскладка не меняется: та же таблица с фиксированной шириной', async () => {
    const container = await renderPanel()

    const table = container.querySelector('[data-testid="models-scroll"]') as HTMLElement
    const tableBody = table.firstElementChild as HTMLElement
    expect(tableBody.className).toContain('min-w-[35rem]')

    // Строка — обычная строка таблицы (не карточка).
    const row = [...container.querySelectorAll('[data-testid="models-virtual-list"] [data-index] > div')]
      .find((el) => el.querySelector('input[placeholder="in"]')) as HTMLElement
    expect(row).toBeTruthy()
    expect(row.className).toContain('flex')
    expect(row.className).not.toContain('flex-col')
    // Шапка — прежние шесть колонок.
    const header = table.querySelector('div.sticky') as HTMLElement
    expect(header.className).toContain('px-4')
    expect(header.querySelectorAll('span').length).toBe(6)
  })
})

describe('ModelsPanel: глобальный поиск по названию', () => {
  /** Установить значение управляемого input так, как это делает пользователь. */
  const typeInto = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {})
  }

  beforeEach(() => {
    apiMock.getModels.mockResolvedValue([
      {
        provider: { name: 'alpha', type: 'openai', icon: '', defaultModel: '', currency: 'USD' },
        models: [
          { id: 'alpha/qwen', name: 'qwen-2.5', provider: 'alpha', enabled: true, isDefault: false },
          { id: 'alpha/llama', name: 'llama-3', provider: 'alpha', enabled: true, isDefault: false },
        ],
      },
      {
        provider: { name: 'beta', type: 'openai', icon: '', defaultModel: '', currency: 'USD' },
        models: [
          { id: 'beta/qwen-coder', name: 'qwen-coder', provider: 'beta', enabled: true, isDefault: false },
          { id: 'beta/mistral', name: 'mistral', provider: 'beta', enabled: true, isDefault: false },
        ],
      },
    ])
  })

  it('фильтрует по подстроке, раскрывает группы и показывает «shown из total»', async () => {
    const container = await renderPanel()
    expect(container.textContent).toContain('qwen-2.5')
    expect(container.textContent).toContain('llama-3')
    expect(container.textContent).toContain('mistral')

    const search = container.querySelector('#models-search') as HTMLInputElement
    expect(search).toBeTruthy()
    await typeInto(search, 'QWEN')

    // Обе группы имеют совпадения — обе видны, несовпавшие модели скрыты.
    expect(container.textContent).toContain('qwen-2.5')
    expect(container.textContent).toContain('qwen-coder')
    expect(container.textContent).not.toContain('llama-3')
    expect(container.textContent).not.toContain('mistral')
    // Счётчик в заголовке — «совпало из всего».
    expect(container.textContent).toContain('1 of 2')

    // Очистка поиска возвращает полный список.
    await typeInto(search, '')
    expect(container.textContent).toContain('llama-3')
    expect(container.textContent).toContain('mistral')
  })

  it('пустой результат поиска показывает сообщение с запросом', async () => {
    const container = await renderPanel()
    const search = container.querySelector('#models-search') as HTMLInputElement
    await typeInto(search, 'zzz')

    expect(container.textContent).toContain('No models match “zzz”')
    expect(container.querySelector('[data-testid="models-scroll"]')).toBeNull()
  })
})
