import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  listSshKeys: vi.fn(),
  createSshKey: vi.fn(),
  updateSshKey: vi.fn(),
  deleteSshKey: vi.fn(),
  getAllAgents: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SshKeysSettings } from './SshKeysSettings'
import type { AgentInfo, SSHKeyMetaData } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function agent(id: string, name: string): AgentInfo {
  return {
    id,
    display_name: name,
    capabilities: [],
    enabled: true,
    icon: null,
    color: null,
    description: null,
    available: true,
    mode: 'simple',
    agent_mode: ['primary'],
    reasoning_level: null,
    subagent_prompt: null,
    max_steps: 0,
    provider: null,
    model: null,
    context_file: null,
    is_builtin: false,
    is_overridden: false,
  }
}

function key(id: string, overrides: Partial<SSHKeyMetaData> = {}): SSHKeyMetaData {
  return {
    id,
    name: id,
    type: 'user',
    agentIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SshKeysSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listSshKeys.mockResolvedValue([])
  mocks.getAllAgents.mockResolvedValue({ agents: [agent('a1', 'Agent One')], default_agent: null })
  mocks.createSshKey.mockImplementation(async (body: unknown) => ({ ...(body as object), id: 'new' }))
  mocks.updateSshKey.mockImplementation(async (id: string, body: object) => ({ ...body, id }))
  mocks.deleteSshKey.mockResolvedValue(undefined)
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

describe('SshKeysSettings — CRUD SSH-ключей (AD-076)', () => {
  it('создание шлёт name/privateKey/agentIds через createSshKey', async () => {
    const container = await renderSettings()

    await act(async () => {
      (container.querySelector('[data-testid="ssh-keys-add"]') as HTMLButtonElement).click()
    })

    const name = container.querySelector('[data-testid="ssh-key-name"]') as HTMLInputElement
    const privateKey = container.querySelector('[data-testid="ssh-key-private"]') as HTMLTextAreaElement
    const agentBox = container.querySelector('[data-testid="ssh-key-agent-a1"]') as HTMLInputElement
    await act(async () => {
      setInputValue(name, 'deploy-key')
      setInputValue(privateKey, 'KEY-BODY')
      agentBox.click()
    })

    await act(async () => {
      (container.querySelector('[data-testid="ssh-key-save"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.createSshKey).toHaveBeenCalledTimes(1)
    expect(mocks.createSshKey).toHaveBeenCalledWith({
      name: 'deploy-key',
      agentIds: ['a1'],
      privateKey: 'KEY-BODY',
      passphrase: undefined,
    })
  })

  it('создание без имени/ключа не вызывает API и показывает ошибки', async () => {
    const container = await renderSettings()
    await act(async () => {
      (container.querySelector('[data-testid="ssh-keys-add"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      (container.querySelector('[data-testid="ssh-key-save"]') as HTMLButtonElement).click()
    })

    expect(mocks.createSshKey).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Name is required')
    expect(container.textContent).toContain('Private key is required')
  })

  it('редактирование без privateKey не отправляет секрет', async () => {
    mocks.listSshKeys.mockResolvedValue([key('k1', { name: 'old-name', agentIds: ['a1'] })])
    const container = await renderSettings()

    await act(async () => {
      (container.querySelector('[data-testid="ssh-key-edit-k1"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    const name = container.querySelector('[data-testid="ssh-key-name"]') as HTMLInputElement
    await act(async () => {
      setInputValue(name, 'renamed')
    })
    await act(async () => {
      (container.querySelector('[data-testid="ssh-key-save"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.updateSshKey).toHaveBeenCalledTimes(1)
    const [id, body] = mocks.updateSshKey.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('k1')
    expect(body.name).toBe('renamed')
    expect(body).not.toHaveProperty('privateKey')
  })

  it('редактирование с заполненным privateKey заменяет секрет', async () => {
    mocks.listSshKeys.mockResolvedValue([key('k1')])
    const container = await renderSettings()

    await act(async () => {
      (container.querySelector('[data-testid="ssh-key-edit-k1"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    const privateKey = container.querySelector('[data-testid="ssh-key-private"]') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(privateKey, 'NEW-KEY')
    })
    await act(async () => {
      (container.querySelector('[data-testid="ssh-key-save"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    const [id, body] = mocks.updateSshKey.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('k1')
    expect(body.privateKey).toBe('NEW-KEY')
  })

  it('ошибка sshkey.name_exists показывается пользователю', async () => {
    mocks.createSshKey.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: 'sshkey.name_exists' }),
    )
    const container = await renderSettings()

    await act(async () => {
      (container.querySelector('[data-testid="ssh-keys-add"]') as HTMLButtonElement).click()
    })
    const name = container.querySelector('[data-testid="ssh-key-name"]') as HTMLInputElement
    const privateKey = container.querySelector('[data-testid="ssh-key-private"]') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(name, 'dup')
      setInputValue(privateKey, 'KEY')
    })
    await act(async () => {
      (container.querySelector('[data-testid="ssh-key-save"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(container.textContent).toContain('already exists')
    expect(container.textContent).toContain('dup')
  })

  it('удаление подтверждается через ConfirmDialog и вызывает deleteSshKey', async () => {
    mocks.listSshKeys.mockResolvedValue([key('k1', { name: 'deploy', agentIds: ['a1'] })])
    const container = await renderSettings()

    await act(async () => {
      (container.querySelector('[data-testid="ssh-key-delete-k1"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    // Показываем привязанных агентов в подтверждении.
    expect(document.body.textContent).toContain('Agent One')

    const confirm = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Delete',
    ) as HTMLButtonElement | undefined
    expect(confirm).toBeTruthy()
    await act(async () => {
      confirm!.click()
    })
    await act(async () => {})

    expect(mocks.deleteSshKey).toHaveBeenCalledWith('k1')
  })

  it('список не содержит privateKey даже если он присутствует в ответе', async () => {
    mocks.listSshKeys.mockResolvedValue([
      { ...key('k1', { name: 'deploy' }), privateKey: 'SUPERSECRET' } as unknown as SSHKeyMetaData,
    ])
    const container = await renderSettings()

    expect(container.textContent).toContain('deploy')
    expect(container.textContent).not.toContain('SUPERSECRET')
  })
})
