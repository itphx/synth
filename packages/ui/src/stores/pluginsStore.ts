import { create } from 'zustand'

/**
 * Счётчик изменений реестра плагинов слоя расширений (событие шины
 * `plugins.updated`, ADR-090, инстансный канал).
 *
 * Реестр и снимок политики живут не в сторе, а в компоненте (`PluginsSettings`
 * грузит их запросами `GET /api/v2/plugins` и `GET /api/v2/settings/plugins`):
 * стору достаточно поднять `revision`, по нему раздел перечитывает и список, и
 * политику без перезагрузки страницы. Payload события сюда не нужен — в нём
 * только имя плагина и вид мутации (токенов, ключей и источников установки в
 * событии нет по типу — инвариант 13).
 */
interface PluginsStore {
  /** Счётчик изменений реестра плагинов и снимка политики слоя. */
  revision: number
  /** Плагин установлен/обновлён/активирован/снят либо изменена политика — поднять `revision`. */
  applyEvent: () => void
}

export const usePluginsStore = create<PluginsStore>((set) => ({
  revision: 0,
  applyEvent: () => set((s) => ({ revision: s.revision + 1 })),
}))
