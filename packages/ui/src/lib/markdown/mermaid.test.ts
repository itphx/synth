import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { i18nText } from '@/lib/i18n'
import {
  clearMermaidInPlace,
  isMermaidMode,
  normalizeMermaidMode,
  renderMermaidInPlace,
  setMermaidSourceVisible,
} from './mermaid'

const DIAGRAM = 'graph TD\n  A[Start] --> B[Done]'

const containers: HTMLElement[] = []

/**
 * Блок кода с исходником диаграммы — ровно та разметка, которую даёт marked
 * (`renderer.code` в `MarkdownContent.tsx`): шапка с действиями и `pre code`
 * с исходником.
 */
function buildContainer(source: string): HTMLElement {
  const container = document.createElement('div')
  const block = document.createElement('div')
  block.className = 'md-code'
  block.setAttribute('data-lang', 'mermaid')

  const head = document.createElement('div')
  head.className = 'md-code-head'
  const actions = document.createElement('span')
  actions.className = 'md-code-actions'
  head.appendChild(actions)

  const pre = document.createElement('pre')
  pre.className = 'md-code-pre'
  const code = document.createElement('code')
  code.className = 'language-mermaid'
  code.textContent = source
  pre.appendChild(code)

  block.append(head, pre)
  container.appendChild(block)
  document.body.appendChild(container)
  containers.push(container)
  return container
}

function blockOf(container: HTMLElement): HTMLElement {
  const block = container.querySelector<HTMLElement>('.md-code[data-lang="mermaid"]')
  expect(block).not.toBeNull()
  return block!
}

afterEach(() => {
  for (const container of containers.splice(0)) container.remove()
  document.body.innerHTML = ''
})

describe('mermaid: режимы', () => {
  it('isMermaidMode знает только svg/ascii/off', () => {
    expect(isMermaidMode('svg')).toBe(true)
    expect(isMermaidMode('ascii')).toBe(true)
    expect(isMermaidMode('off')).toBe(true)
    expect(isMermaidMode('rich-text')).toBe(false)
    expect(isMermaidMode(undefined)).toBe(false)
  })

  it('битое значение режима → svg (значение по умолчанию)', () => {
    expect(normalizeMermaidMode('ascii')).toBe('ascii')
    expect(normalizeMermaidMode('off')).toBe('off')
    expect(normalizeMermaidMode('rich-text')).toBe('svg')
    expect(normalizeMermaidMode(undefined)).toBe('svg')
  })
})

describe('mermaid: рендер в готовом DOM', () => {
  it('режим off — блок остаётся кодом, диаграммы нет', async () => {
    const container = buildContainer(DIAGRAM)

    await renderMermaidInPlace(container, 'off')

    expect(container.querySelector('.md-code[data-lang="mermaid"]')).not.toBeNull()
    expect(container.querySelector('.md-mermaid-chart')).toBeNull()
    expect(container.querySelector('pre.md-mermaid-ascii')).toBeNull()
    expect(blockOf(container).dataset.mermaid).toBeUndefined()
  })

  it('режим svg — диаграмма нарисована, исходник сохранён для копирования', async () => {
    const container = buildContainer(DIAGRAM)

    await renderMermaidInPlace(container, 'svg')

    const chart = container.querySelector('.md-mermaid-chart')
    expect(chart).not.toBeNull()
    expect(chart!.querySelector('svg')).not.toBeNull()
    expect(chart!.getAttribute('role')).toBe('img')
    expect(chart!.getAttribute('aria-label')).toBe(i18nText('markdown.mermaid.aria'))

    // Исходник остаётся в DOM (его читают кнопки копирования/скачивания),
    // но скрыт — показывается диаграмма.
    const pre = container.querySelector<HTMLElement>('pre.md-code-pre')
    expect(pre).not.toBeNull()
    expect(pre!.hidden).toBe(true)
    expect(pre!.querySelector('code')?.textContent).toBe(DIAGRAM)
    expect(blockOf(container).dataset.mermaid).toBe('svg')

    // В шапке блока — переключатель «код/диаграмма».
    const toggle = container.querySelector<HTMLButtonElement>('[data-mermaid-toggle]')
    expect(toggle).not.toBeNull()
    expect(toggle!.textContent).toBe(i18nText('markdown.mermaid.toggle'))
    expect(toggle!.getAttribute('aria-pressed')).toBe('false')
  })

  it('режим ascii — текстовое представление диаграммы', async () => {
    const container = buildContainer(DIAGRAM)

    await renderMermaidInPlace(container, 'ascii')

    const ascii = container.querySelector('pre.md-mermaid-ascii')
    expect(ascii).not.toBeNull()
    expect(ascii!.textContent?.trim().length).toBeGreaterThan(0)
    expect(container.querySelector('.md-mermaid-chart')).toBeNull()
    expect(blockOf(container).dataset.mermaid).toBe('ascii')
  })

  it('битый синтаксис — блок остаётся кодом, исключение не выходит', async () => {
    const container = buildContainer('not a diagram')

    await expect(renderMermaidInPlace(container, 'svg')).resolves.toBeUndefined()

    expect(container.querySelector('.md-mermaid-chart')).toBeNull()
    expect(container.querySelector('[data-mermaid-toggle]')).toBeNull()
    expect(blockOf(container).dataset.mermaid).toBeUndefined()
    expect(container.querySelector('pre.md-code-pre code')?.textContent).toBe('not a diagram')
  })

  it('повторный вызов не дублирует диаграмму', async () => {
    const container = buildContainer(DIAGRAM)

    await renderMermaidInPlace(container, 'svg')
    await renderMermaidInPlace(container, 'svg')

    expect(container.querySelectorAll('.md-mermaid-chart')).toHaveLength(1)
  })

  it('смена режима перерисовывает блок (прежний результат снят)', async () => {
    const container = buildContainer(DIAGRAM)

    await renderMermaidInPlace(container, 'svg')
    expect(container.querySelector('.md-mermaid-chart')).not.toBeNull()

    await renderMermaidInPlace(container, 'ascii')

    expect(container.querySelectorAll('.md-mermaid-chart')).toHaveLength(0)
    expect(container.querySelectorAll('pre.md-mermaid-ascii')).toHaveLength(1)
    expect(blockOf(container).dataset.mermaid).toBe('ascii')
  })

  it('переход в off снимает ранее нарисованную диаграмму', async () => {
    const container = buildContainer(DIAGRAM)

    await renderMermaidInPlace(container, 'svg')
    await renderMermaidInPlace(container, 'off')

    expect(container.querySelector('.md-mermaid-chart')).toBeNull()
    expect(container.querySelector('[data-mermaid-toggle]')).toBeNull()
    expect(blockOf(container).dataset.mermaid).toBeUndefined()
    // Исходник снова виден — блок снова обычный код.
    expect(container.querySelector<HTMLElement>('pre.md-code-pre')!.hidden).toBe(false)
  })

  it('clearMermaidInPlace убирает диаграмму и возвращает исходник', async () => {
    const container = buildContainer(DIAGRAM)

    await renderMermaidInPlace(container, 'svg')
    clearMermaidInPlace(container)

    expect(container.querySelector('.md-mermaid-chart')).toBeNull()
    expect(container.querySelector<HTMLElement>('pre.md-code-pre')!.hidden).toBe(false)
  })
})

describe('mermaid: переключатель «код/диаграмма»', () => {
  it('показ исходника снимает атрибут hidden и ставит data-show-source', async () => {
    const container = buildContainer(DIAGRAM)
    await renderMermaidInPlace(container, 'svg')
    const block = blockOf(container)

    setMermaidSourceVisible(block, true)

    expect(block.dataset.showSource).toBe('true')
    expect(container.querySelector<HTMLElement>('pre.md-code-pre')!.hidden).toBe(false)
    expect(container.querySelector('[data-mermaid-toggle]')?.getAttribute('aria-pressed')).toBe('true')

    setMermaidSourceVisible(block, false)

    expect(block.dataset.showSource).toBeUndefined()
    expect(container.querySelector<HTMLElement>('pre.md-code-pre')!.hidden).toBe(true)
    expect(container.querySelector('[data-mermaid-toggle]')?.getAttribute('aria-pressed')).toBe('false')
  })
})

/**
 * Правила отображения живут в CSS (jsdom их не применяет) — проверяем сами
 * объявления: показан рендер → исходник скрыт; показан исходник → рендер скрыт.
 */
describe('mermaid: правила styles/index.css', () => {
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../styles/index.css'),
    'utf-8',
  )

  it('исходник блока с диаграммой скрыт, пока показан рендер', () => {
    expect(css).toContain(".md-code[data-mermaid]:not([data-show-source='true']) pre.md-code-pre")
  })

  it('рендер скрыт, когда показан исходник', () => {
    expect(css).toContain(".md-code[data-mermaid][data-show-source='true'] .md-mermaid-chart")
    expect(css).toContain(".md-code[data-mermaid][data-show-source='true'] .md-mermaid-ascii")
  })

  it('стили диаграммы и ASCII-блока заданы', () => {
    expect(css).toContain('.md-mermaid-chart {')
    expect(css).toContain('.md-mermaid-chart svg {')
    expect(css).toContain('.md-mermaid-ascii {')
    expect(css).toContain('.md-code-toggle {')
  })
})
