import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { synthApi } from '@/lib/api/synthApi'
import {
  GROUPS_CATALOG_LIMIT,
  GROUPS_CATALOG_SEARCH_DEBOUNCE_MS,
  useGroupsCatalog,
  type GroupsCatalog,
} from './useGroupsCatalog'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Каталог групп (ADR-140 Ф2) — форма `useUsersDirectory`, но для групп:
 * выключенный каталог не ходит в API, поиск уходит на сервер (`q`) после
 * debounce, ошибка отличается от пустого каталога (`failed`).
 */

const page = (names: string[]) => ({
  groups: names.map((name) => ({ name })),
  total: names.length,
  offset: 0,
  limit: GROUPS_CATALOG_LIMIT,
  next_offset: null,
})

let latest: GroupsCatalog | null = null

/** Текущее состояние хука (после последнего рендера пробника). */
function catalog(): GroupsCatalog {
  if (!latest) throw new Error('хук не смонтирован')
  return latest
}

function Probe({ enabled }: { enabled: boolean }) {
  latest = useGroupsCatalog(enabled)
  return null
}

type Mounted = { host: HTMLElement; root: Root }

const mounted: Mounted[] = []

async function mountProbe(enabled: boolean): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<Probe enabled={enabled} />)
  })
  // Разрешить промис загрузки каталога (ответ мока — уже готовый промис).
  await act(async () => {})
}

beforeEach(() => {
  vi.useFakeTimers()
  latest = null
})

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useGroupsCatalog', () => {
  it('enabled=false: каталог пуст, failed=false, запросов нет', async () => {
    const spy = vi.spyOn(synthApi, 'getGroupsDirectory').mockResolvedValue(page(['platform']))

    await mountProbe(false)

    expect(spy).not.toHaveBeenCalled()
    expect(catalog().groups).toEqual([])
    expect(catalog().total).toBe(0)
    expect(catalog().failed).toBe(false)
    expect(catalog().loading).toBe(false)
  })

  it('enabled=true: каталог загружается', async () => {
    const spy = vi
      .spyOn(synthApi, 'getGroupsDirectory')
      .mockResolvedValue(page(['platform', 'team-a']))

    await mountProbe(true)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ limit: GROUPS_CATALOG_LIMIT })
    expect(catalog().groups).toEqual([{ name: 'platform' }, { name: 'team-a' }])
    expect(catalog().total).toBe(2)
    expect(catalog().failed).toBe(false)
  })

  it('смена query уходит в q после debounce', async () => {
    const spy = vi.spyOn(synthApi, 'getGroupsDirectory').mockResolvedValue(page(['platform']))

    await mountProbe(true)
    expect(spy).toHaveBeenCalledTimes(1)

    await act(async () => {
      catalog().setQuery('plat')
    })
    // До debounce сервер не дёргаем.
    expect(spy).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(GROUPS_CATALOG_SEARCH_DEBOUNCE_MS)
    })
    await act(async () => {})

    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenLastCalledWith({ limit: GROUPS_CATALOG_LIMIT, q: 'plat' })
  })

  it('ошибка загрузки: failed=true (пусто ≠ ошибка)', async () => {
    vi.spyOn(synthApi, 'getGroupsDirectory').mockRejectedValue(new Error('boom'))

    await mountProbe(true)

    expect(catalog().failed).toBe(true)
    expect(catalog().groups).toEqual([])
    expect(catalog().total).toBe(0)
  })

  it('reload перечитывает каталог', async () => {
    const spy = vi.spyOn(synthApi, 'getGroupsDirectory').mockResolvedValue(page(['platform']))

    await mountProbe(true)
    expect(spy).toHaveBeenCalledTimes(1)

    await act(async () => {
      catalog().reload()
    })
    await act(async () => {})

    expect(spy).toHaveBeenCalledTimes(2)
  })
})
