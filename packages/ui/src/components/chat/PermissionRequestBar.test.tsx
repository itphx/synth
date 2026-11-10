import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import type { PermissionPreview } from '@itphx/synth-shared/types'

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
}))

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { PermissionRequestBar } from './PermissionRequestBar'
import { usePermissionStore, type PermissionTrigger } from '@/stores/permissionStore'
import { useTransportStore } from '@/stores/transportStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SESSION_ID = 's1'

function makePreview(diff: string, path = 'a.txt'): PermissionPreview {
  return {
    files: [
      {
        path,
        diff,
        additions: diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
        deletions: diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
      },
    ],
  }
}

function addRequest(preview?: PermissionPreview): void {
  usePermissionStore.getState().addRequest(SESSION_ID, {
    approvalId: 'approval_1',
    toolName: 'write_file',
    params: { file_path: 'a.txt', content: 'new' },
    reason: 'правило file.* → ask',
    askedAt: new Date().toISOString(),
    timeoutMs: 30_000,
    ...(preview ? { preview } : {}),
  })
}

function addShellRequest(save: string[]): void {
  usePermissionStore.getState().addRequest(SESSION_ID, {
    approvalId: 'approval_shell',
    toolName: 'execute_shell',
    params: { command: 'ansible-playbook site.yml' },
    reason: 'правило shell.* → ask',
    askedAt: new Date().toISOString(),
    timeoutMs: 30_000,
    save,
  })
}

/** Запрос с структурной причиной ask'а (`trigger`) — как шлёт новое ядро. */
function addTriggerRequest(trigger: PermissionTrigger, overrides: {
  toolName?: string
  params?: Record<string, unknown>
  reason?: string
} = {}): void {
  usePermissionStore.getState().addRequest(SESSION_ID, {
    approvalId: 'approval_trigger',
    toolName: overrides.toolName ?? 'execute_shell',
    params: overrides.params ?? { command: 'cat ~/.ssh/config' },
    reason: overrides.reason
      ?? 'Permission required: The path <$STUB_LOG> requires confirmation according to the protected-paths policy. Do not repeat the call, choose another way, or explain it to the user.',
    askedAt: new Date().toISOString(),
    timeoutMs: 30_000,
    trigger,
  })
}

/**
 * Восстановленное после рестарта инстанса ожидание (ADR-029): живой waiter'а
 * нет, ответ применяется как разрешение в сессии.
 */
function addRestoredRequest(): void {
  usePermissionStore.getState().addRequest(SESSION_ID, {
    approvalId: 'approval_restored',
    toolName: 'execute_shell',
    params: { command: 'ls -la' },
    reason: 'правило shell.* → ask',
    askedAt: new Date().toISOString(),
    timeoutMs: 0,
    held: true,
    restored: true,
  })
}

/** Клик по кнопке «Подробнее» (шапка полосы). */
async function expandBar(container: HTMLElement): Promise<void> {
  const toggle = container.querySelector('button[title="Подробнее"]')
  await act(async () => {
    toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function renderBar(sessionId = SESSION_ID): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <PermissionRequestBar sessionId={sessionId} />
      </I18nProvider>,
    )
  })
  return container
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  usePermissionStore.setState({ requestsBySession: {} })
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('PermissionRequestBar — превью изменений', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('без превью блок превью не рендерится', async () => {
    addRequest()
    const container = await renderBar()
    expect(container.querySelector('[data-testid="permission-preview"]')).toBeNull()
  })

  it('с превью показывает путь файла, счётчики и строки диффа', async () => {
    addRequest(
      makePreview('--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-one\n+uno\n two'),
    )
    const container = await renderBar()

    const preview = container.querySelector('[data-testid="permission-preview"]')
    expect(preview).not.toBeNull()
    expect(preview!.textContent).toContain('a.txt')
    expect(preview!.textContent).toContain('+1')
    expect(preview!.textContent).toContain('−1')
    expect(preview!.textContent).toContain('-one')
    expect(preview!.textContent).toContain('+uno')
  })

  it('дифф длиннее 40 строк обрезается, остаток — счётчиком', async () => {
    const lines = ['--- a/a.txt', '+++ b/a.txt']
    for (let i = 0; i < 60; i++) lines.push(`+строка ${i}`)
    addRequest(makePreview(lines.join('\n')))
    const container = await renderBar()

    const preview = container.querySelector('[data-testid="permission-preview"]')!
    expect(preview.textContent).toContain('+строка 0')
    // 62 строки диффа, показаны 40 → остаток 22.
    expect(preview.textContent).toContain('Ещё 22')
    expect(preview.textContent).not.toContain('+строка 41')
  })

  it('файл превью сворачивается и разворачивается', async () => {
    addRequest(makePreview('--- a/a.txt\n+++ b/a.txt\n+uno'))
    const container = await renderBar()

    const preview = container.querySelector('[data-testid="permission-preview"]')!
    const toggle = preview.querySelector('button')!
    expect(preview.textContent).toContain('+uno')

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(preview.textContent).not.toContain('+uno')

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(preview.textContent).toContain('+uno')
  })
})

describe('PermissionRequestBar — сессионный shell-грант паттернами', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('запрос с save показывает паттерны, которые разрешит «Разрешить в сессии»', async () => {
    addShellRequest(['ansible *', 'cd *'])
    const container = await renderBar()

    const row = container.querySelector('[data-testid="permission-save-patterns"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('ansible *')
    expect(row!.textContent).toContain('cd *')
  })

  it('без save строка паттернов не рендерится', async () => {
    addRequest()
    const container = await renderBar()
    expect(container.querySelector('[data-testid="permission-save-patterns"]')).toBeNull()
  })

  it('save: [] (паттерн не выводится) — кнопки «Разрешить в сессии» нет, есть подсказка', async () => {
    addShellRequest([])
    const container = await renderBar()

    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).not.toContain('Разрешить в сессии')
    expect(labels).toContain('Разрешить один раз')
    expect(labels).toContain('Запретить')

    const hint = container.querySelector('[data-testid="permission-save-unavailable"]')
    expect(hint).not.toBeNull()
    expect(hint!.getAttribute('title')).toContain('Паттерн команды не выводится')
  })

  it('save с паттернами — кнопка «Разрешить в сессии» на месте', async () => {
    addShellRequest(['git status *'])
    const container = await renderBar()

    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).toContain('Разрешить в сессии')
    expect(container.querySelector('[data-testid="permission-save-unavailable"]')).toBeNull()
  })

  it('«Разрешить в сессии» отвечает once:false и показывает shell-тост с паттернами', async () => {
    addShellRequest(['ansible *', 'cd *'])
    const reply = vi
      .spyOn(useTransportStore.getState(), 'sendPermissionReply')
      .mockResolvedValue(true)
    const container = await renderBar()

    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Разрешить в сессии',
    )
    expect(button, 'кнопка «Разрешить в сессии»').toBeTruthy()

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(reply).toHaveBeenCalledWith(SESSION_ID, 'approval_shell', true, false)
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    const toast = mocks.notify.mock.calls[0]![0] as { text: string; type: string }
    expect(toast.type).toBe('success')
    expect(toast.text).toContain('Shell разрешён в сессии')
    expect(toast.text).toContain('`ansible *`')
    expect(toast.text).toContain('`cd *`')
  })
})

/**
 * Человеческая причина вместо LLM-текста: ядро присылает структурный
 * «виновник» (`trigger`), UI строит из него понятную фразу и подсвечивает
 * подозрительный участок.
 */
describe('PermissionRequestBar — человеческая причина (trigger)', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('защищённый путь: показывает «Защищённый путь» и подсвечивает токен', async () => {
    addTriggerRequest({
      messageId: 'ask-protected-path',
      params: { path: '/home/rdv/.ssh/config' },
      matchedRule: 'shell-policy.approve',
      askKind: 'protected',
    })
    const container = await renderBar()

    const cause = container.querySelector('[data-testid="permission-cause"]')!
    expect(cause.textContent).toContain('Что вызвало вопрос')
    expect(cause.textContent).toContain('Защищённый путь')
    expect(cause.textContent).toContain('/home/rdv/.ssh/config')

    // Токен-виновник подсвечен.
    const hl = cause.querySelectorAll('[data-testid="permission-highlight"]')
    expect(hl.length).toBeGreaterThan(0)
    expect([...hl].map((s) => s.textContent)).toContain('/home/rdv/.ssh/config')
  })

  it('динамический путь: «значение вычисляется в рантайме»', async () => {
    addTriggerRequest({
      messageId: 'ask-protected-path',
      params: { path: '$HOME/.ssh/config' },
      askKind: 'dynamic',
    })
    const container = await renderBar()

    const cause = container.querySelector('[data-testid="permission-cause"]')!
    expect(cause.textContent).toContain('Не удалось проверить путь')
    expect(cause.textContent).toContain('$HOME/.ssh/config')
  })

  it('мутация вне рабочего каталога', async () => {
    addTriggerRequest({
      messageId: 'ask-protected-path',
      params: { path: '/etc/hosts' },
      askKind: 'mutation',
    })
    const container = await renderBar()

    const cause = container.querySelector('[data-testid="permission-cause"]')!
    expect(cause.textContent).toContain('Изменение вне рабочего каталога')
    expect(cause.textContent).toContain('/etc/hosts')
  })

  it('неразрешённый рабочий каталог', async () => {
    addTriggerRequest({
      messageId: 'ask-protected-path',
      params: { path: '/var/tmp' },
      askKind: 'cwd',
    })
    const container = await renderBar()

    const cause = container.querySelector('[data-testid="permission-cause"]')!
    expect(cause.textContent).toContain('Не удалось проверить рабочий каталог')
    expect(cause.textContent).toContain('/var/tmp')
  })

  it('динамический код: подсвечивается код', async () => {
    addTriggerRequest({
      messageId: 'ask-dynamic-code',
      params: { code: '$(cat payload.sh)' },
      askKind: 'dynamic',
    })
    const container = await renderBar()

    const cause = container.querySelector('[data-testid="permission-cause"]')!
    expect(cause.textContent).toContain('Код передаётся из переменной')
    expect(cause.textContent).toContain('$(cat payload.sh)')

    const hl = [...cause.querySelectorAll('[data-testid="permission-highlight"]')]
    expect(hl.map((s) => s.textContent)).toContain('$(cat payload.sh)')
  })

  it('динамическая команда: подсвечивается имя команды', async () => {
    addTriggerRequest({
      messageId: 'ask-dynamic-command',
      params: { command: '$CMD' },
      askKind: 'dynamic',
    })
    const container = await renderBar()

    const cause = container.querySelector('[data-testid="permission-cause"]')!
    expect(cause.textContent).toContain('Имя команды вычисляется динамически')
    expect(cause.textContent).toContain('$CMD')
  })

  it('сработавшее правило: называем правило', async () => {
    addTriggerRequest({
      matchedRule: 'shell-policy.approve',
      params: { command: 'cat ~/.ssh/config' },
    })
    const container = await renderBar()

    const cause = container.querySelector('[data-testid="permission-cause"]')!
    expect(cause.textContent).toContain('Сработало правило')
    expect(cause.textContent).toContain('shell-policy.approve')
  })

  it('при trigger есть прежний LLM-текст reason по умолчанию не виден', async () => {
    addTriggerRequest({
      messageId: 'ask-protected-path',
      params: { path: '/home/rdv/.ssh/config' },
      matchedRule: 'shell-policy.approve',
      askKind: 'protected',
    })
    const container = await renderBar()

    expect(container.textContent).not.toContain('Do not repeat the call')
    expect(container.textContent).not.toContain('protected-paths policy')

    // Но он доступен в «Технических деталях» (свёрнутый блок).
    const toggle = container.querySelector('[data-testid="permission-technical-toggle"]')!
    expect(toggle).not.toBeNull()
    expect(container.querySelector('[data-testid="permission-technical"]')).toBeNull()

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const technical = container.querySelector('[data-testid="permission-technical"]')!
    expect(technical.textContent).toContain('Do not repeat the call')
    expect(technical.textContent).toContain('shell-policy.approve')
    expect(technical.textContent).toContain('ask-protected-path')
  })

  it('без trigger показывается прежний текст reason (fallback старого сервера)', async () => {
    usePermissionStore.getState().addRequest(SESSION_ID, {
      approvalId: 'approval_legacy',
      toolName: 'execute_shell',
      params: { command: 'cat ~/.ssh/config' },
      reason: 'Permission required: protected-paths policy.',
      askedAt: new Date().toISOString(),
      timeoutMs: 30_000,
    })
    const container = await renderBar()

    expect(container.textContent).toContain('Причина')
    expect(container.textContent).toContain('protected-paths policy.')
    // Без trigger блока «Технические детали» нет — прятать нечего.
    expect(container.querySelector('[data-testid="permission-technical-toggle"]')).toBeNull()
  })
})

describe('PermissionRequestBar — подсветка подозрительного участка', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('токен-виновник подсвечен в значении command', async () => {
    addTriggerRequest(
      {
        messageId: 'ask-protected-path',
        params: { path: '/home/rdv/.ssh/config' },
        askKind: 'protected',
      },
      { params: { command: 'cat /home/rdv/.ssh/config' } },
    )
    const container = await renderBar()
    await expandBar(container)

    const command = container.querySelector('[data-testid="permission-command"]')!
    expect(command.textContent).toContain('cat /home/rdv/.ssh/config')

    const hl = [...command.querySelectorAll('[data-testid="permission-highlight"]')]
    expect(hl.map((s) => s.textContent)).toContain('/home/rdv/.ssh/config')
  })

  it('путь нормализован в абсолютный — ищем по basename', async () => {
    addTriggerRequest(
      {
        messageId: 'ask-protected-path',
        params: { path: '/home/rdv/.ssh/config' },
        askKind: 'protected',
      },
      { params: { command: 'cat ~/.ssh/config' } },
    )
    const container = await renderBar()
    await expandBar(container)

    const command = container.querySelector('[data-testid="permission-command"]')!
    const hl = [...command.querySelectorAll('[data-testid="permission-highlight"]')]
    expect(hl.length).toBeGreaterThan(0)
    expect(hl.map((s) => s.textContent).join('')).toContain('config')
  })

  it('токен не найден в команде — блок не пустой, токен показан строкой', async () => {
    addTriggerRequest(
      {
        messageId: 'ask-protected-path',
        params: { path: '/home/rdv/.ssh/config' },
        askKind: 'protected',
      },
      { params: { command: 'cat /tmp/other' } },
    )
    const container = await renderBar()
    await expandBar(container)

    const command = container.querySelector('[data-testid="permission-command"]')!
    expect(command.textContent).toContain('cat /tmp/other')
    expect(command.querySelectorAll('[data-testid="permission-highlight"]').length).toBe(0)

    const suspicious = container.querySelector('[data-testid="permission-suspicious-in-command"]')!
    expect(suspicious.textContent).toContain('Подозрительный участок')
    expect(suspicious.textContent).toContain('/home/rdv/.ssh/config')
  })

  it('команда — отдельным блоком, остальные параметры — списком «ключ: значение»', async () => {
    addTriggerRequest(
      {
        messageId: 'ask-protected-path',
        params: { path: '/home/rdv/.ssh/config' },
        askKind: 'protected',
      },
      { params: { command: 'cat /home/rdv/.ssh/config', cwd: '/home/rdv' } },
    )
    const container = await renderBar()
    await expandBar(container)

    const command = container.querySelector('[data-testid="permission-command"]')!
    expect(command.textContent).toContain('cat /home/rdv/.ssh/config')

    const params = container.querySelector('[data-testid="permission-params"]')!
    expect(params.textContent).toContain('cwd')
    expect(params.textContent).toContain('/home/rdv')
    // Команда не дублируется в списке параметров.
    expect(params.textContent).not.toContain('cat /home/rdv/.ssh/config')
  })
})

/**
 * ADR-029: восстановленное после рестарта инстанса ожидание.
 *
 * Живой waiter'а после рестарта нет — ответ применяется как разрешение в
 * сессии. Карточка помечается короткой пометкой; сама карточка, блок «Что
 * вызвало вопрос» и подсветка — как обычно.
 */
describe('PermissionRequestBar — восстановленное ожидание (после рестарта)', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('показывает пометку о перезапуске инстанса', async () => {
    addRestoredRequest()
    const container = await renderBar()

    const note = container.querySelector('[data-testid="permission-restored"]')
    expect(note).not.toBeNull()
    expect(note!.textContent).toContain('Инстанс был перезапущен')
  })

  it('у обычного ожидания пометки нет', async () => {
    addRequest()
    const container = await renderBar()

    expect(container.querySelector('[data-testid="permission-restored"]')).toBeNull()
  })

  it('карточка и кнопки ответа — как обычно (пометка не меняет поведение)', async () => {
    addRestoredRequest()
    const reply = vi
      .spyOn(useTransportStore.getState(), 'sendPermissionReply')
      .mockResolvedValue(true)
    const container = await renderBar()

    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).toContain('Разрешить один раз')
    expect(labels).toContain('Запретить')

    const deny = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Запретить',
    )!
    await act(async () => {
      deny.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(reply).toHaveBeenCalledWith(SESSION_ID, 'approval_restored', false, undefined)
  })
})
