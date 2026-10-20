import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { Icon, isIconName } from './Icon'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/**
 * Каталог встроенных агентов core — источник иконок агентов (`icon` в definition'ах).
 * Ищем вверх от cwd: монорепо (`packages/core/...`) или пакет `core` рядом (`core/...`).
 */
function findCoreAgentDefs(): string | null {
  let dir = process.cwd()
  for (;;) {
    for (const rel of [
      ['core', 'src', 'engine', 'agents', 'definitions'],
      ['packages', 'core', 'src', 'engine', 'agents', 'definitions'],
    ]) {
      const candidate = join(dir, ...rel)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const CORE_AGENT_DEFS = findCoreAgentDefs()

function builtinAgentIcons(): Array<{ file: string; icon: string }> {
  if (!CORE_AGENT_DEFS) return []
  return readdirSync(CORE_AGENT_DEFS)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const def = JSON.parse(readFileSync(join(CORE_AGENT_DEFS, f), 'utf-8')) as { icon?: string }
      return typeof def.icon === 'string' && def.icon.length > 0 ? [{ file: f, icon: def.icon }] : []
    })
}

async function renderIcon(name: string): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<Icon name={name} />)
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

describe('Icon — реестр имён', () => {
  it('newspaper (агент publisher из пакета synth-media) и pencil (агент title) — валидные имена реестра', () => {
    expect(isIconName('newspaper')).toBe(true)
    expect(isIconName('pencil')).toBe(true)
  })

  it('newspaper и pencil резолвятся в компонент, а не в null', async () => {
    for (const name of ['newspaper', 'pencil']) {
      const container = await renderIcon(name)
      expect(container.querySelector('svg'), `иконка "${name}" должна отрисоваться`).not.toBeNull()
    }
  })

  it('неизвестное имя не рисует ничего (Icon возвращает null)', async () => {
    const container = await renderIcon('definitely-not-an-icon')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('иконки встроенных агентов core есть в реестре (иначе Icon вернёт null)', () => {
    const agents = builtinAgentIcons()
    // каталог core недоступен (например, запуск вне монорепо) — проверка не выполняется
    if (agents.length === 0) return
    for (const { file, icon } of agents) {
      expect(isIconName(icon), `агент ${file} → иконка "${icon}"`).toBe(true)
    }
  })
})
