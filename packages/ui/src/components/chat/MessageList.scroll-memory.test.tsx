/**
 * Восстановление позиции прокрутки ленты — **на сессию**.
 *
 * Регресс на баг владельца: открыта основная сессия, лента внизу; переход в
 * дочернюю сессию (саб-агент) и обратно оставлял ленту основной там, где её
 * оставили в дочерней (прокрутили начало прогона ребёнка — основная
 * открывалась вверху), а автоскролл вниз не срабатывал, потому что флаг
 * «приклеен к низу» (`autoScroll`) тоже был чужим.
 *
 * Причина в том, что вкладки чата переключаются **без размонтирования**
 * `MessageList` (`CenterPanel` рендерит `<ChatTab tab={…}>` без `key`): позиция
 * и флаг живут в компоненте, а не в сессии. Здесь это воспроизводится как
 * смена `sessionId` у того же экземпляра компонента.
 *
 * jsdom не считает лэйаут, поэтому размеры скролл-контейнера задаются моком
 * (`setLayout`), а кадры `requestAnimationFrame` прогоняются вручную — именно
 * на них держится «восстановить после фактической отрисовки».
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// zustand `persist` (useUIStore) пишет в localStorage — в Node/vitest его нет.
const env = vi.hoisted(() => {
  const dims = new WeakMap<Element, { scrollHeight: number; clientHeight: number }>()
  const tops = new WeakMap<Element, number>()
  const queue: FrameRequestCallback[] = []
  const cancelled = new Set<number>()
  let nextId = 1

  const g = globalThis as unknown as Record<string, unknown>

  const lsData = new Map<string, string>()
  const ls = {
    getItem: (k: string) => lsData.get(k) ?? null,
    setItem: (k: string, v: string) => {
      lsData.set(k, v)
    },
    removeItem: (k: string) => {
      lsData.delete(k)
    },
    clear: () => {
      lsData.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }

  // MessageList/ScrollableOverlay проверяют наличие ResizeObserver.
  if (typeof g.ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    g.ResizeObserver = ResizeObserverStub
  }

  // Кадры — под ручным управлением: на них держится восстановление позиции и
  // троттлинг записи в память.
  g.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId
    nextId += 1
    queue.push((time) => {
      if (!cancelled.has(id)) cb(time)
    })
    return id
  }
  g.cancelAnimationFrame = (id: number): void => {
    cancelled.add(id)
  }

  // Прокрутка: `scrollHeight`/`clientHeight` задаёт тест, `scrollTop` ведёт себя
  // как в браузере — ограничивается фактической высотой.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return dims.get(this)?.scrollHeight ?? 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return dims.get(this)?.clientHeight ?? 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return tops.get(this) ?? 0
    },
    set(value: number) {
      const layout = dims.get(this)
      const max = layout ? Math.max(0, layout.scrollHeight - layout.clientHeight) : 0
      const next = Number.isFinite(value) ? Math.min(Math.max(0, value), max) : 0
      tops.set(this, next)
    },
  })
  ;(HTMLElement.prototype as unknown as { scrollTo: (arg: number | ScrollToOptions) => void }).scrollTo =
    function scrollTo(this: HTMLElement, arg: number | ScrollToOptions) {
      this.scrollTop = typeof arg === 'number' ? arg : (arg?.top ?? 0)
    }

  return {
    setLayout(el: Element, scrollHeight: number, clientHeight: number) {
      dims.set(el, { scrollHeight, clientHeight })
    },
    dropLayout(el: Element) {
      dims.delete(el)
    },
    scrollTopOf(el: Element) {
      return tops.get(el) ?? 0
    },
    flushFrame() {
      const cb = queue.shift()
      if (cb) cb(0)
    },
    pendingFrames() {
      return queue.length
    },
    resetFrames() {
      queue.length = 0
      cancelled.clear()
    },
  }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MessageList } from './MessageList'
import type { MessageData } from '@/stores/chatStore'
import { clearChatScrollMemory, readChatScroll, rememberChatScroll } from '@/lib/chatScrollMemory'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function msg(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    id: 'm1',
    role: 'assistant',
    content: 'ответ',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-30T00:00:00Z',
    ...partial,
  }
}

/** Лента основной сессии (4 сообщения / 2 хода). */
const MAIN_MESSAGES: MessageData[] = [
  msg({ id: 'm1', index: 0, role: 'user', content: 'привет', turn_id: 't1' }),
  msg({ id: 'm2', index: 1, content: 'ответ 1', turn_id: 't1' }),
  msg({ id: 'm3', index: 2, role: 'user', content: 'ещё', turn_id: 't2' }),
  msg({ id: 'm4', index: 3, content: 'ответ 2', turn_id: 't2' }),
]

/** Лента дочерней сессии (саб-агент) — короче основной. */
const CHILD_MESSAGES: MessageData[] = [
  msg({ id: 'c1', index: 0, role: 'user', content: 'задача', turn_id: 'ct1' }),
  msg({ id: 'c2', index: 1, content: 'шаг 1', turn_id: 'ct1' }),
]

interface ListHarness {
  root: Root
  container: HTMLElement
  /** Смена сессии у того же экземпляра компонента (как при переключении вкладок). */
  render: (sessionId: string, messages: MessageData[]) => Promise<void>
  unmount: () => Promise<void>
}

const harnesses: ListHarness[] = []

async function renderList(
  sessionId: string,
  messages: MessageData[],
): Promise<ListHarness> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const draw = async (sid: string, list: MessageData[]) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MessageList
            messages={list}
            turn={null}
            retry={null}
            sessionId={sid}
            onCopy={() => {}}
            onToggle={() => {}}
            onPin={() => {}}
            onDelete={() => {}}
            onRetry={() => {}}
            onDebug={() => {}}
            onFork={() => {}}
          />
        </I18nProvider>,
      )
    })
  }
  const harness: ListHarness = {
    root,
    container,
    render: draw,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
  harnesses.push(harness)
  await draw(sessionId, messages)
  return harness
}

function scrollEl(container: ParentNode): HTMLElement {
  const el = container.querySelector<HTMLElement>('.chat-scroll-container')
  if (!el) throw new Error('скролл-контейнер ленты не найден')
  return el
}

/** Прогнать очередь кадров (каждый — в отдельном `act`). */
async function frames(count = 4): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      env.flushFrame()
    })
  }
}

/** Пользователь прокрутил ленту (реальное событие `scroll` + кадр на запись). */
async function userScroll(el: HTMLElement, top: number): Promise<void> {
  await act(async () => {
    el.scrollTop = top
    el.dispatchEvent(new Event('scroll'))
  })
  await frames(2)
}

/**
 * Смена сессии с заранее известной высотой её ленты.
 *
 * Контейнер прокрутки при переключении вкладок чата — **тот же DOM-узел**
 * (компонент не размонтируется), а в браузере к моменту коммита высота уже
 * новая; поэтому размеры ставим до рендера, иначе старая (короткая) высота
 * обрежет восстанавливаемую позицию и исказит сценарий.
 */
async function switchSession(
  harness: ListHarness,
  sessionId: string,
  messages: MessageData[],
  layout: { scrollHeight: number; clientHeight: number },
): Promise<HTMLElement> {
  const el = scrollEl(harness.container)
  env.setLayout(el, layout.scrollHeight, layout.clientHeight)
  await harness.render(sessionId, messages)
  return el
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  clearChatScrollMemory()
  env.resetFrames()
})

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!
    await harness.unmount()
  }
  document.body.innerHTML = ''
  env.resetFrames()
  clearChatScrollMemory()
  vi.clearAllMocks()
})

describe('MessageList — позиция прокрутки на сессию', () => {
  it('был внизу → ушёл в дочернюю сессию → вернулся → лента снова внизу', async () => {
    const harness = await renderList('s-main', MAIN_MESSAGES)
    let el = scrollEl(harness.container)
    env.setLayout(el, 4000, 500)
    await frames()

    // Первое открытие — как раньше: лента внизу.
    expect(env.scrollTopOf(el)).toBe(3500)
    await userScroll(el, 3500)
    expect(readChatScroll('s-main')).toEqual({ atBottom: true, scrollTop: 3500 })

    // Переход в дочернюю сессию: тот же экземпляр компонента, другой sessionId.
    el = await switchSession(harness, 's-child', CHILD_MESSAGES, { scrollHeight: 800, clientHeight: 500 })
    await frames()
    // В дочерней ленте человек ушёл в начало прогона — «приклеенности» к низу нет.
    await userScroll(el, 0)
    expect(readChatScroll('s-child')).toEqual({ atBottom: false, scrollTop: 0 })

    // Возврат в основную: позиция — из памяти основной сессии, а не из дочерней.
    el = await switchSession(harness, 's-main', MAIN_MESSAGES, { scrollHeight: 4000, clientHeight: 500 })
    await frames()

    expect(env.scrollTopOf(el)).toBe(3500)
  })

  it('был в середине ленты → вернулся → та же позиция (а не низ)', async () => {
    const harness = await renderList('s-main', MAIN_MESSAGES)
    let el = scrollEl(harness.container)
    env.setLayout(el, 4000, 500)
    await frames()

    await userScroll(el, 1200)
    expect(readChatScroll('s-main')).toEqual({ atBottom: false, scrollTop: 1200 })

    el = await switchSession(harness, 's-child', CHILD_MESSAGES, { scrollHeight: 800, clientHeight: 500 })
    await frames()

    el = await switchSession(harness, 's-main', MAIN_MESSAGES, { scrollHeight: 4000, clientHeight: 500 })
    await frames()

    expect(env.scrollTopOf(el)).toBe(1200)
  })

  it('позиция восстанавливается после фактической отрисовки ленты (пустой контейнер — не повод прыгать)', async () => {
    // Запоминаем «приклеен к низу» на первой ленте.
    const first = await renderList('s-main', MAIN_MESSAGES)
    let el = scrollEl(first.container)
    env.setLayout(el, 4000, 500)
    await frames()
    await userScroll(el, 3500)
    await first.unmount()

    // Возврат: сообщения ещё не отрисованы (высота ленты нулевая).
    const second = await renderList('s-main', [])
    el = scrollEl(second.container)
    await frames(3)
    expect(env.scrollTopOf(el)).toBe(0)

    // Лента отрисовалась — только теперь позиция доводится до низа.
    env.setLayout(el, 4000, 500)
    await frames()
    expect(env.scrollTopOf(el)).toBe(3500)
  })

  it('запомненная позиция ограничивается фактической высотой ленты', async () => {
    // В памяти — позиция с большой ленты (например, до перезагрузки данных).
    rememberChatScroll('s-main', { atBottom: false, scrollTop: 9000 })

    const harness = await renderList('s-main', MAIN_MESSAGES)
    const el = scrollEl(harness.container)
    env.setLayout(el, 4000, 500)
    await frames()

    expect(env.scrollTopOf(el)).toBe(3500)
  })

  it('новое сообщение при «приклеен к низу» прокручивает ленту вниз', async () => {
    const harness = await renderList('s-main', MAIN_MESSAGES)
    const el = scrollEl(harness.container)
    env.setLayout(el, 4000, 500)
    await frames()
    await userScroll(el, 3500)

    // Новое сообщение — лента выросла.
    await harness.render('s-main', [...MAIN_MESSAGES, msg({ id: 'm5', index: 4, content: 'ответ 3', turn_id: 't3' })])
    env.setLayout(el, 4600, 500)
    await frames()

    expect(env.scrollTopOf(el)).toBe(4100)
  })

  it('незнакомая сессия открывается внизу (прежнее поведение)', async () => {
    const harness = await renderList('s-new', MAIN_MESSAGES)
    const el = scrollEl(harness.container)
    env.setLayout(el, 4000, 500)
    await frames()

    expect(env.scrollTopOf(el)).toBe(3500)
    expect(readChatScroll('s-new')).toBeNull()
  })
})
