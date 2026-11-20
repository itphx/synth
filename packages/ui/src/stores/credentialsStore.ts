import { create } from 'zustand'

/**
 * Счётчик изменений слоя внешних доступов (событие шины `credentials.updated`,
 * ADR-105, инстансный канал).
 *
 * Список доступов живёт не в сторе, а в компоненте (`CredentialsSettings`
 * грузит его своим запросом `GET /oauth/credentials`): стору достаточно
 * поднять `revision`, по нему раздел перечитывает список без перезагрузки
 * страницы. Payload события сюда не нужен — в нём только id/провайдер и вид
 * мутации (токенов в событии нет по типу).
 */
interface CredentialsStore {
  /** Счётчик изменений списка внешних доступов. */
  revision: number
  /** Доступ выдан/отозван/обновлён/привязан — поднять `revision`. */
  applyEvent: () => void
}

export const useCredentialsStore = create<CredentialsStore>((set) => ({
  revision: 0,
  applyEvent: () => set((s) => ({ revision: s.revision + 1 })),
}))
