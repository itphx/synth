import { describe, expect, it } from 'vitest'
import {
  clampOffset,
  clampScale,
  MAX_SCALE,
  MIN_SCALE,
  zoomAtPoint,
  type ZoomBounds,
  type ZoomState,
} from './imageZoom'

const bounds: ZoomBounds = {
  contentWidth: 1000,
  contentHeight: 800,
  viewportWidth: 500,
  viewportHeight: 400,
}

describe('clampScale', () => {
  it('держит диапазон [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.5)).toBe(MIN_SCALE)
    expect(clampScale(3)).toBe(3)
    expect(clampScale(100)).toBe(MAX_SCALE)
    expect(clampScale(MAX_SCALE + 1)).toBe(MAX_SCALE)
  })

  it('NaN и Infinity не ломают масштаб', () => {
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE)
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(MAX_SCALE)
  })
})

describe('clampOffset', () => {
  it('при масштабе 1 смещение всегда 0', () => {
    expect(clampOffset(500, -500, bounds, 1)).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('ограничивает смещение половиной разницы содержимого и окна', () => {
    // content 1000 * scale 2 = 2000, viewport 500 → maxX = 750
    const state = clampOffset(10_000, -10_000, bounds, 2)
    expect(state.scale).toBe(2)
    expect(state.x).toBe(750)
    expect(state.y).toBe(-600) // 800 * 2 = 1600, viewport 400 → 600
  })

  it('сохраняет смещение внутри допустимого диапазона', () => {
    expect(clampOffset(100, -200, bounds, 2)).toEqual({ scale: 2, x: 100, y: -200 })
  })

  it('нулевые размеры (до layout) дают 0, а не NaN', () => {
    const empty: ZoomBounds = {
      contentWidth: 0,
      contentHeight: 0,
      viewportWidth: 0,
      viewportHeight: 0,
    }
    const state = clampOffset(100, 100, empty, 3)
    expect(state).toEqual({ scale: 3, x: 0, y: 0 })
    expect(Number.isNaN(state.x)).toBe(false)
    expect(Number.isNaN(state.y)).toBe(false)
  })

  it('NaN в смещении схлопывается в 0', () => {
    const state = clampOffset(Number.NaN, Number.NaN, bounds, 2)
    expect(state.x).toBe(0)
    expect(state.y).toBe(0)
  })
})

describe('zoomAtPoint', () => {
  const base: ZoomState = { scale: 1, x: 0, y: 0 }

  it('зум вокруг центра не смещает изображение', () => {
    const state = zoomAtPoint(base, 2, { x: 0, y: 0 }, bounds)
    expect(state.scale).toBe(2)
    expect(state.x).toBe(0)
    expect(state.y).toBe(0)
  })

  it('точка под якорем остаётся на месте', () => {
    // Масштаб 1 → 2 вокруг точки x=100: точка контента (100) должна остаться
    // под курсором → смещение -100.
    const state = zoomAtPoint(base, 2, { x: 100, y: 50 })
    expect(state.scale).toBe(2)
    expect(state.x).toBe(-100)
    expect(state.y).toBe(-50)
  })

  it('не выходит за MAX_SCALE и пределы смещения', () => {
    const zoomed: ZoomState = { scale: MAX_SCALE, x: 0, y: 0 }
    const state = zoomAtPoint(zoomed, 2, { x: 0, y: 0 }, bounds)
    expect(state).toEqual({ scale: MAX_SCALE, x: 0, y: 0 })
  })

  it('нулевые размеры не дают NaN', () => {
    const empty: ZoomBounds = {
      contentWidth: 0,
      contentHeight: 0,
      viewportWidth: 0,
      viewportHeight: 0,
    }
    const state = zoomAtPoint(base, 4, { x: 30, y: 40 }, empty)
    expect(state.scale).toBe(4)
    expect(state.x).toBe(0)
    expect(state.y).toBe(0)
  })

  it('нечисловой коэффициент не меняет состояние', () => {
    const state = zoomAtPoint(base, Number.NaN, { x: 10, y: 10 })
    expect(state).toEqual(base)
  })
})
