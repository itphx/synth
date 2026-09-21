import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  useSettingsDraft,
  type UseSettingsDraftOptions,
  type UseSettingsDraftResult,
} from './useSettingsDraft'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Cfg {
  a: number
  b?: number
}

const mounted: Array<{ root: Root; host: HTMLElement }> = []

function makeHarness<T>() {
  const holder: { current: UseSettingsDraftResult<T> | null } = { current: null }
  function Harness({ opts }: { opts: UseSettingsDraftOptions<T> }) {
    holder.current = useSettingsDraft(opts)
    return null
  }
  return { holder, Harness }
}

async function renderHook<T>(opts: UseSettingsDraftOptions<T>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  const { holder, Harness } = makeHarness<T>()
  await act(async () => {
    root.render(<Harness opts={opts} />)
  })
  const current = () => holder.current as UseSettingsDraftResult<T>
  const rerender = async (next: UseSettingsDraftOptions<T>) => {
    await act(async () => {
      root.render(<Harness opts={next} />)
    })
  }
  return { current, rerender }
}

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()
  }
  document.body.innerHTML = ''
})

describe('useSettingsDraft', () => {
  it('инициализируется из value и становится dirty при правке; revert возвращает saved', async () => {
    const { current } = await renderHook<Cfg>({ value: { a: 1 } })
    expect(current().draft).toEqual({ a: 1 })
    expect(current().saved).toEqual({ a: 1 })
    expect(current().dirty).toBe(false)

    await act(async () => {
      current().setDraft({ a: 2 })
    })
    expect(current().draft).toEqual({ a: 2 })
    expect(current().dirty).toBe(true)

    await act(async () => {
      current().revert()
    })
    expect(current().draft).toEqual({ a: 1 })
    expect(current().dirty).toBe(false)
  })

  it('update патчит черновик', async () => {
    const { current } = await renderHook<Cfg>({ value: { a: 1, b: 1 } })
    await act(async () => {
      current().update({ b: 2 })
    })
    expect(current().draft).toEqual({ a: 1, b: 2 })
    expect(current().dirty).toBe(true)
  })

  it('save вызывает onSave и обновляет saved/draft возвращённым значением', async () => {
    const onSave = vi.fn(async (draft: Cfg) => ({ a: draft.a + 10 }))
    const { current } = await renderHook<Cfg>({ value: { a: 1 }, onSave })
    await act(async () => {
      current().setDraft({ a: 2 })
    })

    let ok = false
    await act(async () => {
      ok = await current().save()
    })

    expect(ok).toBe(true)
    expect(onSave).toHaveBeenCalledWith({ a: 2 })
    expect(current().saved).toEqual({ a: 12 })
    expect(current().draft).toEqual({ a: 12 })
    expect(current().dirty).toBe(false)
    expect(current().saving).toBe(false)
  })

  it('save — no-op без изменений (onSave не вызывается)', async () => {
    const onSave = vi.fn(async () => undefined)
    const { current } = await renderHook<Cfg>({ value: { a: 1 }, onSave })

    let ok = true
    await act(async () => {
      ok = await current().save()
    })

    expect(ok).toBe(false)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('save возвращает false и не зависает в saving при ошибке', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('boom')
    })
    const { current } = await renderHook<Cfg>({ value: { a: 1 }, onSave })
    await act(async () => {
      current().setDraft({ a: 2 })
    })

    let ok = true
    await act(async () => {
      ok = await current().save()
    })

    expect(ok).toBe(false)
    expect(current().saving).toBe(false)
    expect(current().dirty).toBe(true)
  })

  it('внешний value обновляет saved и draft, пока нет правок', async () => {
    const { current, rerender } = await renderHook<Cfg>({ value: { a: 1 } })
    await rerender({ value: { a: 5 } })
    expect(current().saved).toEqual({ a: 5 })
    expect(current().draft).toEqual({ a: 5 })
    expect(current().dirty).toBe(false)
  })

  it('внешний value не затирает dirty-черновик', async () => {
    const { current, rerender } = await renderHook<Cfg>({ value: { a: 1 } })
    await act(async () => {
      current().setDraft({ a: 2 })
    })
    await rerender({ value: { a: 5 } })
    expect(current().saved).toEqual({ a: 5 })
    expect(current().draft).toEqual({ a: 2 })
    expect(current().dirty).toBe(true)
  })

  it('isDefault и resetToDefault работают от defaultValue', async () => {
    const { current } = await renderHook<Cfg>({ value: { a: 1 }, defaultValue: { a: 0 } })
    expect(current().isDefault).toBe(false)

    await act(async () => {
      current().resetToDefault()
    })
    expect(current().draft).toEqual({ a: 0 })
    expect(current().isDefault).toBe(true)
    expect(current().dirty).toBe(true)
  })

  it('resetToDefault без defaultValue — no-op', async () => {
    const { current } = await renderHook<Cfg>({ value: { a: 1 } })
    await act(async () => {
      current().resetToDefault()
    })
    expect(current().draft).toEqual({ a: 1 })
  })
})
