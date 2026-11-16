/**
 * `scrollShadowState` — признаки затенения краёв терминала (PROP-132).
 *
 * Контракт — как у чата (`MessageList.handleScroll`): **два независимых**
 * признака вместо одного «положения скролла». Сверху контент есть, когда
 * вьюпорт уехал вниз от начала буфера; снизу — когда он не в самом низу.
 */
import { describe, it, expect } from 'vitest'

import { scrollShadowState } from './terminalScroll'

describe('scrollShadowState — затенение краёв терминала', () => {
  it('пустой буфер: затенения нет ни с одной стороны', () => {
    expect(scrollShadowState(0, 0)).toEqual({ hasTop: false, hasBottom: false })
  })

  it('вывод помещается целиком (baseY = 0): затенения нет', () => {
    expect(scrollShadowState(0, 0)).toEqual({ hasTop: false, hasBottom: false })
  })

  it('в начале непустого буфера: затенён только низ', () => {
    expect(scrollShadowState(0, 10)).toEqual({ hasTop: false, hasBottom: true })
  })

  it('в середине буфера: затенены оба края', () => {
    expect(scrollShadowState(5, 10)).toEqual({ hasTop: true, hasBottom: true })
  })

  it('в самом низу буфера: затенён только верх', () => {
    expect(scrollShadowState(10, 10)).toEqual({ hasTop: true, hasBottom: false })
  })
})
