import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `plugins.updated` (реестр плагинов слоя расширений или его
 * политика изменились, ADR-090).
 *
 * Баг: «плагин, включённый/снятый в другом клиенте, виден в разделе "Плагины"
 * только после перезагрузки страницы», и то же — для политики слоя
 * (`action: 'policy'`: панель показывает `isOverridden`/`restartRequired` и
 * эффективные значения). Событие публикуется в **инстансный** канал шины (у
 * плагина нет сессии), поэтому диспетчер обязан обработать его раньше проверки
 * `sid`.
 */
const apiMocks = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  getPluginsSettings: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    listPlugins: apiMocks.listPlugins,
    getPluginsSettings: apiMocks.getPluginsSettings,
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    getProjectsPage: vi.fn().mockResolvedValue({
      projects: [],
      total: 0,
      offset: 0,
      limit: 100,
      next_offset: null,
    }),
  },
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { usePluginsStore } from './pluginsStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: plugins.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePluginsStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе плагинов', () => {
    dispatch(makeEvent('plugins.updated', { action: 'install', pluginName: 'demo-plugin' }))

    expect(usePluginsStore.getState().revision).toBe(1)
    // Стор — только сигнал: список читает сам раздел, токенов в событии нет.
    expect(apiMocks.listPlugins).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('plugins.updated', { action: 'enable', pluginName: 'demo-plugin' }, 'instance'))

    expect(usePluginsStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('plugins.updated', { action: 'rollback' }, 'some-other-session'))

    expect(usePluginsStore.getState().revision).toBe(1)
  })

  it('смена политики слоя (`policy`) — тот же сигнал: панель перечитает и снимок', () => {
    dispatch(makeEvent('plugins.updated', { action: 'policy' }, 'instance'))

    expect(usePluginsStore.getState().revision).toBe(1)
    expect(apiMocks.getPluginsSettings).not.toHaveBeenCalled()
  })

  it('весь жизненный цикл плагина инвалидирует реестр', () => {
    for (const action of ['install', 'update', 'approve', 'disable', 'uninstall'] as const) {
      dispatch(makeEvent('plugins.updated', { action, pluginName: 'demo-plugin' }, 'instance'))
    }

    expect(usePluginsStore.getState().revision).toBe(5)
  })
})
