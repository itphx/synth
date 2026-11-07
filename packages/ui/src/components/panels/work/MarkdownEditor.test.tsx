import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MarkdownEditor, applyMarkdownAction } from './MarkdownEditor'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(node: React.ReactNode): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>)
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
})

describe('applyMarkdownAction: чистая функция тулбара', () => {
  it('жирный: оборачивает выделение', () => {
    const result = applyMarkdownAction('bold', 'привет', 0, 6)
    expect(result.value).toBe('**привет**')
    expect(result.selectionStart).toBe(2)
    expect(result.selectionEnd).toBe(8)
  })

  it('код: оборачивает выделение', () => {
    expect(applyMarkdownAction('code', 'привет', 0, 6).value).toBe('`привет`')
  })

  it('курсив: оборачивает выделение', () => {
    expect(applyMarkdownAction('italic', 'привет', 0, 6).value).toBe('*привет*')
  })

  it('список: префиксует строки', () => {
    expect(applyMarkdownAction('list', 'один\nдва', 0, 7).value).toBe('- один\n- два')
  })

  it('ссылка: подпись + адрес, выделение на адресе', () => {
    const result = applyMarkdownAction('link', 'текст', 0, 5)
    expect(result.value).toBe('[текст](url)')
    expect(result.selectionStart).toBe(8)
    expect(result.selectionEnd).toBe(11)
  })

  it('пустое выделение: вставляет пустые маркеры', () => {
    expect(applyMarkdownAction('bold', '', 0, 0).value).toBe('****')
  })
})

describe('MarkdownEditor: вкладки, тулбар и сохранение', () => {
  it('по умолчанию открыта вкладка «Редактор», есть textarea и тулбар', async () => {
    const container = await render(<MarkdownEditor value="текст" onChange={() => {}} testId="ed" />)
    expect(container.querySelector('[data-testid="ed-textarea"]')).not.toBeNull()
    expect(container.querySelector('[role="toolbar"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="ed-bold"]')).not.toBeNull()
  })

  it('переключение на «Превью» показывает отрендеренный markdown', async () => {
    const container = await render(<MarkdownEditor value={'**жирный**'} onChange={() => {}} testId="ed" />)
    const previewTab = [...container.querySelectorAll('button[role="tab"]')].find(
      (b) => b.textContent === 'Preview',
    ) as HTMLButtonElement
    await act(async () => {
      previewTab.click()
    })
    const preview = container.querySelector('[data-testid="ed-preview"]')!
    expect(preview.querySelector('strong')?.textContent).toBe('жирный')
  })

  it('тулбар «Жирный» оборачивает выделение и зовёт onChange', async () => {
    const onChange = vi.fn()
    const container = await render(<MarkdownEditor value="привет" onChange={onChange} testId="ed" />)
    const textarea = container.querySelector('[data-testid="ed-textarea"]') as HTMLTextAreaElement
    textarea.setSelectionRange(0, 6)
    await act(async () => {
      ;(container.querySelector('[data-testid="ed-bold"]') as HTMLButtonElement).click()
    })
    expect(onChange).toHaveBeenCalledWith('**привет**')
  })

  it('кнопка «Сохранить» зовёт onSave, «Отмена» — onCancel', async () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const container = await render(
      <MarkdownEditor value="текст" onChange={() => {}} onSave={onSave} onCancel={onCancel} testId="ed" />,
    )
    await act(async () => {
      ;(container.querySelector('[data-testid="ed-save"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="ed-cancel"]') as HTMLButtonElement).click()
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('превышение лимита блокирует сохранение и подсвечивает счётчик', async () => {
    const container = await render(
      <MarkdownEditor value="12345" onChange={() => {}} onSave={() => {}} limit={3} testId="ed" />,
    )
    const save = container.querySelector('[data-testid="ed-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const counter = container.querySelector('[data-testid="ed-counter"]')!
    expect(counter.textContent).toContain('5 of 3')
    expect(counter.className).toContain('text-destructive')
  })

  it('read-only: тулбар и сохранение недоступны', async () => {
    const container = await render(
      <MarkdownEditor value="текст" onChange={() => {}} onSave={() => {}} readOnly testId="ed" />,
    )
    expect((container.querySelector('[data-testid="ed-bold"]') as HTMLButtonElement).disabled).toBe(true)
    expect((container.querySelector('[data-testid="ed-save"]') as HTMLButtonElement).disabled).toBe(true)
  })
})
