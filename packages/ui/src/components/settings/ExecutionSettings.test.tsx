import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore/useAuthStore пишет в localStorage — в Node/vitest его нет.
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
  getExecutionProfiles: vi.fn(),
  getExecutionPools: vi.fn(),
  drainExecutionPool: vi.fn(),
  releaseExecutionPool: vi.fn(),
  warmExecutionImages: vi.fn(),
  getExecutionSettings: vi.fn(),
  saveExecutionSettings: vi.fn(),
  resetExecutionSettings: vi.fn(),
  restartInstance: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useAuthStore } from '@/stores/authStore'
import { ExecutionSettings } from './ExecutionSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom не реализует scrollIntoView, а раздел прокручивает форму после открытия.
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {}
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROFILES_HTTP = {
  provider: 'http' as const,
  pooling: 'project' as const,
  defaultProfile: 'default',
  profiles: ['default', 'browser', 'legacy', 'light', 'browser-alt'],
  browserProfiles: ['browser'],
  browserDefaultProfile: 'browser-alt',
  details: [
    {
      name: 'default',
      description: 'Базовый исполнитель',
      image: 'registry.example/synth-executor:latest',
      network: 'restricted' as const,
      resources: { limits: { cpu: '2', memory: '4Gi' } },
      runtimeClass: 'gvisor',
      class: 'exec' as const,
      mcpServers: [{ name: 'playwright' }],
    },
    { name: 'browser', image: 'registry.example/synth-browser:latest', class: 'browser' as const },
    { name: 'legacy', image: 'registry.example/synth-executor:legacy', class: 'exec' as const },
    { name: 'light', image: 'registry.example/synth-executor:light', class: 'exec' as const },
    { name: 'browser-alt', image: 'registry.example/synth-browser:alt', class: 'browser' as const },
  ],
  profileOrigins: {
    default: 'config' as const,
    browser: 'config' as const,
    legacy: 'config' as const,
    light: 'runtime' as const,
    'browser-alt': 'runtime' as const,
  },
}

const CONFIG_PROFILE = {
  description: 'Базовый исполнитель',
  image: 'registry.example/synth-executor:latest',
  network: 'restricted' as const,
  resources: { limits: { cpu: '2', memory: '4Gi' } },
  runtimeClass: 'gvisor',
  class: 'exec' as const,
  mcpServers: [{ name: 'playwright' }],
}

/** Runtime-каталог (ADR-135): `GET /settings/execution`. */
const SETTINGS_DTO = {
  saved: {
    browserProfile: 'browser-alt',
    profiles: {
      light: { image: 'registry.example/synth-executor:light', class: 'exec' as const },
      'browser-alt': { image: 'registry.example/synth-browser:alt', class: 'browser' as const },
    },
    disabledProfiles: [],
  },
  running: {
    defaultProfile: 'default',
    browserProfile: 'browser-alt',
    profiles: {
      default: CONFIG_PROFILE,
      browser: { image: 'registry.example/synth-browser:latest', class: 'browser' as const },
      legacy: { image: 'registry.example/synth-executor:legacy', class: 'exec' as const },
      light: { image: 'registry.example/synth-executor:light', class: 'exec' as const },
      'browser-alt': { image: 'registry.example/synth-browser:alt', class: 'browser' as const },
    },
  },
  restartRequired: false,
  effective: {
    defaultProfile: 'default',
    browserProfile: 'browser-alt',
    profiles: {
      default: CONFIG_PROFILE,
      browser: { image: 'registry.example/synth-browser:latest', class: 'browser' as const },
      legacy: { image: 'registry.example/synth-executor:legacy', class: 'exec' as const },
      light: { image: 'registry.example/synth-executor:light', class: 'exec' as const },
      'browser-alt': { image: 'registry.example/synth-browser:alt', class: 'browser' as const },
    },
  },
  defaults: {
    defaultProfile: 'default',
    browserProfile: 'browser',
    profiles: {
      default: CONFIG_PROFILE,
      browser: { image: 'registry.example/synth-browser:latest', class: 'browser' as const },
      legacy: { image: 'registry.example/synth-executor:legacy', class: 'exec' as const },
    },
  },
  profileOrigins: {
    default: 'config' as const,
    browser: 'config' as const,
    legacy: 'config' as const,
    light: 'runtime' as const,
    'browser-alt': 'runtime' as const,
  },
  isOverridden: true,
}

const POOLS_HTTP = {
  provider: 'http' as const,
  pools: [
    {
      key: 'project:p1:exec:devops',
      profile: 'devops',
      state: 'ready' as const,
      createdAt: '2026-11-12T10:00:00.000Z',
      lastUsedAt: '2026-11-12T10:05:00.000Z',
    },
    { key: 'instance:exec:default', profile: 'default', state: 'configured' as const },
  ],
}

async function render(roles: string[] = ['ADMIN']): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useAuthStore.setState({ user: { id: 'u1', username: 'alice', roles } as never })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ExecutionSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

const byTestId = (container: HTMLElement, id: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

/** Карточка профиля по имени (индексы в data-testid зависят от порядка каталога). */
function profileCard(container: HTMLElement, name: string): HTMLElement | null {
  const cards = [...container.querySelectorAll('[data-testid^="execution-catalog-profile-"]')] as HTMLElement[]
  return cards.find((card) => {
    const title = card.querySelector('.font-mono')?.textContent?.trim()
    return title === name
  }) ?? null
}


/** Ввод значения в поле (React-controllled: событие `input`). */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Ввод значения в textarea (React-controllled: событие `input`). */
function setTextAreaValue(area: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(area, value)
  area.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Переключатель класса профиля в форме. */
function toggleClass(container: HTMLElement, testId: string): void {
  const node = byTestId(container, testId)
  const button = node?.querySelector('button[role="switch"]') as HTMLButtonElement | null
  if (!button) throw new Error(`toggle not found: ${testId}`)
  button.click()
}

beforeEach(() => {
  mocks.getExecutionProfiles.mockResolvedValue(PROFILES_HTTP)
  mocks.getExecutionPools.mockResolvedValue(POOLS_HTTP)
  mocks.getExecutionSettings.mockResolvedValue(SETTINGS_DTO)
  mocks.saveExecutionSettings.mockResolvedValue(SETTINGS_DTO)
  mocks.resetExecutionSettings.mockResolvedValue(SETTINGS_DTO)
  mocks.restartInstance.mockResolvedValue({ status: 'restarting', restartId: 'rst_1' })
  mocks.warmExecutionImages.mockResolvedValue({ results: [] })
  mocks.drainExecutionPool.mockResolvedValue(undefined)
  mocks.releaseExecutionPool.mockResolvedValue(undefined)
  mocks.confirm.mockResolvedValue(true)
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

describe('ExecutionSettings — сводка и списки', () => {
  it('показывает провайдера, пулинг, профиль по умолчанию, профили и пулы', async () => {
    const container = await render()

    const summary = byTestId(container, 'execution-summary')!
    expect(summary.textContent).toContain('http (provisioner)')
    expect(summary.textContent).toContain('per project')
    expect(summary.textContent).toContain('default')

    expect(byTestId(container, 'execution-catalog')!.textContent).toContain('legacy')

    const pools = byTestId(container, 'execution-pools')!
    expect(pools.textContent).toContain('project:p1:exec:devops')
    expect(pools.textContent).toContain('devops')
    expect(pools.textContent).toContain('ready')
    expect(pools.textContent).toContain('instance:exec:default')
    // Метки времени — в локали UI (en-US → mm/dd/yyyy).
    expect(pools.textContent).toContain('11/12/2026')
  })

  it('карточка профиля каталога: описание, образ, сеть, ресурсы, runtime, MCP и метка default', async () => {
    const container = await render()

    const card = byTestId(container, 'execution-catalog-profile-0')!
    expect(card.textContent).toContain('default')
    expect(card.textContent).toContain('Базовый исполнитель')
    expect(card.textContent).toContain('registry.example/synth-executor:latest')
    // Сеть — локализованная подпись, не сырое значение.
    expect(card.textContent).toContain(enDict['settings.execution.network.restricted'])
    expect(card.textContent).toContain('cpu 2 · mem 4Gi')
    expect(card.textContent).toContain('gvisor')
    expect(card.textContent).toContain('playwright')
    expect(byTestId(container, 'execution-catalog-profile-0-default-badge')!.textContent).toBe(
      enDict['settings.execution.profile.defaultBadge'],
    )
  })

  it('пустой список пулов — честное пустое состояние', async () => {
    mocks.getExecutionPools.mockResolvedValue({ provider: 'http', pools: [] })

    const container = await render()

    expect(byTestId(container, 'execution-pools-empty')).not.toBeNull()
  })
})

describe('ExecutionSettings — бейджи профилей', () => {
  it('бейдж класса «Исполнитель» и происхождения «Из конфигурации»', async () => {
    const container = await render()

    const execBadge = byTestId(container, 'execution-catalog-profile-0-class-exec')!
    expect(execBadge.textContent).toBe(enDict['settings.execution.catalog.classExec'])
    expect(byTestId(container, 'execution-catalog-profile-0-class-browser')).toBeNull()
    expect(
      byTestId(container, 'execution-catalog-profile-0-config-badge')!.textContent,
    ).toBe(enDict['settings.execution.catalog.configBadge'])
  })

  it('бейдж класса «Браузер» у браузерного профиля', async () => {
    const container = await render()

    const browserBadge = byTestId(container, 'execution-catalog-profile-1-class-browser')!
    expect(browserBadge.textContent).toBe(enDict['settings.execution.catalog.classBrowser'])
    expect(byTestId(container, 'execution-catalog-profile-1-class-exec')).toBeNull()
    // Браузерный профиль — тоже из конфигурации.
    expect(byTestId(container, 'execution-catalog-profile-1-config-badge')).not.toBeNull()
  })

  it('runtime-профиль без бейджа «Из конфигурации»', async () => {
    const container = await render()

    // Порядок карточек: default, browser, legacy (config), light (runtime).
    expect(byTestId(container, 'execution-catalog-profile-3-config-badge')).toBeNull()
    expect(byTestId(container, 'execution-catalog-profile-3-class-exec')).not.toBeNull()
  })
})

describe('ExecutionSettings — форма выше списка', () => {
  it('форма рендерится выше карточек и скроллится к себе', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-create')!.click()
    })

    const editor = byTestId(container, 'execution-catalog-editor')!
    const list = byTestId(container, 'execution-catalog')!
    expect(editor).not.toBeNull()
    // Форма — предыдущий sibling блока со списком.
    expect(editor.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('форма правки открывается с данными профиля', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-profile-3-edit')!.click()
    })

    const editor = byTestId(container, 'execution-catalog-editor')!
    expect(editor).not.toBeNull()
    const description = byTestId(container, 'execution-catalog-description') as HTMLInputElement
    expect(description.value).toBe('')
    const image = byTestId(container, 'execution-catalog-image') as HTMLInputElement
    expect(image.value).toBe('registry.example/synth-executor:light')
    // Имя при правке не меняется — поля нет.
    expect(byTestId(container, 'execution-catalog-name')).toBeNull()
  })
})

describe('ExecutionSettings — config-профили read-only', () => {
  it('у config-профиля нет правки и удаления, есть «Включён» и «Дублировать»', async () => {
    const container = await render()

    const card = byTestId(container, 'execution-catalog-profile-0')!
    expect(card.querySelector('[data-testid="execution-catalog-profile-0-edit"]')).toBeNull()
    expect(card.querySelector('[data-testid="execution-catalog-profile-0-delete"]')).toBeNull()
    expect(
      card.querySelector('[data-testid="execution-catalog-profile-0-enabled"]'),
    ).not.toBeNull()
    expect(
      card.querySelector('[data-testid="execution-catalog-profile-0-duplicate"]'),
    ).not.toBeNull()
  })

  it('отключение config-профиля пишет его в disabledProfiles', async () => {
    const container = await render()

    // «legacy» — config-профиль, не дефолт: его можно отключить.
    const card = byTestId(container, 'execution-catalog-profile-2')!
    const toggle = card.querySelector(
      '[data-testid="execution-catalog-profile-2-enabled"] button[role="switch"]',
    ) as HTMLButtonElement | null
    expect(toggle).not.toBeNull()
    await act(async () => {
      toggle!.click()
    })

    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as {
      disabledProfiles: string[]
      profiles: Record<string, unknown>
    }
    expect(sent.disabledProfiles).toContain('legacy')
    // Runtime-профиль не потерян: PUT несёт только runtime-часть.
    expect(sent.profiles.light).toEqual({
      image: 'registry.example/synth-executor:light',
      class: 'exec',
    })
  })

  it('«Дублировать» создаёт runtime-копию с именем <name>-copy и открывает форму', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-profile-0-duplicate')!.click()
    })

    const name = byTestId(container, 'execution-catalog-name') as HTMLInputElement
    expect(name.value).toBe('default-copy')
    const image = byTestId(container, 'execution-catalog-image') as HTMLInputElement
    expect(image.value).toBe('registry.example/synth-executor:latest')
  })

  it('«Дублировать» у config-профиля не даёт правки исходной карточки', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-profile-0-duplicate')!.click()
    })

    // Форма открыта, но карточка config-профиля осталась read-only.
    expect(byTestId(container, 'execution-catalog-profile-0-edit')).toBeNull()
  })
})

describe('ExecutionSettings — runtime-профили', () => {
  it('правка runtime-профиля уходит в PUT как override', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-profile-3-edit')!.click()
    })
    const description = byTestId(container, 'execution-catalog-description') as HTMLInputElement
    await act(async () => {
      setInputValue(description, 'Лёгкий исполнитель')
      byTestId(container, 'execution-catalog-apply')!.click()
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as {
      profiles: Record<string, { description?: string }>
    }
    expect(sent.profiles.light?.description).toBe('Лёгкий исполнитель')
  })

  it('создание профиля: имя, класс и MCP-серверы', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-create')!.click()
    })
    const name = byTestId(container, 'execution-catalog-name') as HTMLInputElement
    const image = byTestId(container, 'execution-catalog-image') as HTMLInputElement
    await act(async () => {
      setInputValue(name, 'extra')
      setInputValue(image, 'registry.example/synth-executor:extra')
      toggleClass(container, 'execution-catalog-class-browser')
    })

    // Для класса «Браузер» предзаполнен playwright-mcp.
    const mcpName = byTestId(container, 'execution-catalog-mcp-0-name') as HTMLInputElement
    expect(mcpName.value).toBe('playwright-mcp')
    const mcpArgs = byTestId(container, 'execution-catalog-mcp-0-args') as HTMLTextAreaElement
    expect(mcpArgs.value).toContain('--headless')
    expect(mcpArgs.value).toContain('/opt/synth/browser/chrome')

    await act(async () => {
      byTestId(container, 'execution-catalog-apply')!.click()
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as {
      profiles: Record<string, { class?: string; mcpServers?: unknown[] }>
    }
    expect(sent.profiles.extra?.class).toBe('both')
    expect(sent.profiles.extra?.mcpServers).toEqual([
      {
        name: 'playwright-mcp',
        args: ['--headless', '--no-sandbox', '--executable-path', '/opt/synth/browser/chrome'],
      },
    ])
  })

  it('удаление runtime-профиля — с подтверждением; дефолтный удалить нельзя', async () => {
    const container = await render()

    const lightCard = profileCard(container, 'light')!
    await act(async () => {
      ;(lightCard.querySelector('[data-testid$="-delete"]') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(mocks.confirm).toHaveBeenCalled()
    expect(profileCard(container, 'light')).toBeNull()

    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })
    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as {
      profiles: Record<string, unknown>
    }
    expect(sent.profiles.light).toBeUndefined()
  })

  it('отказ в подтверждении удаления — профиль остаётся', async () => {
    mocks.confirm.mockResolvedValue(false)
    const container = await render()

    const lightCard = profileCard(container, 'light')!
    await act(async () => {
      ;(lightCard.querySelector('[data-testid$="-delete"]') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(profileCard(container, 'light')).not.toBeNull()
  })

  it('«По умолчанию» меняет дефолт в PUT', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-profile-3-set-default')!.click()
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as { defaultProfile?: string }
    expect(sent.defaultProfile).toBe('light')
  })

  it('браузерный дефолт доступен только профилям класса browser|both', async () => {
    const container = await render()

    // У exec-профиля кнопки браузерного дефолта нет.
    expect(byTestId(container, 'execution-catalog-profile-3-set-browser')).toBeNull()
    // У браузерного профиля — есть.
    expect(byTestId(container, 'execution-catalog-profile-1-set-browser')).not.toBeNull()
  })
})

describe('ExecutionSettings — форма профиля', () => {
  it('MCP-строки: добавление, имя/команда/аргументы и env', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-create')!.click()
    })
    expect(byTestId(container, 'execution-catalog-mcp-empty')).not.toBeNull()

    await act(async () => {
      byTestId(container, 'execution-catalog-mcp-add')!.click()
    })

    const name = byTestId(container, 'execution-catalog-mcp-0-name') as HTMLInputElement
    const command = byTestId(container, 'execution-catalog-mcp-0-command') as HTMLInputElement
    const args = byTestId(container, 'execution-catalog-mcp-0-args') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(name, 'playwright-mcp')
      setInputValue(command, 'npx')
      setTextAreaValue(args, '--headless\n--no-sandbox')
    })

    const profileName = byTestId(container, 'execution-catalog-name') as HTMLInputElement
    const image = byTestId(container, 'execution-catalog-image') as HTMLInputElement
    await act(async () => {
      setInputValue(profileName, 'with-mcp')
      setInputValue(image, 'registry.example/synth-executor:mcp')
      byTestId(container, 'execution-catalog-apply')!.click()
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as {
      profiles: Record<string, { mcpServers?: unknown[] }>
    }
    expect(sent.profiles['with-mcp']?.mcpServers).toEqual([
      { name: 'playwright-mcp', command: 'npx', args: ['--headless', '--no-sandbox'] },
    ])
  })

  it('дополнительные поля: runtimeClass, аннотации, метки, affinity, env, read-only ФС', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-create')!.click()
    })
    expect(byTestId(container, 'execution-catalog-advanced')).toBeNull()

    await act(async () => {
      byTestId(container, 'execution-catalog-advanced-toggle')!.click()
    })

    const runtimeClass = byTestId(container, 'execution-catalog-runtime-class') as HTMLInputElement
    const affinity = byTestId(container, 'execution-catalog-affinity') as HTMLTextAreaElement
    expect(byTestId(container, 'execution-catalog-annotations')).not.toBeNull()
    expect(byTestId(container, 'execution-catalog-labels')).not.toBeNull()
    expect(byTestId(container, 'execution-catalog-node-selector')).not.toBeNull()
    expect(byTestId(container, 'execution-catalog-tolerations')).not.toBeNull()
    expect(byTestId(container, 'execution-catalog-env')).not.toBeNull()
    expect(byTestId(container, 'execution-catalog-read-only-fs')).not.toBeNull()

    const profileName = byTestId(container, 'execution-catalog-name') as HTMLInputElement
    const image = byTestId(container, 'execution-catalog-image') as HTMLInputElement
    await act(async () => {
      setInputValue(profileName, 'advanced')
      setInputValue(image, 'registry.example/synth-executor:advanced')
      setInputValue(runtimeClass, 'gvisor')
      setTextAreaValue(affinity, '{"nodeAffinity": {}}')
    })
    await act(async () => {
      toggleClass(container, 'execution-catalog-read-only-fs')
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-apply')!.click()
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as {
      profiles: Record<string, Record<string, unknown>>
    }
    expect(sent.profiles.advanced?.runtimeClass).toBe('gvisor')
    expect(sent.profiles.advanced?.affinity).toEqual({ nodeAffinity: {} })
    expect(sent.profiles.advanced?.readOnlyRootFilesystem).toBe(true)
  })

  it('некорректный JSON в affinity — понятная ошибка, профиль не создан', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-create')!.click()
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-advanced-toggle')!.click()
    })
    const profileName = byTestId(container, 'execution-catalog-name') as HTMLInputElement
    const image = byTestId(container, 'execution-catalog-image') as HTMLInputElement
    const affinity = byTestId(container, 'execution-catalog-affinity') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(profileName, 'broken')
      setInputValue(image, 'registry.example/synth-executor:broken')
      setTextAreaValue(affinity, '{oops')
    })
    await act(async () => {
      byTestId(container, 'execution-catalog-apply')!.click()
    })

    expect(byTestId(container, 'execution-catalog-form-error')).not.toBeNull()
    expect(byTestId(container, 'execution-catalog-editor')).not.toBeNull()
  })
})

describe('ExecutionSettings — сохранение', () => {
  it('PUT без изменений не падает: merge-семантика (только runtime-часть)', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    expect(mocks.saveExecutionSettings).toHaveBeenCalled()
    const sent = mocks.saveExecutionSettings.mock.calls[0]![0] as Record<string, unknown>
    expect(sent.profiles).toEqual({
      light: { image: 'registry.example/synth-executor:light', class: 'exec' },
      'browser-alt': { image: 'registry.example/synth-browser:alt', class: 'browser' },
    })
    expect(sent.disabledProfiles).toEqual([])
    // Эффективный каталог целиком не отправляется.
    expect(Object.keys(sent)).not.toContain('effective')
  })

  it('после успешного PUT каталог перечитывается', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })

    expect(mocks.getExecutionSettings).toHaveBeenCalledTimes(2)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['settings.execution.catalog.saved'], type: 'success' }),
    )
  })

  it('ошибка 400 при сохранении — понятное сообщение', async () => {
    mocks.saveExecutionSettings.mockRejectedValue(
      Object.assign(new Error('execution.defaultProfile: профиль "x" отсутствует в каталоге профилей'), {
        status: 400,
        code: 'VALIDATION_ERROR',
      }),
    )
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-save')!.click()
    })
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', category: 'error' }),
    )
  })

  it('сброс каталога — DELETE с подтверждением', async () => {
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-catalog-reset')!.click()
    })
    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.resetExecutionSettings).toHaveBeenCalled()
  })
})

describe('ExecutionSettings — прогрев образов', () => {
  it('«Прогреть образы» открывает список образов и шлёт выбранные', async () => {
    mocks.warmExecutionImages.mockResolvedValue({
      results: [{ image: 'registry.example/synth-executor:latest', ok: true, nodes: 2 }],
    })
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-warm-open')!.click()
    })

    const panel = byTestId(container, 'execution-warm-panel')!
    expect(panel).not.toBeNull()
    const images = panel.querySelectorAll('input[type="checkbox"]')
    expect(images.length).toBeGreaterThan(1)

    // Снимаем выбор со второго образа — в запрос уходит только выбранный.
    const second = images[1] as HTMLInputElement
    await act(async () => {
      second.click()
    })
    await act(async () => {
      byTestId(container, 'execution-warm-submit')!.click()
    })

    expect(mocks.warmExecutionImages).toHaveBeenCalledTimes(1)
    const sentImages = mocks.warmExecutionImages.mock.calls[0]![0] as string[]
    expect(sentImages.length).toBe(images.length - 1)
    expect(sentImages).not.toContain('registry.example/synth-browser:latest')
  })

  it('результат прогрева показывается по образам', async () => {
    mocks.warmExecutionImages.mockResolvedValue({
      results: [
        { image: 'registry.example/synth-executor:latest', ok: true, nodes: 3 },
        { image: 'registry.example/synth-browser:latest', ok: false, nodes: 0, error: 'pull failed' },
      ],
    })
    const container = await render()

    await act(async () => {
      byTestId(container, 'execution-warm-open')!.click()
    })
    await act(async () => {
      const submit = byTestId(container, 'execution-warm-submit') as HTMLButtonElement | null
      if (submit) submit.click()
    })
    await act(async () => {})

    const results = byTestId(container, 'execution-warm-results')!
    if (!results) throw new Error('warm results not rendered')
    expect(results.textContent).toContain('registry.example/synth-executor:latest')
    expect(results.textContent).toContain('3')
    expect(results.textContent).toContain('pull failed')
  })
})

describe('ExecutionSettings — перезапуск и права', () => {
  it('restartRequired: баннер «Применится после перезапуска» + кнопка перезапуска', async () => {
    mocks.getExecutionSettings.mockResolvedValue({ ...SETTINGS_DTO, restartRequired: true })
    const container = await render()

    const banner = byTestId(container, 'execution-restart-banner')!
    expect(banner.textContent).toContain(enDict['settings.execution.restartRequired'])

    await act(async () => {
      byTestId(container, 'execution-restart')!.click()
    })
    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.restartInstance).toHaveBeenCalled()
  })

  it('static: действия недоступны с пояснением', async () => {
    mocks.getExecutionProfiles.mockResolvedValue({
      provider: 'static',
      pooling: 'instance',
      defaultProfile: 'default',
      profiles: ['default'],
    })
    mocks.getExecutionPools.mockResolvedValue({
      provider: 'static',
      pools: [{ profile: 'default', state: 'configured' }],
    })

    const container = await render()

    expect(
      container.querySelector('[data-settings-section="execution-pools"]')!.textContent,
    ).toContain('nothing to manage at runtime')
    expect((byTestId(container, 'execution-pool-0-drain') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId(container, 'execution-pool-0-release') as HTMLButtonElement).disabled).toBe(true)
  })

  it('inline: профили не применимы — пояснение вместо карточек и пулов', async () => {
    mocks.getExecutionProfiles.mockResolvedValue({
      provider: 'inline',
      pooling: 'instance',
      defaultProfile: 'default',
      profiles: [],
      details: [],
    })
    mocks.getExecutionPools.mockResolvedValue({ provider: 'inline', pools: [] })

    const container = await render()

    expect(byTestId(container, 'execution-not-applicable')!.textContent).toContain(
      enDict['settings.execution.notApplicable'],
    )
    // Карточек профилей и пулов нет — значит, и действий drain/release тоже.
    expect(byTestId(container, 'execution-profiles')).toBeNull()
    expect(byTestId(container, 'execution-pools')).toBeNull()
    expect(byTestId(container, 'execution-pool-0-drain')).toBeNull()
    expect(byTestId(container, 'execution-pool-0-release')).toBeNull()
    expect(byTestId(container, 'execution-pools-refresh')).toBeNull()
  })

  it('503 провайдера пулов — понятное сообщение вместо списка', async () => {
    mocks.getExecutionPools.mockRejectedValue(
      Object.assign(new Error('provider unavailable'), {
        status: 503,
        code: 'EXECUTION_PROVIDER_UNAVAILABLE',
      }),
    )

    const container = await render()

    expect(byTestId(container, 'execution-pools-error')!.textContent).toContain(
      enDict['settings.execution.providerUnavailable'],
    )
  })

  it('LEAD: каталог не правится (только ADMIN)', async () => {
    const container = await render(['LEAD'])

    expect(byTestId(container, 'execution-catalog-readonly')).not.toBeNull()
    expect(byTestId(container, 'execution-catalog-create')).toBeNull()
    expect(mocks.getExecutionSettings).not.toHaveBeenCalled()
  })

  it('USER не видит раздел и не дёргает API', async () => {
    const container = await render(['USER'])

    expect(byTestId(container, 'execution-forbidden')).not.toBeNull()
    expect(byTestId(container, 'execution-summary')).toBeNull()
    expect(mocks.getExecutionPools).not.toHaveBeenCalled()
    expect(mocks.getExecutionProfiles).not.toHaveBeenCalled()
  })
})
