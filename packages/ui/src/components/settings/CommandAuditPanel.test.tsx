import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getCommandAudit: vi.fn(),
  pruneCommandAudit: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
  downloadBlob: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getCommandAudit: mocks.getCommandAudit,
    pruneCommandAudit: mocks.pruneCommandAudit,
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
vi.mock('@/lib/download', () => ({ downloadBlob: mocks.downloadBlob }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useAuthStore } from '@/stores/authStore'
import { CommandAuditPanel, buildCommandAuditCsv, csvCell, shortAuditId } from './CommandAuditPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const ENTRY = {
  id: 'exec-1',
  ts: '2026-11-12T10:00:00.000Z',
  sessionId: 'ses-1234567890',
  projectId: 'prj-1',
  actor: 'admin',
  agentRole: 'fixer',
  tool: 'execute_shell' as const,
  command: 'ls -la "quoted"',
  commandHash: 'hash-1',
  cwd: '/work',
  background: false,
  decision: 'allow' as const,
  decidedBy: 'permission' as const,
  phase: 'started' as const,
}

const ENTRY_DENY = {
  ...ENTRY,
  id: 'exec-2',
  ts: '2026-11-12T10:05:00.000Z',
  decision: 'deny' as const,
  command: 'rm -rf /',
  phase: 'finished' as const,
  durationMs: 120,
  exitCode: 1,
  reason: 'protected path',
  provider: { kind: 'opa', action: 'deny' as const, ruleId: 'deny-root' },
}

async function renderPanel(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <CommandAuditPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

const clickTestId = async (container: HTMLElement, testId: string) => {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  expect(el, `элемент ${testId}`).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await act(async () => {})
}

/** Открывает Base UI select и кликает опцию по подписи. */
async function selectOption(container: HTMLElement, triggerTestId: string, label: string) {
  const trigger = container.querySelector(`[data-testid="${triggerTestId}"]`) as HTMLElement
  expect(trigger, `триггер ${triggerTestId}`).toBeTruthy()
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
  await act(async () => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommandAudit.mockResolvedValue({ entries: [ENTRY], count: 1 })
  mocks.pruneCommandAudit.mockResolvedValue({ removed: 3 })
  mocks.confirm.mockResolvedValue(true)
  mocks.downloadBlob.mockReturnValue(true)
  useAuthStore.setState({
    user: { id: 'u1', username: 'u1', email: null, roles: ['ADMIN'] },
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
})

describe('CommandAuditPanel — список и фильтры', () => {
  it('первая загрузка: GET с дефолтными фильтрами (без решения/сессии)', async () => {
    const container = await renderPanel()

    expect(mocks.getCommandAudit).toHaveBeenCalledWith({
      decision: undefined,
      limit: 100,
      sessionId: undefined,
    })
    expect(container.querySelector('[data-testid="command-audit-table"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="command-audit-row-exec-1-started"]')).toBeTruthy()
  })

  it('строка показывает команду, решение и короткий id сессии', async () => {
    const container = await renderPanel()

    const command = container.querySelector('[data-testid="command-audit-command-exec-1-started"]')
    expect(command?.textContent).toBe('ls -la "quoted"')

    const decision = container.querySelector('[data-testid="command-audit-decision-exec-1-started"]')
    expect(decision?.textContent).toBe('Allowed')

    const session = container.querySelector('[data-testid="command-audit-session-exec-1-started"]')
    expect(session?.textContent).toBe('ses-1234…')
  })

  it('фильтр по решению применяется сразу', async () => {
    const container = await renderPanel()

    await selectOption(container, 'command-audit-decision', 'Denied')

    expect(mocks.getCommandAudit).toHaveBeenLastCalledWith({
      decision: 'deny',
      limit: 100,
      sessionId: undefined,
    })
  })

  it('фильтр по id сессии применяется по кнопке «Обновить»', async () => {
    const container = await renderPanel()

    const input = container.querySelector('[data-testid="command-audit-session"]') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'ses-1234567890')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await clickTestId(container, 'command-audit-refresh')

    expect(mocks.getCommandAudit).toHaveBeenLastCalledWith({
      decision: undefined,
      limit: 100,
      sessionId: 'ses-1234567890',
    })
  })

  it('причина и вердикт внешнего чекера видны в строке', async () => {
    mocks.getCommandAudit.mockResolvedValue({ entries: [ENTRY_DENY], count: 1 })
    const container = await renderPanel()

    const reason = container.querySelector('[data-testid="command-audit-reason-exec-2-finished"]')
    expect(reason?.textContent).toContain('protected path')

    const provider = container.querySelector('[data-testid="command-audit-provider-exec-2-finished"]')
    expect(provider?.textContent).toContain('opa:deny')
    expect(provider?.textContent).toContain('deny-root')
  })

  it('пустое состояние — понятный текст', async () => {    mocks.getCommandAudit.mockResolvedValue({ entries: [], count: 0 })
    const container = await renderPanel()

    expect(container.querySelector('[data-testid="command-audit-empty"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="command-audit-table"]')).toBeFalsy()
  })

  it('403 — понятный текст о правах', async () => {
    mocks.getCommandAudit.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' }),
    )
    const container = await renderPanel()

    const error = container.querySelector('[data-testid="command-audit-error"]')
    expect(error?.textContent).toContain('ADMIN or AUDITOR')
  })

  it('503 — понятный текст о недоступности журнала', async () => {
    mocks.getCommandAudit.mockRejectedValue(
      Object.assign(new Error('unavailable'), { status: 503, code: 'SERVICE_UNAVAILABLE' }),
    )
    const container = await renderPanel()

    const error = container.querySelector('[data-testid="command-audit-error"]')
    expect(error?.textContent).toContain('unavailable')
  })
})

describe('CommandAuditPanel — экспорт CSV', () => {
  it('кнопка «Экспорт CSV» отдаёт файл с текущими записями', async () => {
    const container = await renderPanel()

    await clickTestId(container, 'command-audit-export')

    expect(mocks.downloadBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = mocks.downloadBlob.mock.calls[0] as [Blob, string]
    expect(blob.type).toContain('text/csv')
    expect(filename.startsWith('command-audit-')).toBe(true)
    expect(filename.endsWith('.csv')).toBe(true)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    )
  })

  it('CSV: кавычки экранируются, значения оборачиваются в кавычки', () => {
    expect(csvCell('a"b')).toBe('"a""b"')
    expect(csvCell('plain')).toBe('"plain"')
    expect(csvCell(undefined)).toBe('""')

    const csv = buildCommandAuditCsv([ENTRY])
    const lines = csv.split('\n')
    expect(lines[0]).toContain('"ts"')
    expect(lines[1]).toContain('"ls -la ""quoted"""')
  })

  it('короткий id: длинный обрезается, короткий — как есть', () => {
    expect(shortAuditId('ses-1234567890')).toBe('ses-1234…')
    expect(shortAuditId('ses-1')).toBe('ses-1')
    expect(shortAuditId(undefined)).toBe('—')
  })

  it('пустой журнал: экспорт не создаёт файл, но сообщает об этом', async () => {
    mocks.getCommandAudit.mockResolvedValue({ entries: [], count: 0 })
    const container = await renderPanel()

    await clickTestId(container, 'command-audit-export')

    expect(mocks.downloadBlob).not.toHaveBeenCalled()
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' }),
    )
  })
})

describe('CommandAuditPanel — retention-очистка (prune)', () => {
  it('для ADMIN: кнопка есть, prune идёт после подтверждения, список перечитывается', async () => {
    const container = await renderPanel()

    expect(container.querySelector('[data-testid="command-audit-prune-button"]')).toBeTruthy()

    const days = container.querySelector('[data-testid="command-audit-prune-days"]') as HTMLInputElement
    expect(days).toBeTruthy()

    await clickTestId(container, 'command-audit-prune-button')

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger' }),
    )
    expect(mocks.pruneCommandAudit).toHaveBeenCalledWith(30)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: expect.stringContaining('3') }),
    )
    // Список перечитан после очистки.
    expect(mocks.getCommandAudit).toHaveBeenCalledTimes(2)
  })

  it('отказ в подтверждении — prune не вызывается', async () => {
    mocks.confirm.mockResolvedValue(false)
    const container = await renderPanel()

    await clickTestId(container, 'command-audit-prune-button')

    expect(mocks.pruneCommandAudit).not.toHaveBeenCalled()
  })

  it('для не-ADMIN кнопки очистки нет (видна подсказка)', async () => {
    useAuthStore.setState({
      user: { id: 'u2', username: 'u2', email: null, roles: ['AUDITOR'] },
    })
    const container = await renderPanel()

    expect(container.querySelector('[data-testid="command-audit-prune-button"]')).toBeFalsy()
    expect(container.querySelector('[data-testid="command-audit-prune"]')).toBeFalsy()
    expect(container.querySelector('[data-testid="command-audit-prune-admin-only"]')).toBeTruthy()
  })
})
