import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getCommands: vi.fn(),
  getSkills: vi.fn(),
  listSnippets: vi.fn(),
  listSessionScripts: vi.fn(),
  getSession: vi.fn(),
  listDirectory: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onCreateNote: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getCommands: mocks.getCommands,
    getSkills: mocks.getSkills,
    listSnippets: mocks.listSnippets,
    listSessionScripts: mocks.listSessionScripts,
    getSession: mocks.getSession,
    listDirectory: mocks.listDirectory,
  },
}))
vi.mock('@/hooks/useDevice', () => ({ useDevice: () => ({ isTouch: false, deviceType: 'desktop' }) }))
vi.mock('../ui/OverlayScrollbar', () => ({ OverlayScrollbar: () => null }))
vi.mock('./ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./AgentModeSelector', () => ({ AgentModeSelector: () => null }))
vi.mock('./PlanActModeToggle', () => ({ PlanActModeToggle: () => null }))
vi.mock('./ReasoningLevelSelector', () => ({ ReasoningLevelSelector: () => null }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatInput, splitMessageWithTags } from './ChatInput'
import type { AgentInfo } from '@/lib/api/synthApi'
import type { Snippet } from '@/lib/api/synthApi'
import type { SkillSummary, ScriptSummary, SteerMode } from '@itphx/synth-shared/types'
import { useChatStore } from '@/stores/chatStore'
import { useComposerDraftsStore } from '@/stores/composerDraftsStore'
import { useSkillsStore } from '@/stores/skillsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Скилл реестра (`GET /api/v2/skills`) — источник `$`-пикера. */
const SKILL: SkillSummary = {
  name: 'api-review',
  description: 'Review API changes',
  scope: 'instance',
  level: 'system',
  dir: '/skills/api-review',
  invocation: 'both',
  userInvocable: true,
  modelInvocable: true,
  tags: [],
  agents: [],
  groups: [],
  requiresCapabilities: [],
  trusted: true,
  available: true,
}

/** Сниппет реестра (`GET /api/v2/snippets`) — источник `#`-пикера. */
const SNIPPET: Snippet = {
  name: 'api-review',
  description: 'Review API changes',
  aliases: [],
  body: 'Проверь дифф',
  scope: 'instance',
  file: '/snippets/api-review.md',
  trusted: true,
}

/** Скрипт реестра (`GET /api/v2/sessions/:id/scripts`) — источник `!`-пикера. */
const SCRIPT: ScriptSummary = {
  name: 'dev',
  description: 'Поднять backend и UI',
  origin: 'project',
  available: true,
  trusted: true,
}

async function renderInput(props?: {
  sendMode?: SteerMode
  isStreaming?: boolean
  agents?: AgentInfo[]
}): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChatInput
          sessionId="s1"
          agents={props?.agents ?? []}
          isStreaming={props?.isStreaming ?? false}
          onSend={mocks.onSend}
          sendMode={props?.sendMode}
          onStop={mocks.onStop}
          onCreateNote={mocks.onCreateNote}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommands.mockResolvedValue({
    commands: [{ name: 'help', kind: 'builtin', description: 'Show help', available: true }],
    diagnostics: [],
  })
  mocks.getSkills.mockResolvedValue({ skills: [SKILL], diagnostics: [] })
  mocks.listSnippets.mockResolvedValue({ snippets: [SNIPPET], diagnostics: [] })
  mocks.listSessionScripts.mockResolvedValue({ scripts: [SCRIPT], diagnostics: [] })
  // Снимок сессии — источник участников (`@user`) и проекта (`@file`).
  mocks.getSession.mockResolvedValue({
    id: 's1',
    name: 'Session',
    user_id: 'u1',
    owner_id: 'u1',
    project_id: 'p1',
    participants: [{ user_id: 'alice', role: 'owner' }],
  })
  mocks.listDirectory.mockResolvedValue({
    path: '',
    entries: [
      { name: 'readme.md', path: 'readme.md', isDirectory: false },
      { name: 'src', path: 'src', isDirectory: true },
      { name: 'index.ts', path: 'src/index.ts', isDirectory: false },
    ],
  })
  useChatStore.setState({ retryInputBySession: {} })
  useComposerDraftsStore.setState({ textBySession: {} })
  useSkillsStore.setState({
    commands: null,
    commandsLoading: false,
    commandsError: null,
    skills: [SKILL],
    skillsLoading: false,
    skillsError: null,
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
  vi.clearAllMocks()
})

describe('ChatInput — `/`-автокомплит (ADR-126 §7)', () => {
  it('открывается на `/`, а выбор подставляет `/name ` без отправки', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="command-autocomplete"]')).not.toBeNull()
    const item = container.querySelector('[data-testid="command-autocomplete-item-help"]') as HTMLButtonElement
    expect(item).not.toBeNull()

    await act(async () => {
      item.click()
    })

    expect(textarea.value).toBe('/help ')
    expect(container.querySelector('[data-testid="command-autocomplete"]')).toBeNull()
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('Enter при открытом непустом списке не отправляет сообщение', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('после подстановки обычный Enter отправляет команду в core', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})
    await act(async () => {
      (container.querySelector('[data-testid="command-autocomplete-item-help"]') as HTMLButtonElement).click()
    })

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(mocks.onSend).toHaveBeenCalledWith('/help', undefined, undefined, undefined)
  })

  it('после подстановки Enter режим из пропа уходит третьим аргументом onSend (ADR-104)', async () => {
    const container = await renderInput({ sendMode: 'steer' })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})
    await act(async () => {
      (container.querySelector('[data-testid="command-autocomplete-item-help"]') as HTMLButtonElement).click()
    })

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(mocks.onSend).toHaveBeenCalledWith('/help', undefined, 'steer', undefined)
  })

  it('«Добавить в очередь» во время стрима передаёт тот же контракт onSend (ADR-104)', async () => {
    const container = await renderInput({ isStreaming: true, sendMode: 'queue' })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '/help ')
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(mocks.onSend).toHaveBeenCalledWith('/help', undefined, 'queue', undefined)
  })

  it('поповер имеет фиксированный зазор над рамкой композера (не зависит от высоты textarea)', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})

    const popup = container.querySelector('[data-testid="command-autocomplete"]') as HTMLElement
    expect(popup).not.toBeNull()
    // CSS-позиционирование от якоря: 9px до рамки композера + 8px зазора.
    expect(popup.style.bottom).toBe('calc(100% + 17px)')
  })
})

describe('ChatInput — `$`-пикер скиллов (ADR-126 §3)', () => {
  it('открывается на `$`, а выбор подставляет `$name ` без отправки', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '$')
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="skill-autocomplete"]')).not.toBeNull()
    const item = container.querySelector(
      '[data-testid="skill-autocomplete-item-api-review"]',
    ) as HTMLButtonElement
    expect(item).not.toBeNull()

    await act(async () => {
      item.click()
    })

    expect(textarea.value).toBe('$api-review ')
    expect(container.querySelector('[data-testid="skill-autocomplete"]')).toBeNull()
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('поиск идёт по имени и описанию скилла', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '$review')
    })
    await act(async () => {})

    expect(
      container.querySelector('[data-testid="skill-autocomplete-item-api-review"]'),
    ).not.toBeNull()

    await act(async () => {
      setTextareaValue(textarea, '$нет-такого')
    })
    await act(async () => {})

    // Пустой список — пикер не рисуется.
    expect(container.querySelector('[data-testid="skill-autocomplete"]')).toBeNull()
  })

  it('Enter при открытом непустом списке не отправляет сообщение', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '$')
    })
    await act(async () => {})

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('после подстановки обычный Enter отправляет сообщение со скиллом', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '$')
    })
    await act(async () => {})
    await act(async () => {
      (container.querySelector(
        '[data-testid="skill-autocomplete-item-api-review"]',
      ) as HTMLButtonElement).click()
    })

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // Отправляется обрезанный текст (как у `/`-команды: `/help ` → `/help`).
    expect(mocks.onSend).toHaveBeenCalledWith('$api-review', undefined, undefined, undefined)
  })

  it('`$5` (цена) не открывает пикер', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, 'цена $5')
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="skill-autocomplete"]')).toBeNull()
    expect(textarea.value).toBe('цена $5')
  })

  it('`$` внутри код-блока не открывает пикер', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '```bash\necho $')
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="skill-autocomplete"]')).toBeNull()
  })

  it('`@` и `/` не открывают `$`-пикер (нет регрессии)', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '@lead')
    })
    await act(async () => {})
    expect(container.querySelector('[data-testid="skill-autocomplete"]')).toBeNull()

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})
    expect(container.querySelector('[data-testid="command-autocomplete"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="skill-autocomplete"]')).toBeNull()
  })

  it('скилл-команда из `/`-реестра (`kind: skill`) в `$`-пикер не попадает', async () => {
    // ADR-126 §7: источник `$`-пикера — только реестр скиллов; `/`-реестр
    // команд скиллов не содержит и вторым источником не служит.
    //
    // Реестр скиллов пикер перечитывает на монтировании (живое обновление по
    // событию `skills.updated`), поэтому пустой ответ мока — это и есть
    // «в реестре скиллов ничего нет»: подмешай пикер команды `kind: 'skill'`,
    // и `docs-helper` появился бы вопреки пустому реестру.
    mocks.getSkills.mockResolvedValue({ skills: [], diagnostics: [] })
    useSkillsStore.setState({
      skills: [],
      commands: [
        { name: 'help', kind: 'builtin', description: 'Show help', available: true },
        { name: 'docs-helper', kind: 'skill', description: 'Docs helper', available: true },
      ],
    })
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '$')
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="skill-autocomplete"]')).toBeNull()
  })
})

describe('ChatInput — `#`-пикер сниппетов (ADR-126 §4)', () => {
  it('открывается на `#`, а выбор подставляет `#name ` без отправки', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '#')
    })
    await act(async () => {})
    await act(async () => {})

    expect(container.querySelector('[data-testid="snippet-autocomplete"]')).not.toBeNull()
    const item = container.querySelector(
      '[data-testid="snippet-autocomplete-item-api-review"]',
    ) as HTMLButtonElement
    expect(item).not.toBeNull()

    await act(async () => {
      item.click()
    })

    expect(textarea.value).toBe('#api-review ')
    expect(container.querySelector('[data-testid="snippet-autocomplete"]')).toBeNull()
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('поиск идёт по имени и описанию сниппета', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '#review')
    })
    await act(async () => {})
    await act(async () => {})

    expect(
      container.querySelector('[data-testid="snippet-autocomplete-item-api-review"]'),
    ).not.toBeNull()

    await act(async () => {
      setTextareaValue(textarea, '#нет-такого')
    })
    await act(async () => {})
    await act(async () => {})

    // Пустой список — пикер не рисуется.
    expect(container.querySelector('[data-testid="snippet-autocomplete"]')).toBeNull()
  })

  it('`##` (заголовок) и `# ` (пробел после `#`) не открывают пикер', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '##')
    })
    await act(async () => {})
    await act(async () => {})

    expect(container.querySelector('[data-testid="snippet-autocomplete"]')).toBeNull()

    await act(async () => {
      setTextareaValue(textarea, '# Заголовок')
    })
    await act(async () => {})
    await act(async () => {})

    expect(container.querySelector('[data-testid="snippet-autocomplete"]')).toBeNull()
  })

  it('`#` внутри код-блока не открывает пикер', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '```bash\necho #')
    })
    await act(async () => {})
    await act(async () => {})

    expect(container.querySelector('[data-testid="snippet-autocomplete"]')).toBeNull()
  })

  it('Enter при открытом непустом списке не отправляет сообщение', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '#')
    })
    await act(async () => {})
    await act(async () => {})

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('недоверенный сниппет помечен бейджем и не выбирается как доверенный', async () => {
    mocks.listSnippets.mockResolvedValue({
      snippets: [{ ...SNIPPET, name: 'project-note', scope: 'project', trusted: false }],
      diagnostics: [],
    })
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '#')
    })
    await act(async () => {})
    await act(async () => {})

    expect(
      container.querySelector('[data-testid="snippet-autocomplete-untrusted-project-note"]'),
    ).not.toBeNull()
  })

  it('`$`, `@` и `/` не открывают `#`-пикер (нет регрессии)', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '$')
    })
    await act(async () => {})
    await act(async () => {})
    expect(container.querySelector('[data-testid="skill-autocomplete"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="snippet-autocomplete"]')).toBeNull()

    await act(async () => {
      setTextareaValue(textarea, '@lead')
    })
    await act(async () => {})
    await act(async () => {})
    expect(container.querySelector('[data-testid="snippet-autocomplete"]')).toBeNull()

    await act(async () => {
      setTextareaValue(textarea, '/he')
    })
    await act(async () => {})
    await act(async () => {})
    expect(container.querySelector('[data-testid="command-autocomplete"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="snippet-autocomplete"]')).toBeNull()
  })
})

describe('ChatInput — `!`-пикер скриптов (ADR-126 §5)', () => {
  it('открывается на `!`, а выбор подставляет `!name ` без отправки', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '!')
    })
    await act(async () => {})
    await act(async () => {})

    expect(container.querySelector('[data-testid="script-autocomplete"]')).not.toBeNull()
    const item = container.querySelector(
      '[data-testid="script-autocomplete-item-dev"]',
    ) as HTMLButtonElement
    expect(item).not.toBeNull()

    await act(async () => {
      item.click()
    })

    expect(textarea.value).toBe('!dev ')
    expect(container.querySelector('[data-testid="script-autocomplete"]')).toBeNull()
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('`!` в середине текста пикер не открывает', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, 'запусти !dev')
    })
    await act(async () => {})
    await act(async () => {})

    expect(container.querySelector('[data-testid="script-autocomplete"]')).toBeNull()
  })

  it('Enter при открытом непустом списке скриптов не отправляет сообщение', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '!')
    })
    await act(async () => {})
    await act(async () => {})

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(mocks.onSend).not.toHaveBeenCalled()
  })
})

describe('ChatInput — `@`-пикер: агенты, пользователи, файлы (ADR-126 §2)', () => {
  it('`@` показывает секции «Агенты», «Пользователи», «Файлы»', async () => {
    const container = await renderInput({ agents: [makeAgent('leader')] })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '@')
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="mention-popup"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="mention-section-agents"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="mention-section-users"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="mention-section-files"]')).not.toBeNull()
    expect(
      container.querySelector('[data-mention-kind="agent"][data-mention-id="leader"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-mention-kind="user"][data-mention-id="alice"]'),
    ).not.toBeNull()
    // Каталоги в список файлов не попадают.
    expect(
      container.querySelector('[data-mention-kind="file"][data-mention-id="src"]'),
    ).toBeNull()
    expect(
      container.querySelector('[data-mention-kind="file"][data-mention-id="src/index.ts"]'),
    ).not.toBeNull()
  })

  it('выбор агента подставляет `@<id> ` без отправки', async () => {
    const container = await renderInput({ agents: [makeAgent('leader')] })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '@')
    })
    await act(async () => {})

    const item = container.querySelector(
      '[data-mention-kind="agent"][data-mention-id="leader"]',
    ) as HTMLButtonElement
    expect(item).not.toBeNull()

    await act(async () => {
      item.click()
    })

    expect(textarea.value).toBe('@leader ')
    expect(container.querySelector('[data-testid="mention-popup"]')).toBeNull()
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('выбор пользователя подставляет `@<user_id> `', async () => {
    const container = await renderInput({ agents: [makeAgent('leader')] })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '@')
    })
    await act(async () => {})

    const item = container.querySelector(
      '[data-mention-kind="user"][data-mention-id="alice"]',
    ) as HTMLButtonElement
    expect(item).not.toBeNull()

    await act(async () => {
      item.click()
    })

    expect(textarea.value).toBe('@alice ')
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('выбор файла подставляет `@<path> `', async () => {
    const container = await renderInput({ agents: [makeAgent('leader')] })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '@')
    })
    await act(async () => {})

    const item = container.querySelector(
      '[data-mention-kind="file"][data-mention-id="src/index.ts"]',
    ) as HTMLButtonElement
    expect(item).not.toBeNull()

    await act(async () => {
      item.click()
    })

    expect(textarea.value).toBe('@src/index.ts ')
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('фильтр по запросу оставляет только совпадения', async () => {
    const container = await renderInput({ agents: [makeAgent('leader')] })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '@ind')
    })
    await act(async () => {})

    expect(
      container.querySelector('[data-mention-kind="file"][data-mention-id="src/index.ts"]'),
    ).not.toBeNull()
    expect(container.querySelector('[data-mention-kind="agent"]')).toBeNull()
    expect(container.querySelector('[data-mention-kind="user"]')).toBeNull()
    expect(container.querySelector('[data-testid="mention-section-agents"]')).toBeNull()
  })

  it('Enter выбирает подсвеченный элемент общего списка', async () => {
    const container = await renderInput({ agents: [makeAgent('leader')] })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '@')
    })
    await act(async () => {})

    // Подсвечен первый элемент — агент; ArrowDown смещает на пользователя.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(textarea.value).toBe('@alice ')
    expect(mocks.onSend).not.toHaveBeenCalled()
  })

  it('ошибка листинга файлов не ломает пикер — агенты и пользователи на месте', async () => {
    mocks.listDirectory.mockRejectedValue(new Error('fs unavailable'))
    const container = await renderInput({ agents: [makeAgent('leader')] })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '@')
    })
    await act(async () => {})

    expect(
      container.querySelector('[data-mention-kind="agent"][data-mention-id="leader"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-mention-kind="user"][data-mention-id="alice"]'),
    ).not.toBeNull()
    expect(container.querySelector('[data-mention-kind="file"]')).toBeNull()
  })
})

describe('ChatInput — режим отправки при активном ходе (ADR-104)', () => {
  it('во время активного хода сообщение уходит в очередь (режим из пропа)', async () => {
    const container = await renderInput({ isStreaming: true, sendMode: 'queue' })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, 'дождись конца хода')
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(mocks.onSend).toHaveBeenCalledWith('дождись конца хода', undefined, 'queue', undefined)
    // `queue` отбрасывается API-слоем — поле `mode` в тело запроса не уходит
    // (`lib/api/sessions.ts`; покрыто в `lib/api/synthApi.sessions.test.ts`).
  })

  it('без активного хода режим в запрос не уходит', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, 'обычное сообщение')
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // Третьим аргументом `mode` не уходит — в теле запроса поля `mode` нет.
    // Четвёртый аргумент — id загруженных вложений (ADR-115); здесь их нет.
    expect(mocks.onSend).toHaveBeenCalledWith('обычное сообщение', undefined, undefined, undefined)
  })
})

function makeAgent(id: string, color: string | null = null): AgentInfo {
  return {
    id,
    display_name: id,
    capabilities: [],
    enabled: true,
    icon: null,
    color,
    description: null,
    available: true,
    mode: 'simple',
    agent_mode: null,
    max_steps: null,
    provider: null,
    model: null,
    context_file: null,
    is_builtin: true,
    is_overridden: false,
  }
}

describe('ChatInput — splitMessageWithTags: `@`-тег сохраняется в тексте', () => {
  const agents = [makeAgent('pm'), makeAgent('dev')]

  it('одиночный тег: `@pm` остаётся в тексте части', () => {
    expect(splitMessageWithTags('@pm сделай X', agents)).toEqual([
      { text: '@pm сделай X', agentRole: 'pm' },
    ])
  })

  it('группа подряд идущих тегов: каждый текст содержит свой тег', () => {
    expect(splitMessageWithTags('@pm @dev сделай X', agents)).toEqual([
      { text: '@pm сделай X', agentRole: 'pm' },
      { text: '@dev сделай X', agentRole: 'dev' },
    ])
  })

  it('текст до первого тега (commonPrefix) сохраняется вместе с тегом', () => {
    expect(splitMessageWithTags('привет @pm сделай X', agents)).toEqual([
      { text: 'привет @pm сделай X', agentRole: 'pm' },
    ])
  })

  it('неизвестный тег не распознаётся — возврат null (сообщение уходит как есть)', () => {
    expect(splitMessageWithTags('@nobody сделай X', agents)).toBeNull()
  })
})
