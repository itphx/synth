import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ACK_BUILD_STORAGE_KEY,
  SHELL_RELOAD_STORAGE_KEY,
  SHELL_RELOAD_WINDOW_MS,
  acknowledgeBuild,
  clearShellCaches,
  consumeShellReloadMarker,
  isBuildAcknowledged,
  markShellReload,
} from './appShell'

describe('appShell (единая перезагрузка после обновления)', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
  })

  it('метка перезагрузки одноразовая и живёт в окне', () => {
    markShellReload(1_000)
    expect(consumeShellReloadMarker(2_000, SHELL_RELOAD_WINDOW_MS)).toBe(true)
    // Второй раз та же метка не срабатывает.
    expect(consumeShellReloadMarker(2_000, SHELL_RELOAD_WINDOW_MS)).toBe(false)
  })

  it('устаревшая метка игнорируется и удаляется', () => {
    markShellReload(1_000)
    expect(consumeShellReloadMarker(1_000 + SHELL_RELOAD_WINDOW_MS + 1)).toBe(false)
    expect(window.sessionStorage.getItem(SHELL_RELOAD_STORAGE_KEY)).toBeNull()
  })

  it('без метки — false (обычная загрузка страницы)', () => {
    expect(consumeShellReloadMarker()).toBe(false)
  })

  it('build id согласуется один раз на конкретную сборку', () => {
    expect(isBuildAcknowledged('abc123')).toBe(false)
    acknowledgeBuild('abc123')
    expect(isBuildAcknowledged('abc123')).toBe(true)
    expect(isBuildAcknowledged('def456')).toBe(false)
    acknowledgeBuild(null)
    expect(window.sessionStorage.getItem(ACK_BUILD_STORAGE_KEY)).toBeNull()
  })

  it('clearShellCaches удаляет все кэши шелла', async () => {
    let keys = ['synth-shell-1', 'synth-shell-2']
    const deleteMock = vi.fn(async (key: string) => {
      keys = keys.filter((item) => item !== key)
      return true
    })
    vi.stubGlobal('caches', { keys: vi.fn(async () => [...keys]), delete: deleteMock })

    await clearShellCaches()

    expect(deleteMock).toHaveBeenCalledTimes(2)
    expect(keys).toEqual([])
  })

  it('clearShellCaches не падает без Cache API', async () => {
    vi.stubGlobal('caches', undefined)
    await expect(clearShellCaches()).resolves.toBeUndefined()
  })
})
