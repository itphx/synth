import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
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

const mocks = vi.hoisted(() => ({
  getLlmGatewaySettingsInfo: vi.fn(),
  saveLlmGatewaySettings: vi.fn(),
  resetLlmGatewaySettings: vi.fn(),
  getGatewayPatterns: vi.fn(),
  saveGatewayPatterns: vi.fn(),
  resetGatewayPatterns: vi.fn(),
  getSecuritySettings: vi.fn(),
  getSecuritySettingsInfo: vi.fn(),
  saveSecuritySettings: vi.fn(),
  resetSecuritySettings: vi.fn(),
  getProtectedPaths: vi.fn(),
  saveProtectedPaths: vi.fn(),
  resetProtectedPaths: vi.fn(),
  // «Аудит решений» (`/settings/audit`): методы обязаны быть в моке — иначе эффект падает на `undefined()`.
  getSecurityAuditSettings: vi.fn(),
  saveSecurityAuditSettings: vi.fn(),
  resetSecurityAuditSettings: vi.fn(),
  // «Правила подтверждений по умолчанию» (`/settings/permissions`) — тот же риск: без мока эффект падает.
  getPermissionSettings: vi.fn(),
  savePermissionSettings: vi.fn(),
  resetPermissionSettings: vi.fn(),
  // Политики инструментов в «Безопасности» быть не должно — проверяем, что не дёргается.
  getToolsPolicy: vi.fn(),
  saveToolsPolicy: vi.fn(),
  notify: vi.fn(),
  // Сброс правил идёт через диалог подтверждения (в Node его нет — мок возвращает ответ).
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SecuritySettings } from './SecuritySettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Снимок секции «Безопасность» для GET/PUT/DELETE /settings/security. */
function securityInfo(overrides: Record<string, unknown> = {}) {
  return {
    security: {
      protectedPaths: { enabled: true },
      askTimeoutMs: 300_000,
      promptInjection: { enabled: true, wrapContent: true, mode: 'flag' },
    },
    isOverridden: false,
    defaults: {
      protectedPaths: { enabled: true },
      askTimeoutMs: 300_000,
      promptInjection: { enabled: true, wrapContent: true, mode: 'flag' },
    },
    source: 'default',
    envLocked: false,
    envLockedFields: [],
    restartRequired: false,
    ...overrides,
  }
}

const SECURITY_INFO = securityInfo()

/** Снимок секции «Аудит решений» для GET/PUT/DELETE /settings/audit. */
function auditInfo(overrides: Record<string, unknown> = {}) {
  return {
    permission: { mode: 'decisions', retentionDays: 30 },
    source: 'default',
    sources: { mode: 'default', retentionDays: 'default' },
    defaults: { mode: 'decisions', retentionDays: 30 },
    envLocked: false,
    envLockedFields: [],
    ...overrides,
  }
}

/** Снимок секции «Правила подтверждений» для GET/PUT/DELETE /settings/permissions. */
function permissionInfo(overrides: Record<string, unknown> = {}) {
  return {
    rules: {},
    source: 'default',
    defaults: { rules: {} },
    askTimeoutMs: 300_000,
    ...overrides,
  }
}

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({ settingsShowAdvanced: true, settingsFocus: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SecuritySettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.getLlmGatewaySettingsInfo.mockResolvedValue({
    settings: { enabled: false, inputMode: 'obfuscate', logPayloads: false },
    isOverridden: false,
    defaults: {
      enabled: false,
      inputMode: 'obfuscate',
      logPayloads: false,
      rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
    },
  })
  mocks.resetLlmGatewaySettings.mockResolvedValue({
    enabled: false,
    inputMode: 'obfuscate',
    logPayloads: false,
    rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
  })
  mocks.getGatewayPatterns.mockResolvedValue({ patterns: [], isOverridden: false })
  mocks.getSecuritySettings.mockResolvedValue({ protectedPaths: { enabled: true } })
  mocks.getSecuritySettingsInfo.mockResolvedValue(SECURITY_INFO)
  mocks.getProtectedPaths.mockResolvedValue({
    policy: { deniedPaths: [], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [] },
    isOverridden: false,
  })
  mocks.getSecurityAuditSettings.mockResolvedValue(auditInfo())
  mocks.getPermissionSettings.mockResolvedValue(permissionInfo())
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

describe('SecuritySettings — без политики инструментов (ADR-071 §2.3 перенесена во «Встроенные инструменты»)', () => {
  it('карточка «Политика инструментов» не рендерится и API политики не вызывается', async () => {
    const container = await renderSettings()

    expect(container.textContent).not.toContain('Tools policy')
    expect(container.textContent).not.toContain('Global policy')
    expect(mocks.getToolsPolicy).not.toHaveBeenCalled()
    expect(mocks.saveToolsPolicy).not.toHaveBeenCalled()
  })

  it('шлюз безопасности и защищённые пути остаются на месте', async () => {
    const container = await renderSettings()

    expect(container.textContent).toContain('Security gateway')
    expect(container.textContent).toContain('Protected paths')
  })
})

describe('SecuritySettings — предупреждение о выключенном LLM-шлюзе (F4, аудит S1)', () => {
  it('enabled=false → заметное предупреждение показано', async () => {
    const container = await renderSettings()

    const warning = container.querySelector('[data-testid="gateway-disabled-warning"]')
    expect(warning).not.toBeNull()
    expect(warning!.getAttribute('role')).toBe('alert')
    expect(warning!.textContent).toContain('LLM gateway is off')
  })

  it('enabled=true → предупреждения нет', async () => {
    mocks.getLlmGatewaySettingsInfo.mockResolvedValue({
      settings: { enabled: true, inputMode: 'obfuscate', logPayloads: false },
      isOverridden: true,
      defaults: { enabled: true, inputMode: 'obfuscate', logPayloads: false, rateLimit: { userPerMinute: 60, providerPerMinute: 120 } },
    })
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="gateway-disabled-warning"]')).toBeNull()
  })
})

describe('SecuritySettings — защита от prompt injection (ADR-023)', () => {
  const section = (container: HTMLElement) =>
    container.querySelector('[data-settings-section="security-prompt-injection"]') as HTMLElement | null

  it('рендерит подблок: тумблер, режим, бейдж источника', async () => {
    const container = await renderSettings()

    const block = section(container)
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain('Prompt injection protection')
    expect(block!.querySelector('[role="switch"]')).not.toBeNull()
    expect(block!.querySelector('[data-testid="security-prompt-injection-mode"]')).not.toBeNull()
    expect(
      block!.querySelector('[data-testid="security-prompt-injection-source"]')?.textContent,
    ).toBe('default')
    expect(block!.textContent).toContain('Tool content wrapping: Enabled')
  })

  it('сохранение отправляет только изменённые поля защиты и перечитывает снимок', async () => {
    mocks.getSecuritySettingsInfo
      .mockResolvedValueOnce(SECURITY_INFO)
      .mockResolvedValueOnce(
        securityInfo({
          source: 'runtime',
          isOverridden: true,
          security: {
            ...SECURITY_INFO.security,
            promptInjection: { enabled: false, wrapContent: true, mode: 'flag' },
          },
        }),
      )
    mocks.saveSecuritySettings.mockResolvedValue({ protectedPaths: { enabled: true } })
    const container = await renderSettings()

    const toggle = section(container)!.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    const save = () =>
      container.querySelector('[data-testid="security-prompt-injection-save"]') as HTMLButtonElement
    expect(save().disabled).toBe(true)

    await act(async () => {
      toggle.click()
    })
    expect(save().disabled).toBe(false)

    await act(async () => {
      save().click()
    })
    expect(mocks.saveSecuritySettings).toHaveBeenCalledWith({ promptInjection: { enabled: false } })
    // После сохранения снимок перечитан — бейдж стал «из настроек».
    expect(
      container.querySelector('[data-testid="security-prompt-injection-source"]')?.textContent,
    ).toBe('from settings')
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('env-фиксация блокирует контролы и показывает предупреждение', async () => {
    mocks.getSecuritySettingsInfo.mockResolvedValue(
      securityInfo({
        source: 'env',
        envLocked: true,
        envLockedFields: ['enabled', 'mode'],
        security: {
          ...SECURITY_INFO.security,
          promptInjection: { enabled: false, wrapContent: true, mode: 'block' },
        },
      }),
    )
    const container = await renderSettings()

    const block = section(container)!
    expect(
      block.querySelector('[data-testid="security-prompt-injection-env-locked"]'),
    ).not.toBeNull()
    // Тумблер: обёртка disabled (pointer-events-none), селект — disabled.
    const toggleWrapper = block.querySelector('[role="switch"]')!.parentElement as HTMLElement
    expect(toggleWrapper.className).toContain('pointer-events-none')
    const trigger = block.querySelector(
      '[data-testid="security-prompt-injection-mode"]',
    ) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    // Сброс недоступен, пока значение зафиксировано env.
    const reset = block.querySelector(
      '[data-testid="security-prompt-injection-reset"]',
    ) as HTMLButtonElement
    expect(reset.disabled).toBe(true)
  })

  it('сброс вызывает DELETE и применяет ответ', async () => {
    mocks.getSecuritySettingsInfo.mockResolvedValue(
      securityInfo({
        source: 'runtime',
        isOverridden: true,
        security: {
          ...SECURITY_INFO.security,
          promptInjection: { enabled: false, wrapContent: true, mode: 'sanitize' },
        },
      }),
    )
    mocks.resetSecuritySettings.mockResolvedValue(securityInfo())
    const container = await renderSettings()

    const reset = container.querySelector(
      '[data-testid="security-prompt-injection-reset"]',
    ) as HTMLButtonElement
    expect(reset.disabled).toBe(false)

    await act(async () => {
      reset.click()
    })
    expect(mocks.resetSecuritySettings).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalled()
  })
})

describe('SecuritySettings — миграция на Settings UI Kit (ADR-072)', () => {
  it('каркас — SettingsPanel с единственным scroll-контейнером и без pr-2', async () => {
    const container = await renderSettings()

    const scrollers = container.querySelectorAll('.overflow-y-auto')
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0]!.classList.contains('overflow-x-hidden')).toBe(true)
    expect(container.innerHTML).not.toContain('pr-2')
  })

  it('числовые поля — NumberField (w-full sm:w-24), без legacy w-20', async () => {
    const container = await renderSettings()

    const numbers = container.querySelectorAll('input[type="number"]')
    // rateLimit user/provider + askTimeoutSec
    expect(numbers.length).toBeGreaterThanOrEqual(3)
    numbers.forEach((input) => {
      expect(input.classList.contains('sm:w-24')).toBe(true)
      expect(input.classList.contains('w-20')).toBe(false)
    })
    expect(container.innerHTML).not.toContain('w-20')
  })

  it('Save/Cancel/Reset шлюза гаснут на дефолте и активируются при изменениях; Reset дёргает API', async () => {
    const container = await renderSettings()

    const save = () =>
      container.querySelector('[data-testid="security-gateway-save"]') as HTMLButtonElement
    const cancel = () =>
      container.querySelector('[data-testid="security-gateway-cancel"]') as HTMLButtonElement
    const reset = () =>
      container.querySelector('[data-testid="security-gateway-reset"]') as HTMLButtonElement
    expect(save()).not.toBeNull()

    // Сервер вернул дефолтные настройки → Save/Cancel неактивны, Reset серый и disabled.
    expect(save().disabled).toBe(true)
    expect(cancel().disabled).toBe(true)
    expect(reset().disabled).toBe(true)
    expect(reset().className).toContain('border-muted-foreground')

    // Меняем настройку шлюза — появляется dirty: Save/Cancel активны, Reset цветная.
    const gatewayToggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    await act(async () => {
      gatewayToggle.click()
    })
    expect(save().disabled).toBe(false)
    expect(cancel().disabled).toBe(false)
    expect(reset().disabled).toBe(false)
    expect(reset().className).toContain('border-primary')

    await act(async () => {
      reset().click()
    })

    expect(mocks.resetLlmGatewaySettings).toHaveBeenCalledTimes(1)
    // Reset вернул дефолт в черновик → Save/Cancel снова неактивны.
    expect(save().disabled).toBe(true)
    expect(cancel().disabled).toBe(true)
  })

  it('Reset паттернов и защищённых путей серый на дефолте и цветной при override', async () => {
    const container = await renderSettings()
    const patternsReset = () =>
      container.querySelector('[data-testid="security-patterns-reset"]') as HTMLButtonElement
    const protectedReset = () =>
      container.querySelector('[data-testid="security-protected-reset"]') as HTMLButtonElement

    // isOverridden=false → настройки базовые → Reset серые и disabled.
    expect(patternsReset().disabled).toBe(true)
    expect(patternsReset().className).toContain('border-muted-foreground')
    expect(protectedReset().disabled).toBe(true)
    expect(protectedReset().className).toContain('border-muted-foreground')

    // Сервер сообщает об override → Reset цветные и активные.
    mocks.getGatewayPatterns.mockResolvedValue({
      patterns: [{ type: 'api_key', regex: 'sk-\\w+' }],
      isOverridden: true,
    })
    mocks.getProtectedPaths.mockResolvedValue({
      policy: { deniedPaths: ['/etc'], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [] },
      isOverridden: true,
    })
    const overridden = await renderSettings()
    const patternsReset2 =
      overridden.querySelector('[data-testid="security-patterns-reset"]') as HTMLButtonElement
    const protectedReset2 =
      overridden.querySelector('[data-testid="security-protected-reset"]') as HTMLButtonElement

    expect(patternsReset2.disabled).toBe(false)
    expect(patternsReset2.className).toContain('border-primary')
    expect(protectedReset2.disabled).toBe(false)
    expect(protectedReset2.className).toContain('border-primary')
  })

  it('списки защищённых путей рендерятся через ListField', async () => {
    const container = await renderSettings()

    for (const label of [
      'Denied paths (exact match)',
      'Denied directory prefixes',
      'Paths requiring confirmation (ask)',
      'Denied command prefixes (shell only)',
    ]) {
      expect(container.textContent).toContain(label)
    }
    // Постоянных полей ввода в списках нет — только кнопки «Добавить» (по одной на список).
    expect(container.querySelectorAll('input[type="text"]').length).toBe(0)
    const addButtons = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() === 'Add',
    )
    expect(addButtons.length).toBeGreaterThanOrEqual(4)
  })
})

describe('SecuritySettings — «Аудит решений по правам» (settings/audit)', () => {
  const section = (container: HTMLElement) =>
    container.querySelector('[data-settings-section="security-audit-decisions"]') as HTMLElement | null
  const byTestId = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
  const modeTrigger = (container: HTMLElement) =>
    byTestId(container, 'security-audit-mode') as HTMLButtonElement
  const retentionInput = (container: HTMLElement) =>
    byTestId(container, 'security-audit-retention') as HTMLInputElement
  const save = (container: HTMLElement) =>
    byTestId(container, 'security-audit-save') as HTMLButtonElement
  const reset = (container: HTMLElement) =>
    byTestId(container, 'security-audit-reset') as HTMLButtonElement

  /** Изменить controlled-инпут так, чтобы React увидел `onChange`. */
  async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  /** Открывает Base UI select и возвращает список опций (опции рендерятся в portal). */
  async function openOptions(trigger: HTMLElement): Promise<HTMLElement[]> {
    await act(async () => {
      trigger.click()
    })
    const listId = trigger.getAttribute('aria-controls')
    const scope = listId ? document.getElementById(listId) ?? document.body : document.body
    return [...scope.querySelectorAll('[role="option"]')] as HTMLElement[]
  }

  /** Открывает Base UI select и кликает опцию по подписи. */
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

  it('рендерит значения из GET: режим, срок хранения, бейдж источника', async () => {
    mocks.getSecurityAuditSettings.mockResolvedValue(
      auditInfo({ permission: { mode: 'all', retentionDays: 90 } }),
    )
    const container = await renderSettings()

    expect(mocks.getSecurityAuditSettings).toHaveBeenCalledTimes(1)
    const block = section(container)
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain('Permission decision audit')
    expect(modeTrigger(container).textContent).toContain('All rule decisions')
    expect(retentionInput(container).value).toBe('90')
    expect(byTestId(container, 'security-audit-source')?.textContent).toBe('default')
    expect(byTestId(container, 'security-audit-defaults')?.textContent).toContain(
      'Base: Human questions only, 30 d.',
    )
    // Режим `all` — подсказка про рост журнала.
    expect(byTestId(container, 'security-audit-all-mode-hint')).not.toBeNull()
  })

  it('сохранение отправляет вложенное тело { permission: { … } } и применяет ответ', async () => {
    mocks.saveSecurityAuditSettings.mockResolvedValue(
      auditInfo({
        permission: { mode: 'all', retentionDays: 60 },
        source: 'runtime',
        sources: { mode: 'runtime', retentionDays: 'runtime' },
      }),
    )
    const container = await renderSettings()

    // На дефолте сохранять нечего.
    expect(save(container).disabled).toBe(true)

    await selectOption(modeTrigger(container), 'All rule decisions')
    await setInputValue(retentionInput(container), '60')
    expect(save(container).disabled).toBe(false)

    await act(async () => {
      save(container).click()
    })

    // Тело PUT — вложенная форма контракта бэкенда (вложенный патч).
    expect(mocks.saveSecurityAuditSettings).toHaveBeenCalledWith({
      permission: { mode: 'all', retentionDays: 60 },
    })
    expect(byTestId(container, 'security-audit-source')?.textContent).toBe('from settings')
    expect(retentionInput(container).value).toBe('60')
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('сброс вызывает DELETE и возвращает базовые значения', async () => {
    mocks.getSecurityAuditSettings.mockResolvedValue(
      auditInfo({
        permission: { mode: 'all', retentionDays: 120 },
        source: 'runtime',
        sources: { mode: 'runtime', retentionDays: 'runtime' },
      }),
    )
    mocks.resetSecurityAuditSettings.mockResolvedValue(auditInfo())
    const container = await renderSettings()

    expect(reset(container).disabled).toBe(false)
    await act(async () => {
      reset(container).click()
    })

    expect(mocks.resetSecurityAuditSettings).toHaveBeenCalledTimes(1)
    expect(modeTrigger(container).textContent).toContain('Human questions only')
    expect(retentionInput(container).value).toBe('30')
    expect(byTestId(container, 'security-audit-source')?.textContent).toBe('default')
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('env-фиксация отключает зафиксированное поле, показывает предупреждение и не даёт сбросить', async () => {
    mocks.getSecurityAuditSettings.mockResolvedValue(
      auditInfo({
        permission: { mode: 'all', retentionDays: 30 },
        source: 'env',
        sources: { mode: 'env', retentionDays: 'default' },
        envLocked: true,
        envLockedFields: ['mode'],
      }),
    )
    const container = await renderSettings()

    expect(modeTrigger(container).disabled).toBe(true)
    expect(retentionInput(container).disabled).toBe(false)
    const banner = byTestId(container, 'security-audit-env-locked')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain('Set via an environment variable')
    // Источник — env: сброс недоступен (зафиксировано сверху).
    expect(reset(container).disabled).toBe(true)

    // Незафиксированное поле всё равно сохраняется — и уходит одно.
    mocks.saveSecurityAuditSettings.mockResolvedValue(
      auditInfo({
        permission: { mode: 'all', retentionDays: 45 },
        source: 'env',
        sources: { mode: 'env', retentionDays: 'runtime' },
        envLocked: true,
        envLockedFields: ['mode'],
      }),
    )
    await setInputValue(retentionInput(container), '45')
    await act(async () => {
      save(container).click()
    })
    expect(mocks.saveSecurityAuditSettings).toHaveBeenCalledWith({
      permission: { retentionDays: 45 },
    })
  })

  it('409 ENV_LOCKED подсвечивает зафиксированные поля и блокирует их', async () => {
    mocks.saveSecurityAuditSettings.mockRejectedValue(
      Object.assign(new Error('audit.permission: fixed'), {
        status: 409,
        code: 'ENV_LOCKED',
        fields: ['retentionDays'],
      }),
    )
    const container = await renderSettings()

    await setInputValue(retentionInput(container), '45')
    await act(async () => {
      save(container).click()
    })

    expect(byTestId(container, 'security-audit-error')?.textContent).toContain(
      'Set via an environment variable',
    )
    expect(byTestId(container, 'security-audit-env-locked')).not.toBeNull()
    expect(retentionInput(container).disabled).toBe(true)
  })

  it('невалидный срок хранения не отправляется', async () => {
    const container = await renderSettings()

    await setInputValue(retentionInput(container), '0')

    expect(save(container).disabled).toBe(true)
    expect(mocks.saveSecurityAuditSettings).not.toHaveBeenCalled()
  })
})

describe('SecuritySettings — «Правила подтверждений по умолчанию» (settings/permissions)', () => {
  const byTestId = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
  const keyInput = (container: HTMLElement, index: number) =>
    byTestId(container, `permission-rule-key-${index}`) as HTMLInputElement
  const actionTrigger = (container: HTMLElement, index: number) =>
    byTestId(container, `permission-rule-action-${index}`) as HTMLButtonElement
  const save = (container: HTMLElement) =>
    byTestId(container, 'security-permission-rules-save') as HTMLButtonElement
  const reset = (container: HTMLElement) =>
    byTestId(container, 'security-permission-rules-reset') as HTMLButtonElement
  const validation = (container: HTMLElement) => byTestId(container, 'security-permission-rules-validation')

  /** Изменить controlled-инпут так, чтобы React увидел `onChange`. */
  async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function clickTestId(container: HTMLElement, id: string): Promise<void> {
    const element = byTestId(container, id)
    expect(element, `элемент ${id}`).not.toBeNull()
    await act(async () => {
      element!.click()
    })
  }

  /** Открывает Base UI select и кликает опцию по подписи (опции рендерятся в portal). */
  async function selectOption(trigger: HTMLElement, label: string): Promise<void> {
    await act(async () => {
      trigger.click()
    })
    const listId = trigger.getAttribute('aria-controls')
    const scope = listId ? document.getElementById(listId) ?? document.body : document.body
    const options = [...scope.querySelectorAll('[role="option"]')] as HTMLElement[]
    const option = options.find((o) => o.textContent?.trim().startsWith(label))
    expect(option, `option "${label}"`).toBeTruthy()
    await act(async () => {
      option!.click()
    })
  }

  it('рендерит правила из GET: ключи, действия, паттерны, источник и справку', async () => {
    mocks.getPermissionSettings.mockResolvedValue(
      permissionInfo({
        rules: { read_file: 'allow', execute_shell: { 'git status *': 'deny' } },
        source: 'runtime',
        defaults: { rules: { read_file: 'allow' } },
      }),
    )
    const container = await renderSettings()

    expect(mocks.getPermissionSettings).toHaveBeenCalledTimes(1)
    const block = container.querySelector('[data-settings-section="security-permission-rules"]')
    expect(block).not.toBeNull()
    expect(block!.textContent).toContain('Default approval rules')

    expect(keyInput(container, 0).value).toBe('read_file')
    expect(keyInput(container, 1).value).toBe('execute_shell')
    // Строковое правило — действие в селекте; объектное — раскрыто в пару.
    expect(actionTrigger(container, 0).textContent).toContain('allow — permit')
    expect(byTestId(container, 'permission-rule-action-1')).toBeNull()
    expect(
      (byTestId(container, 'permission-rule-pattern-1-0') as HTMLInputElement).value,
    ).toBe('git status *')

    expect(byTestId(container, 'security-permission-rules-source')?.textContent).toBe(
      'from settings',
    )
    // `askTimeoutMs` — только справка (редактируется в блоке «Защищённые пути»).
    expect(byTestId(container, 'security-permission-rules-ask-timeout')?.textContent).toContain(
      '300 s',
    )
    expect(byTestId(container, 'security-permission-rules-defaults')?.textContent).toContain('1')
    expect(reset(container).disabled).toBe(false)
  })

  it('добавление и сохранение: уходит полная карта {rules}', async () => {
    mocks.getPermissionSettings.mockResolvedValue(
      permissionInfo({ rules: { read_file: 'allow' }, source: 'runtime' }),
    )
    mocks.savePermissionSettings.mockResolvedValue(
      permissionInfo({ rules: { read_file: 'allow', shell: 'allow' }, source: 'runtime' }),
    )
    const container = await renderSettings()

    // Без правок сохранять нечего.
    expect(save(container).disabled).toBe(true)

    await clickTestId(container, 'permission-rule-add')
    await setInputValue(keyInput(container, 1), 'shell')
    await selectOption(actionTrigger(container, 1), 'allow')
    expect(save(container).disabled).toBe(false)

    await clickTestId(container, 'security-permission-rules-save')

    expect(mocks.savePermissionSettings).toHaveBeenCalledWith({
      rules: { read_file: 'allow', shell: 'allow' },
    })
    expect(byTestId(container, 'security-permission-rules-source')?.textContent).toBe(
      'from settings',
    )
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('удаление правила: сохранение отправляет карту без него', async () => {
    mocks.getPermissionSettings.mockResolvedValue(
      permissionInfo({ rules: { read_file: 'allow', execute_shell: 'deny' }, source: 'runtime' }),
    )
    mocks.savePermissionSettings.mockResolvedValue(
      permissionInfo({ rules: { execute_shell: 'deny' }, source: 'runtime' }),
    )
    const container = await renderSettings()

    await clickTestId(container, 'permission-rule-remove-0')
    expect(keyInput(container, 0).value).toBe('execute_shell')

    await clickTestId(container, 'security-permission-rules-save')

    // `PUT` заменяет карту целиком — снятое правило не «всплывает» из базы.
    expect(mocks.savePermissionSettings).toHaveBeenCalledWith({ rules: { execute_shell: 'deny' } })
  })

  it('объектное правило: пара паттерн → действие уходит вложенной картой', async () => {
    mocks.savePermissionSettings.mockResolvedValue(
      permissionInfo({ rules: { write_file: { '*.env': 'deny' } }, source: 'runtime' }),
    )
    const container = await renderSettings()

    await clickTestId(container, 'permission-rule-add')
    await setInputValue(keyInput(container, 0), 'write_file')
    await clickTestId(container, 'permission-rule-patterns-0')

    // Паттерны есть — действие берётся из пары, селект ключа уступает.
    expect(byTestId(container, 'permission-rule-action-0')).toBeNull()
    // Пустой паттерн блокирует отправку.
    expect(validation(container)?.textContent).toContain('Empty pattern')
    expect(save(container).disabled).toBe(true)

    const pattern = byTestId(container, 'permission-rule-pattern-0-0') as HTMLInputElement
    await setInputValue(pattern, '*.env')
    await selectOption(byTestId(container, 'permission-rule-pattern-action-0-0')!, 'deny')
    expect(save(container).disabled).toBe(false)

    await clickTestId(container, 'security-permission-rules-save')

    expect(mocks.savePermissionSettings).toHaveBeenCalledWith({
      rules: { write_file: { '*.env': 'deny' } },
    })

    // Снятие всех паттернов возвращает строковую форму правила (снова виден селект действия).
    await clickTestId(container, 'permission-rule-pattern-remove-0-0')
    expect(byTestId(container, 'permission-rule-pattern-0-0')).toBeNull()
    expect(byTestId(container, 'permission-rule-action-0')).not.toBeNull()
  })

  it('сброс к базе идёт через confirm() и DELETE, форма принимает ответ', async () => {
    mocks.getPermissionSettings.mockResolvedValue(
      permissionInfo({
        rules: { read_file: 'deny' },
        source: 'runtime',
        defaults: { rules: { read_file: 'allow' } },
      }),
    )
    mocks.resetPermissionSettings.mockResolvedValue(
      permissionInfo({
        rules: { read_file: 'allow' },
        source: 'config',
        defaults: { rules: { read_file: 'allow' } },
      }),
    )
    const container = await renderSettings()

    expect(reset(container).disabled).toBe(false)
    await clickTestId(container, 'security-permission-rules-reset')

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.resetPermissionSettings).toHaveBeenCalledTimes(1)
    expect(actionTrigger(container, 0).textContent).toContain('allow — permit')
    expect(byTestId(container, 'security-permission-rules-source')?.textContent).toBe(
      'from config.yaml',
    )
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('отказ в подтверждении не сбрасывает правила', async () => {
    mocks.confirm.mockResolvedValue(false)
    mocks.getPermissionSettings.mockResolvedValue(
      permissionInfo({ rules: { read_file: 'deny' }, source: 'runtime' }),
    )
    const container = await renderSettings()

    await clickTestId(container, 'security-permission-rules-reset')

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.resetPermissionSettings).not.toHaveBeenCalled()
  })

  it('клиентская валидация: пустой ключ и дубликат гасят сохранение', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'permission-rule-add')
    await clickTestId(container, 'permission-rule-add')

    // Обе строки без ключа — сообщение (про первую строку) и Save недоступен.
    expect(validation(container)?.textContent).toContain('Empty rule key (row 1)')
    expect(save(container).disabled).toBe(true)

    await setInputValue(keyInput(container, 0), 'shell')
    // Ошибка смещается на оставшуюся пустую строку — заполнение работает.
    expect(validation(container)?.textContent).toContain('Empty rule key (row 2)')

    await setInputValue(keyInput(container, 1), 'shell')
    // Дубликат ключа: карта схлопнула бы строки — отправлять нельзя.
    expect(validation(container)?.textContent).toContain('listed twice')
    expect(save(container).disabled).toBe(true)

    await act(async () => {
      save(container).click()
    })
    expect(mocks.savePermissionSettings).not.toHaveBeenCalled()
  })

  it('таймаут подтверждения — только справка: 0 с показывается как выключенный', async () => {
    mocks.getPermissionSettings.mockResolvedValue(permissionInfo({ askTimeoutMs: 0 }))
    const container = await renderSettings()

    expect(byTestId(container, 'security-permission-rules-ask-timeout')?.textContent).toContain(
      'timeout is off',
    )
    // Поле таймаута редактируется в блоке «Защищённые пути» — здесь его нет.
    expect(
      container
        .querySelector('[data-settings-section="security-permission-rules"]')!
        .querySelector('input[type="number"]'),
    ).toBeNull()
  })

  it('серверная 400 показывается текстом ошибки', async () => {    mocks.getPermissionSettings.mockResolvedValue(
      permissionInfo({ rules: { read_file: 'allow' }, source: 'runtime' }),
    )
    mocks.savePermissionSettings.mockRejectedValue(
      Object.assign(new Error('permission.rules: невалидные правила ("shell")'), {
        status: 400,
        code: 'VALIDATION_ERROR',
      }),
    )
    const container = await renderSettings()

    await clickTestId(container, 'permission-rule-add')
    await setInputValue(keyInput(container, 1), 'shell')
    await clickTestId(container, 'security-permission-rules-save')

    expect(byTestId(container, 'security-permission-rules-error')?.textContent).toContain(
      'невалидные правила',
    )
  })

  it('неудачная загрузка блокирует сохранение (PUT заменяет карту целиком)', async () => {
    mocks.getPermissionSettings.mockRejectedValue(new Error('HTTP 500'))
    const container = await renderSettings()

    expect(byTestId(container, 'security-permission-rules-load-error')).not.toBeNull()

    await clickTestId(container, 'permission-rule-add')
    await setInputValue(keyInput(container, 0), 'shell')
    expect(save(container).disabled).toBe(true)

    await act(async () => {
      save(container).click()
    })
    expect(mocks.savePermissionSettings).not.toHaveBeenCalled()
  })
})
