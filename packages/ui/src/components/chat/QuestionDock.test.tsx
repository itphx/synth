import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import type { QuestionRecord } from '@itphx/synth-shared/types'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  answer: vi.fn(),
  cancel: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    list: mocks.list,
    answer: mocks.answer,
    cancel: mocks.cancel,
  },
}))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { QuestionDock } from './QuestionDock'
import { useQuestionStore } from '@/stores/questionStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SESSION_ID = 's1'

function makeRecord(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id: 'qst_1',
    sessionId: SESSION_ID,
    status: 'pending',
    questions: [
      {
        question: 'Какой вариант выбрать?',
        header: 'Выбор',
        options: [
          { value: 'a', label: 'Вариант A', description: 'первый' },
          { value: 'b', label: 'Вариант B' },
        ],
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

async function renderDock(sessionId = SESSION_ID): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <QuestionDock sessionId={sessionId} />
      </I18nProvider>,
    )
  })
  return container
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  )
}

/**
 * Кладёт записи вопросов в стор и подменяет ответ сервера на них же —
 * иначе восстановление при монтировании (`list` → `setAll`) затрёт записи.
 */
function setupQuestions(records: QuestionRecord[] = [makeRecord()]): QuestionRecord[] {
  useQuestionStore.getState().setAll(SESSION_ID, records)
  mocks.list.mockResolvedValue({ questions: records })
  return records
}

/** Значение controlled-инпута в React (обход кэша значения на элементе). */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  useQuestionStore.setState({ bySession: {} })
  vi.clearAllMocks()
  // Тесты с fake-возвратами восстанавливают реальные часы.
  vi.useRealTimers()
})

describe('QuestionDock (док вопросов агента над вводом)', () => {
  beforeAll(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  beforeEach(() => {
    mocks.list.mockResolvedValue({ questions: [] })
    mocks.answer.mockResolvedValue({ question: makeRecord() })
    mocks.cancel.mockResolvedValue({ question: makeRecord() })
  })

  it('без pending-вопросов ничего не рендерит', async () => {
    const container = await renderDock()
    expect(container.textContent).toBe('')
    expect(container.querySelector('[data-question-dock]')).toBeNull()
  })

  it('восстанавливает pending-вопросы при монтировании (list + setAll)', async () => {
    mocks.list.mockResolvedValue({ questions: [makeRecord()] })
    const container = await renderDock()

    expect(mocks.list).toHaveBeenCalledWith(SESSION_ID, { status: 'pending', limit: 50 })
    expect(container.textContent).toContain('Какой вариант выбрать?')
    expect(container.textContent).toContain('Вариант A')
  })

  it('вопрос, пришедший событием во время загрузки, не теряется', async () => {
    // Сервер ещё не отдаёт вопрос (событие `user_question.asked` уже в сторе).
    useQuestionStore.getState().setAll(SESSION_ID, [makeRecord()])
    mocks.list.mockResolvedValue({ questions: [] })
    const container = await renderDock()

    expect(container.textContent).toContain('Какой вариант выбрать?')
  })

  it('рендерит заголовок, текст вопроса и варианты', async () => {
    setupQuestions()
    const container = await renderDock()

    expect(container.textContent).toContain('Агент задал вопрос')
    expect(container.textContent).toContain('Выбор')
    expect(container.textContent).toContain('Какой вариант выбрать?')
    expect(container.textContent).toContain('Вариант A')
    expect(container.textContent).toContain('первый')
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2)
  })

  it('выбор варианта и «Ответить» → answer с [[value]]', async () => {
    setupQuestions()
    const container = await renderDock()

    const radios = container.querySelectorAll('input[type="radio"]')
    await act(async () => {
      ;(radios[1] as HTMLInputElement).click()
    })

    const submit = findButton(container, 'Ответить')
    expect(submit).toBeDefined()
    expect(submit!.disabled).toBe(false)

    await act(async () => {
      submit!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.answer).toHaveBeenCalledWith(SESSION_ID, 'qst_1', [['b']])
    // После успеха вопрос уходит из pending.
    expect(useQuestionStore.getState().bySession[SESSION_ID]).toBeUndefined()
  })

  it('кнопка «Ответить» заблокирована, пока нет ответа', async () => {
    setupQuestions()
    const container = await renderDock()

    const submit = findButton(container, 'Ответить')
    expect(submit!.disabled).toBe(true)
    expect(container.textContent).toContain('Ответьте на каждый вопрос')
  })

  it('«Свой ответ» — текст уходит ответом и снимает выбор варианта', async () => {
    setupQuestions()
    const container = await renderDock()

    const radios = container.querySelectorAll('input[type="radio"]')
    await act(async () => {
      ;(radios[0] as HTMLInputElement).click()
    })

    // Раскрываем поле «свой ответ» и печатаем.
    const customToggle = findButton(container, 'Свой ответ')
    expect(customToggle).toBeDefined()
    await act(async () => {
      customToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => {
      setInputValue(input, 'мой вариант')
    })

    // Выбор варианта снят.
    expect((container.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement).checked).toBe(false)

    const submit = findButton(container, 'Ответить')
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.answer).toHaveBeenCalledWith(SESSION_ID, 'qst_1', [['мой вариант']])
  })

  it('multiple: чекбоксы — в ответ идут все выбранные значения', async () => {
    setupQuestions([
      makeRecord({
        questions: [
          {
            question: 'Что отметить?',
            header: 'Отметки',
            multiple: true,
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
          },
        ],
      }),
    ])
    const container = await renderDock()

    expect(container.textContent).toContain('Можно выбрать несколько вариантов')
    const boxes = container.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)

    await act(async () => {
      ;(boxes[0] as HTMLInputElement).click()
      ;(boxes[1] as HTMLInputElement).click()
    })

    const submit = findButton(container, 'Ответить')
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.answer).toHaveBeenCalledWith(SESSION_ID, 'qst_1', [['a', 'b']])
  })

  it('«Отменить» → cancel с причиной user', async () => {
    setupQuestions()
    const container = await renderDock()

    const cancelBtn = findButton(container, 'Отменить')
    expect(cancelBtn).toBeDefined()
    await act(async () => {
      cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.cancel).toHaveBeenCalledWith(SESSION_ID, 'qst_1', 'user')
    expect(useQuestionStore.getState().bySession[SESSION_ID]).toBeUndefined()
  })

  it('несколько вопросов: навигация «Далее»/«Назад» и точки-сегменты', async () => {
    setupQuestions([
      makeRecord({
        questions: [
          {
            question: 'Первый вопрос?',
            header: 'Первый',
            options: [{ value: 'a', label: 'A' }],
          },
          {
            question: 'Второй вопрос?',
            header: 'Второй',
            options: [{ value: 'b', label: 'B' }],
          },
        ],
      }),
    ])
    const container = await renderDock()

    // Прогресс — точками, текст остаётся в aria-подписи группы.
    const dots = container.querySelector('[data-question-dots]') as HTMLElement
    expect(dots).toBeTruthy()
    expect(dots.getAttribute('aria-label')).toBe('1 из 2')
    expect(container.querySelectorAll('[data-question-dot]')).toHaveLength(2)
    expect(container.textContent).toContain('Первый вопрос?')

    const next = findButton(container, 'Далее')
    expect(next).toBeDefined()
    await act(async () => {
      next!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Второй вопрос?')
    expect(
      (container.querySelector('[data-question-dots]') as HTMLElement).getAttribute('aria-label'),
    ).toBe('2 из 2')

    const prev = findButton(container, 'Назад')
    await act(async () => {
      prev!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Первый вопрос?')
  })

  it('точки-сегменты: клик переключает вопрос, активная помечена aria-current', async () => {
    setupQuestions([
      makeRecord({
        questions: [
          { question: 'Первый?', header: 'Первый', options: [{ value: 'a', label: 'A' }] },
          { question: 'Второй?', header: 'Второй', options: [{ value: 'b', label: 'B' }] },
        ],
      }),
    ])
    const container = await renderDock()

    const dotButtons = () =>
      Array.from(container.querySelectorAll('[data-question-dot]')) as HTMLButtonElement[]

    expect(dotButtons()[0]!.getAttribute('aria-current')).toBe('step')
    expect(dotButtons()[1]!.getAttribute('aria-current')).toBeNull()
    expect(dotButtons()[0]!.getAttribute('aria-label')).toBe('Вопрос 1')
    expect(dotButtons()[1]!.getAttribute('aria-label')).toBe('Вопрос 2')

    await act(async () => {
      dotButtons()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Второй?')
    expect(dotButtons()[0]!.getAttribute('aria-current')).toBeNull()
    expect(dotButtons()[1]!.getAttribute('aria-current')).toBe('step')
  })

  it('сворачивание: варианты скрыты, подпись и бейдж видны, разворачивание возвращает', async () => {
    setupQuestions()
    const container = await renderDock()

    const toggle = container.querySelector('[data-question-collapse]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Тело дока скрыто: варианты, ввод и навигация недоступны.
    const body = container.querySelector('[data-question-body]') as HTMLElement
    expect(body.hidden).toBe(true)
    expect(body.getAttribute('aria-hidden')).toBe('true')
    expect(body.hasAttribute('inert')).toBe(true)
    const radio = body.querySelector('input[type="radio"]') as HTMLInputElement
    expect(radio).toBeTruthy()
    expect(radio.closest('[hidden]')).not.toBeNull()

    // Подпись шапки и бейдж отвеченных.
    expect(container.textContent).toContain('Вопрос 1 из 1')
    expect(container.textContent).toContain('отвечено 0/1')
    expect(container.querySelector('[data-question-collapsed]')).not.toBeNull()

    // Кнопка «Развернуть» возвращает шаг.
    const expand = findButton(container, 'Развернуть')
    expect(expand).toBeDefined()
    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const restored = container.querySelector('[data-question-body]') as HTMLElement
    expect(restored.hidden).toBe(false)
    expect(restored.hasAttribute('inert')).toBe(false)
    expect(container.querySelector('[data-question-collapsed]')).toBeNull()
  })

  it('сворачивание сохраняется при переключении вопросов и сбрасывается на новом вопросе', async () => {
    setupQuestions([
      makeRecord({
        questions: [
          { question: 'Первый?', header: 'Первый', options: [{ value: 'a', label: 'A' }] },
          { question: 'Второй?', header: 'Второй', options: [{ value: 'b', label: 'B' }] },
        ],
      }),
    ])
    const container = await renderDock()

    const toggle = container.querySelector('[data-question-collapse]') as HTMLButtonElement
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect((container.querySelector('[data-question-body]') as HTMLElement).hidden).toBe(true)

    // Переключение вопроса (по точке) не разворачивает док.
    await act(async () => {
      ;(container.querySelectorAll('[data-question-dot]')[1] as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect((container.querySelector('[data-question-body]') as HTMLElement).hidden).toBe(true)
    expect(container.textContent).toContain('Вопрос 2 из 2')

    // Новый вопрос (другая запись) — док раскрыт заново.
    await act(async () => {
      useQuestionStore
        .getState()
        .setAll(SESSION_ID, [makeRecord({ id: 'qst_2', questions: [{ question: 'Третий?', header: 'Третий', options: [] }] })])
    })
    expect((container.querySelector('[data-question-body]') as HTMLElement).hidden).toBe(false)
  })

  it('проверка ответов: «Далее» на последнем вопросе открывает review, «Отправить» шлёт ответы', async () => {
    setupQuestions([
      makeRecord({
        questions: [
          { question: 'Первый?', header: 'Первый', options: [{ value: 'a', label: 'Вариант A' }] },
          {
            question: 'Второй?',
            header: 'Второй',
            multiple: true,
            options: [
              { value: 'b', label: 'Вариант B' },
              { value: 'c', label: 'Вариант C' },
            ],
          },
        ],
      }),
    ])
    const container = await renderDock()

    // Отвечаем на первый вопрос.
    await act(async () => {
      ;(container.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement).click()
    })

    // «Далее» → второй вопрос, на нём кнопка становится «Проверить».
    await act(async () => {
      findButton(container, 'Далее')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const boxes = container.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    await act(async () => {
      ;(boxes[0] as HTMLInputElement).click()
      ;(boxes[1] as HTMLInputElement).click()
    })

    const review = findButton(container, 'Проверить')
    expect(review).toBeDefined()
    await act(async () => {
      review!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Экран проверки: видны пары «вопрос → ответ».
    const reviewBlock = container.querySelector('[data-question-review]') as HTMLElement
    expect(reviewBlock).toBeTruthy()
    expect(reviewBlock.textContent).toContain('Первый')
    expect(reviewBlock.textContent).toContain('Вариант A')
    expect(reviewBlock.textContent).toContain('Второй')
    expect(reviewBlock.textContent).toContain('Вариант B, Вариант C')

    // Точки на шаге проверки скрыты.
    expect(container.querySelector('[data-question-dots]')).toBeNull()

    // «Отправить» — один вызов answer с полным массивом ответов.
    const submit = findButton(container, 'Отправить')
    expect(submit).toBeDefined()
    expect(submit!.disabled).toBe(false)
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.answer).toHaveBeenCalledTimes(1)
    expect(mocks.answer).toHaveBeenCalledWith(SESSION_ID, 'qst_1', [['a'], ['b', 'c']])
  })

  it('проверка ответов: «Изменить» возвращает к нужному вопросу, ответы сохраняются', async () => {
    setupQuestions([
      makeRecord({
        questions: [
          { question: 'Первый?', header: 'Первый', options: [{ value: 'a', label: 'A' }] },
          { question: 'Второй?', header: 'Второй', options: [{ value: 'b', label: 'B' }] },
        ],
      }),
    ])
    const container = await renderDock()

    await act(async () => {
      ;(container.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement).click()
    })
    await act(async () => {
      findButton(container, 'Далее')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      ;(container.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement).click()
    })
    await act(async () => {
      findButton(container, 'Проверить')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // «Изменить» у первого вопроса — возврат к первому шагу с сохранённым выбором.
    const editButtons = Array.from(
      container.querySelectorAll('[data-question-review] button'),
    ) as HTMLButtonElement[]
    expect(editButtons).toHaveLength(2)
    await act(async () => {
      editButtons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Первый?')
    expect(
      (container.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement).checked,
    ).toBe(true)
    expect(container.querySelector('[data-question-review]')).toBeNull()
  })

  it('проверка ответов: «Отправить» заблокирована, пока не отвечены все вопросы', async () => {
    setupQuestions([
      makeRecord({
        questions: [
          { question: 'Первый?', header: 'Первый', options: [{ value: 'a', label: 'A' }] },
          { question: 'Второй?', header: 'Второй', options: [{ value: 'b', label: 'B' }] },
        ],
      }),
    ])
    const container = await renderDock()

    await act(async () => {
      ;(container.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement).click()
    })
    await act(async () => {
      findButton(container, 'Далее')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      findButton(container, 'Проверить')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const submit = findButton(container, 'Отправить')
    expect(submit).toBeDefined()
    expect(submit!.disabled).toBe(true)
    expect(mocks.answer).not.toHaveBeenCalled()
  })

  it('Ctrl+Enter на шаге проверки отправляет ответы', async () => {
    setupQuestions([
      makeRecord({
        questions: [
          { question: 'Первый?', header: 'Первый', options: [{ value: 'a', label: 'A' }] },
          { question: 'Второй?', header: 'Второй', options: [{ value: 'b', label: 'B' }] },
        ],
      }),
    ])
    const container = await renderDock()

    await act(async () => {
      ;(container.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement).click()
    })
    await act(async () => {
      findButton(container, 'Далее')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      ;(container.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement).click()
    })
    await act(async () => {
      findButton(container, 'Проверить')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      )
    })
    expect(mocks.answer).toHaveBeenCalledTimes(1)
    expect(mocks.answer).toHaveBeenCalledWith(SESSION_ID, 'qst_1', [['a'], ['b']])
  })

  it('ошибка API → тост, состояние (выбор) сохраняется', async () => {
    mocks.answer.mockRejectedValue(new Error('boom'))
    setupQuestions()
    const container = await renderDock()

    const radios = container.querySelectorAll('input[type="radio"]')
    await act(async () => {
      ;(radios[0] as HTMLInputElement).click()
    })
    await act(async () => {
      findButton(container, 'Ответить')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    // Вопрос остался в pending, выбор сохранился.
    expect(useQuestionStore.getState().bySession[SESSION_ID]).toHaveLength(1)
    expect((container.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement).checked).toBe(true)
  })

  it('Ctrl+Enter отправляет ответ, Esc отменяет вопрос', async () => {
    setupQuestions()
    const container = await renderDock()

    const radios = container.querySelectorAll('input[type="radio"]')
    await act(async () => {
      ;(radios[0] as HTMLInputElement).click()
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    expect(mocks.answer).toHaveBeenCalledWith(SESSION_ID, 'qst_1', [['a']])

    // Следующий вопрос — Esc отменяет.
    await act(async () => {
      useQuestionStore.getState().setAll(SESSION_ID, [makeRecord({ id: 'qst_2' })])
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(mocks.cancel).toHaveBeenCalledWith(SESSION_ID, 'qst_2', 'user')
  })

  it('Esc в поле ввода не перехватывается', async () => {
    setupQuestions()
    const container = await renderDock()

    const customToggle = findButton(container, 'Свой ответ')
    await act(async () => {
      customToggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = container.querySelector('input[type="text"]') as HTMLInputElement

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(mocks.cancel).not.toHaveBeenCalled()
  })
})

describe('QuestionDock — обратный отсчёт до истечения вопроса', () => {
  /** Опорное время теста (fake-таймеры). */
  const BASE = new Date('2026-01-01T00:00:00.000Z').getTime()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE)
  })

  /** Текст таймера в шапке дока (null — таймера нет). */
  function timerText(container: HTMLElement): string | null {
    return container.querySelector('[data-question-timer]')?.textContent?.trim() ?? null
  }

  /** Запись вопроса со сроком ожидания через `offsetMs` от опорного времени. */
  function recordWithExpiry(offsetMs: number): QuestionRecord {
    return makeRecord({ expiresAt: new Date(BASE + offsetMs).toISOString() })
  }

  it('с expiresAt показывает остаток и тикает раз в секунду', async () => {
    setupQuestions([recordWithExpiry(90_000)])
    const container = await renderDock()

    expect(timerText(container)).toBe('01:30')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(timerText(container)).toBe('01:28')
  })

  it('без expiresAt таймера нет', async () => {
    setupQuestions()
    const container = await renderDock()

    expect(container.querySelector('[data-question-timer]')).toBeNull()
  })

  it('после истечения показывает 00:00 (не уходит в минус)', async () => {
    setupQuestions([recordWithExpiry(90_000)])
    const container = await renderDock()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(91_000)
    })
    expect(timerText(container)).toBe('00:00')
  })

  it('таймер виден и в свёрнутом виде', async () => {
    setupQuestions([recordWithExpiry(90_000)])
    const container = await renderDock()

    const toggle = container.querySelector('[data-question-collapse]') as HTMLButtonElement
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('[data-question-collapsed]')).not.toBeNull()
    expect(timerText(container)).toBe('01:30')
  })

  it('у таймера есть подпись и aria-подпись', async () => {
    setupQuestions([recordWithExpiry(90_000)])
    const container = await renderDock()

    const timer = container.querySelector('[data-question-timer]') as HTMLElement
    expect(timer.getAttribute('title')).toBe('Осталось 01:30')
    expect(timer.getAttribute('aria-label')).toBe('До истечения вопроса: 01:30')
  })

  it('отвеченный вопрос (ушёл из pending) — таймера нет', async () => {
    setupQuestions([recordWithExpiry(90_000)])
    const container = await renderDock()
    expect(timerText(container)).toBe('01:30')

    await act(async () => {
      useQuestionStore.getState().remove(SESSION_ID, 'qst_1')
    })
    expect(container.querySelector('[data-question-timer]')).toBeNull()
  })
})
