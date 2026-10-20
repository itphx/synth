import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import React, { act } from 'react'
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

import { I18nProvider } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { SettingsPanel } from './SettingsPanel'
import { SettingsSection } from './SettingsSection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderPanel(
  props: React.ComponentProps<typeof SettingsPanel>,
): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SettingsPanel {...props} />
      </I18nProvider>,
    )
  })
  return host
}

/** Заглушка matchMedia: телефон + coarse pointer, иначе — всё false (десктоп). */
function stubPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 768px)' || query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

function setScrollTop(el: HTMLElement, value: number) {
  Object.defineProperty(el, 'scrollTop', { value, writable: true, configurable: true })
}

beforeEach(() => {
  useUIStore.setState({ settingsShowAdvanced: false, settingsFocus: null })
})

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()
  }
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('SettingsPanel', () => {
  it('рендерит заголовок, описание, actions и контент', async () => {
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      actions: <button>ACTION</button>,
      children: <div>CONTENT</div>,
    })

    expect(host.querySelector('h2')?.textContent).toBe('Network')
    expect(host.textContent).toContain('Configure networking')
    expect(host.textContent).toContain('ACTION')
    expect(host.textContent).toContain('CONTENT')
  })

  it('без actions не рендерит кнопок', async () => {
    const host = await renderPanel({ title: 'Network', children: <div>CONTENT</div> })
    expect(host.querySelector('button')).toBeNull()
  })

  it('нет горизонтального скролла: контент центрирован max-w-3xl и min-w-0', async () => {
    const host = await renderPanel({ title: 'Network', children: <div>CONTENT</div> })
    expect(host.querySelector('.overflow-x-hidden')).not.toBeNull()
    expect(host.querySelector('.max-w-3xl')).not.toBeNull()
    expect(host.querySelector('.min-w-0')).not.toBeNull()
    expect(host.innerHTML).not.toContain('pr-2')
  })

  it('тело помечено settings-scroll-container', async () => {
    const host = await renderPanel({ title: 'Network', children: <div>CONTENT</div> })
    const body = host.querySelector('.settings-scroll-container')
    expect(body).not.toBeNull()
    expect(body!.classList.contains('overflow-y-auto')).toBe(true)
  })

  it('collapsibleHeader: на теле при скролле описание скрывается, наверх — разворачивается', async () => {
    stubPhone()
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      children: <div>CONTENT</div>,
    })
    const body = host.querySelector('.settings-scroll-container') as HTMLElement
    const desc = host.querySelector('[data-testid="settings-header-description"]') as HTMLElement
    expect(desc).not.toBeNull()
    expect(desc.classList.contains('grid-rows-[1fr]')).toBe(true)

    setScrollTop(body, 20)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    expect(desc.classList.contains('grid-rows-[0fr]')).toBe(true)
    expect(desc.classList.contains('opacity-0')).toBe(true)
    expect(body.getAttribute('data-scroll-shadow')).toBe('top')

    setScrollTop(body, 0)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    expect(desc.classList.contains('grid-rows-[1fr]')).toBe(true)
    expect(desc.classList.contains('opacity-100')).toBe(true)
    expect(body.hasAttribute('data-scroll-shadow')).toBe(false)
  })

  it('collapsibleHeader: сворачивание реально уменьшает высоту шапки (0fr + min-h-0/overflow-hidden)', async () => {
    stubPhone()
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      children: <div>CONTENT</div>,
    })
    const body = host.querySelector('.settings-scroll-container') as HTMLElement
    const desc = host.querySelector('[data-testid="settings-header-description"]') as HTMLElement
    // Без min-h-0/overflow-hidden строка grid не схлопывается ниже min-content,
    // поэтому визуально описание исчезает, а высота шапки не уменьшается.
    const text = desc.querySelector('p') as HTMLElement
    expect(text.classList.contains('min-h-0')).toBe(true)
    expect(text.classList.contains('overflow-hidden')).toBe(true)
    expect(desc.classList.contains('grid-rows-[1fr]')).toBe(true)

    setScrollTop(body, 20)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    // При схлопывании строка становится 0fr, а дочерний <p> — нулевой min-height.
    expect(desc.classList.contains('grid-rows-[0fr]')).toBe(true)
    expect(text.classList.contains('min-h-0')).toBe(true)
    expect(text.classList.contains('overflow-hidden')).toBe(true)
  })

  it('meta виден при сворачивании шапки, actions — под заголовком (телефон)', async () => {
    stubPhone()
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      meta: '2 servers',
      actions: <button>ACTION</button>,
      children: <div>CONTENT</div>,
    })

    const h2 = host.querySelector('h2') as HTMLElement
    const meta = host.querySelector('[data-testid="settings-header-meta"]') as HTMLElement
    const action = host.querySelector('button') as HTMLButtonElement
    expect(meta.textContent).toBe('2 servers')

    // На телефоне заголовок занимает отдельную строку, действия — ниже.
    const row = h2.parentElement as HTMLElement
    expect(row.classList.contains('flex')).toBe(true)
    expect(row.classList.contains('flex-col')).toBe(true)
    expect(row.classList.contains('justify-between')).toBe(false)
    expect(action.parentElement?.parentElement).toBe(row)
    expect(row.contains(meta)).toBe(false)

    const desc = host.querySelector('[data-testid="settings-header-description"]') as HTMLElement
    const body = host.querySelector('.settings-scroll-container') as HTMLElement
    setScrollTop(body, 20)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    // Описание сворачивается…
    expect(desc.classList.contains('grid-rows-[0fr]')).toBe(true)
    expect(desc.classList.contains('opacity-0')).toBe(true)
    // …а meta и actions остаются видимыми.
    expect(host.querySelector('[data-testid="settings-header-meta"]')?.textContent).toBe('2 servers')
    expect(meta.classList.contains('grid-rows-[0fr]')).toBe(false)
    expect(meta.classList.contains('opacity-0')).toBe(false)
    expect(host.textContent).toContain('ACTION')
  })

  it('на десктопе заголовок и actions — в одной строке', async () => {
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      meta: '2 servers',
      actions: <button>ACTION</button>,
      children: <div>CONTENT</div>,
    })

    const h2 = host.querySelector('h2') as HTMLElement
    const action = host.querySelector('button') as HTMLButtonElement
    const row = h2.parentElement as HTMLElement
    expect(row.classList.contains('flex')).toBe(true)
    expect(row.classList.contains('items-start')).toBe(true)
    expect(row.classList.contains('justify-between')).toBe(true)
    expect(row.classList.contains('flex-col')).toBe(false)
    expect(action.parentElement?.parentElement).toBe(row)
  })

  it('телефон: заголовок не рвётся посреди слова, кнопка раскрытия компактная, но доступное имя прежнее', async () => {
    stubPhone()
    const host = await renderPanel({
      title: 'Модели',
      actions: <button>ACTION</button>,
      children: (
        <>
          <SettingsSection title="Main">MAIN</SettingsSection>
          <SettingsSection advanced title="Extra">EXTRA</SettingsSection>
        </>
      ),
    })

    const h2 = host.querySelector('h2') as HTMLElement
    // Заголовок — отдельной строкой, перенос только по словам.
    expect(h2.parentElement!.classList.contains('flex-col')).toBe(true)
    expect(h2.classList.contains('break-normal')).toBe(true)
    expect(h2.classList.contains('break-words')).toBe(false)

    const reveal = host.querySelector('[data-testid="settings-advanced-reveal"]') as HTMLButtonElement
    expect(reveal).not.toBeNull()
    // Компактно: иконка + счётчик, полной формулировки в тексте нет.
    expect(reveal.textContent).toContain('(1)')
    expect(reveal.textContent).not.toContain('Show advanced settings')
    // Полная формулировка — в title и aria-label: доступное имя прежнее.
    expect(reveal.getAttribute('aria-label')).toBe('Show advanced settings (1)')
    expect(reveal.getAttribute('title')).toBe('Show advanced settings (1)')
    // Кнопка — в шапке панели.
    expect((host.querySelector('header') as HTMLElement).contains(reveal)).toBe(true)
  })

  it('десктоп: кнопка раскрытия — с полной формулировкой в тексте', async () => {
    const host = await renderPanel({
      title: 'Модели',
      children: (
        <>
          <SettingsSection title="Main">MAIN</SettingsSection>
          <SettingsSection advanced title="Extra">EXTRA</SettingsSection>
        </>
      ),
    })

    const reveal = host.querySelector('[data-testid="settings-advanced-reveal"]') as HTMLButtonElement
    expect(reveal.textContent).toContain('Show advanced settings (1)')
    // На десктопе подпись дублируется текстом — лишних атрибутов нет.
    expect(reveal.getAttribute('aria-label')).toBeNull()
    expect(reveal.getAttribute('title')).toBeNull()
  })

  it('стандарт шапки: счётчики (meta) идут после описания и не сворачиваются', async () => {
    stubPhone()
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      meta: '2 servers',
      actions: <button>ACTION</button>,
      children: <div>CONTENT</div>,
    })

    const header = host.querySelector('header') as HTMLElement
    const desc = host.querySelector('[data-testid="settings-header-description"]') as HTMLElement
    const meta = host.querySelector('[data-testid="settings-header-meta"]') as HTMLElement
    expect(desc).not.toBeNull()
    expect(meta).not.toBeNull()

    // Порядок в DOM: description → meta, счётчики ниже описания (стандарт ADR-072).
    expect(desc.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const children = Array.from(header.children)
    expect(children.indexOf(desc)).toBeLessThan(children.indexOf(meta))

    // После скролла описание сворачивается, а meta остаётся видимым.
    const body = host.querySelector('.settings-scroll-container') as HTMLElement
    setScrollTop(body, 20)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    expect(desc.classList.contains('grid-rows-[0fr]')).toBe(true)
    expect(desc.classList.contains('opacity-0')).toBe(true)
    expect(meta.textContent).toBe('2 servers')
    expect(meta.classList.contains('grid-rows-[0fr]')).toBe(false)
    expect(meta.classList.contains('opacity-0')).toBe(false)
  })

  it('collapsibleHeader: на десктопе описание остаётся видимым', async () => {
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      children: <div>CONTENT</div>,
    })
    const body = host.querySelector('.settings-scroll-container') as HTMLElement
    const desc = host.querySelector('[data-testid="settings-header-description"]') as HTMLElement

    setScrollTop(body, 50)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    expect(desc.classList.contains('grid-rows-[1fr]')).toBe(true)
    // Затенение при этом работает и на десктопе.
    expect(body.getAttribute('data-scroll-shadow')).toBe('top')
  })

  it('продвинутые секции скрыты, пока не нажата локальная кнопка раскрытия', async () => {
    const host = await renderPanel({
      title: 'Network',
      children: (
        <>
          <SettingsSection title="Main">MAIN</SettingsSection>
          <SettingsSection advanced title="Extra">EXTRA</SettingsSection>
        </>
      ),
    })

    expect(host.textContent).toContain('MAIN')
    expect(host.textContent).not.toContain('EXTRA')

    const reveal = host.querySelector('[data-testid="settings-advanced-reveal"]') as HTMLButtonElement
    expect(reveal).not.toBeNull()
    expect(reveal.textContent).toContain('Show advanced settings (1)')
    // Кнопка — в шапке панели: её видно без прокрутки к концу содержимого.
    const header = host.querySelector('header') as HTMLElement
    expect(header.contains(reveal)).toBe(true)

    await act(async () => {
      reveal.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(host.textContent).toContain('EXTRA')
    expect(host.querySelector('[data-testid="settings-advanced-reveal"]')?.textContent).toContain(
      'Hide advanced settings',
    )
  })

  it('фокус на скрытую advanced-секцию раскрывает её и подсвечивает', async () => {
    const host = await renderPanel({
      title: 'Network',
      children: (
        <SettingsSection id="secret" advanced title="Secret">
          SECRET
        </SettingsSection>
      ),
    })

    expect(host.textContent).not.toContain('SECRET')

    await act(async () => {
      useUIStore.getState().focusSettings({ categoryId: 'appearance', sectionId: 'secret' })
    })
    await act(async () => {})

    expect(host.textContent).toContain('SECRET')
    const section = host.querySelector('[data-settings-section="secret"]')
    expect(section).not.toBeNull()
    expect(section?.className).toContain('ring-2')
  })

  it('глобальный режим «Расширенные» показывает секции без локальной кнопки', async () => {
    useUIStore.setState({ settingsShowAdvanced: true })
    const host = await renderPanel({
      title: 'Network',
      children: <SettingsSection advanced title="Extra">EXTRA</SettingsSection>,
    })

    expect(host.textContent).toContain('EXTRA')
    expect(host.querySelector('[data-testid="settings-advanced-reveal"]')).toBeNull()
  })

  it('collapsibleHeader=false: на теле описание не сворачивается', async () => {
    stubPhone()
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      collapsibleHeader: false,
      children: <div>CONTENT</div>,
    })
    const body = host.querySelector('.settings-scroll-container') as HTMLElement
    const desc = host.querySelector('[data-testid="settings-header-description"]') as HTMLElement

    setScrollTop(body, 40)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    expect(desc.classList.contains('grid-rows-[1fr]')).toBe(true)
  })
})
