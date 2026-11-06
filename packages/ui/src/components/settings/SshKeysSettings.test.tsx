import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({ notify: vi.fn() }))

vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SshKeysSettings } from './SshKeysSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

interface FetchCall {
  url: string
  method: string
  body?: string
}
interface FetchResult {
  status?: number
  body: unknown
}

function stubFetch(handler: (call: FetchCall) => FetchResult): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: FetchCall = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? init.body : undefined,
      }
      calls.push(call)
      const result = handler(call)
      const status = result.status ?? 200
      return { ok: status < 400, status, json: async () => result.body } as unknown as Response
    }),
  )
  return calls
}

const byTestId = (container: HTMLElement, id: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${id}"]`)

/** Изменить controlled-поле (input/textarea) так, чтобы React увидел `onChange`. */
async function typeInto(field: Element | null, value: string): Promise<void> {
  if (!field) throw new Error('поле не найдено')
  const proto =
    field instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: Element | null): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement)?.click()
  })
}

async function render(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <SshKeysSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

const SETTINGS_TOOLS = {
  mode: 'tools',
  saved: null,
  defaults: 'tools',
  source: 'config',
  envLocked: false,
  restartRequired: false,
}

const SETTINGS_AGENT = { ...SETTINGS_TOOLS, mode: 'agent' }

beforeEach(() => {
  mocks.notify.mockClear()
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => root.unmount())
    container.remove()
  }
  vi.clearAllMocks()
})

describe('SshKeysSettings (PROP-124)', () => {
  it('в режиме agent поля хостов/портов скрыты, есть пояснение', async () => {
    stubFetch((call) => {
      if (call.url.includes('/settings/ssh')) return { body: SETTINGS_AGENT }
      if (call.url.includes('/ssh-keys')) return { body: [] }
      if (call.url.includes('/agents')) return { body: { agents: [], default_agent: null } }
      return { body: {} }
    })
    const container = await render()

    expect(byTestId(container, 'ssh-keys-agent-mode-note')).not.toBeNull()
    expect(byTestId(container, 'ssh-keys-allow-hosts')).toBeNull()
    expect(byTestId(container, 'ssh-keys-allow-ports')).toBeNull()
  })

  it('в режиме tools поля хостов/портов есть, пояснения нет', async () => {
    stubFetch((call) => {
      if (call.url.includes('/settings/ssh')) return { body: SETTINGS_TOOLS }
      if (call.url.includes('/ssh-keys')) return { body: [] }
      if (call.url.includes('/agents')) return { body: { agents: [], default_agent: null } }
      return { body: {} }
    })
    const container = await render()

    expect(byTestId(container, 'ssh-keys-agent-mode-note')).toBeNull()
    // Поля политики — в форме ключа: открываем редактор.
    await click(byTestId(container, 'ssh-keys-add'))
    expect(byTestId(container, 'ssh-keys-allow-hosts')).not.toBeNull()
    expect(byTestId(container, 'ssh-keys-allow-ports')).not.toBeNull()
  })

  it('переключатель режима сохраняет новое значение через API', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'PUT') return { body: SETTINGS_AGENT }
      if (call.url.includes('/settings/ssh')) return { body: SETTINGS_TOOLS }
      if (call.url.includes('/ssh-keys')) return { body: [] }
      if (call.url.includes('/agents')) return { body: { agents: [], default_agent: null } }
      return { body: {} }
    })
    const container = await render()

    await click(byTestId(container, 'ssh-keys-mode-agent'))
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/settings/ssh'))
    expect(put?.body).toContain('agent')
  })

  it('выбор usages и правил хостов уходит в тело create', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'POST') return { status: 201, body: { id: 'k1' } }
      if (call.url.includes('/settings/ssh')) return { body: SETTINGS_TOOLS }
      if (call.url.includes('/ssh-keys')) return { body: [] }
      if (call.url.includes('/agents')) return { body: { agents: [], default_agent: null } }
      return { body: {} }
    })
    const container = await render()

    await click(byTestId(container, 'ssh-keys-add'))
    await typeInto(byTestId(container, 'ssh-key-name'), 'deploy')
    await typeInto(byTestId(container, 'ssh-key-private'), 'PRIVATE')
    // Включаем «SSH» в назначении ключа.
    await click(byTestId(container, 'ssh-key-usage-ssh'))
    await click(byTestId(container, 'ssh-key-save'))

    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/ssh-keys'))
    expect(post).toBeDefined()
    expect(post?.body).toContain('"ssh"')
    expect(post?.body).toContain('"usages"')
  })

  it('ключ с usage ssh без привязки к агенту показывает предупреждение', async () => {
    stubFetch((call) => {
      if (call.url.includes('/settings/ssh')) return { body: SETTINGS_TOOLS }
      if (call.url.includes('/ssh-keys')) return { body: [] }
      if (call.url.includes('/agents')) return { body: { agents: [], default_agent: null } }
      return { body: {} }
    })
    const container = await render()

    await click(byTestId(container, 'ssh-keys-add'))
    expect(byTestId(container, 'ssh-key-ssh-without-agent')).toBeNull()
    await click(byTestId(container, 'ssh-key-usage-ssh'))
    expect(byTestId(container, 'ssh-key-ssh-without-agent')).not.toBeNull()
  })

  it('без выбранного назначения ключ сохранить нельзя (кнопка заблокирована)', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'POST') return { status: 201, body: { id: 'k1' } }
      if (call.url.includes('/settings/ssh')) return { body: SETTINGS_TOOLS }
      if (call.url.includes('/ssh-keys')) return { body: [] }
      if (call.url.includes('/agents')) return { body: { agents: [], default_agent: null } }
      return { body: {} }
    })
    const container = await render()

    await click(byTestId(container, 'ssh-keys-add'))
    await typeInto(byTestId(container, 'ssh-key-name'), 'deploy')
    await typeInto(byTestId(container, 'ssh-key-private'), 'PRIVATE')
    // Снимаем единственное назначение («Git») — ключ становится бесполезным.
    await click(byTestId(container, 'ssh-key-usage-git'))

    expect(byTestId(container, 'ssh-key-usages-required')).not.toBeNull()
    expect((byTestId(container, 'ssh-key-save') as HTMLButtonElement | null)?.disabled).toBe(true)

    await click(byTestId(container, 'ssh-key-save'))
    expect(calls.find((c) => c.method === 'POST' && c.url.includes('/ssh-keys'))).toBeUndefined()
  })
})
