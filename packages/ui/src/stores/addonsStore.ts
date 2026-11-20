import { create } from 'zustand'

/**
 * Счётчик изменений реестра пакетов расширений (событие шины `packs.updated`,
 * ADR-086 §5, инстансный канал).
 *
 * Реестр установок живёт не в сторе, а в компоненте (`AddonsSettings` грузит его
 * своим запросом `GET /api/v2/packs`): стору достаточно поднять `revision`, по
 * нему админ-раздел перечитывает реестр без перезагрузки страницы. Payload
 * события сюда не нужен — в нём только имя пакета и вид мутации (манифеста и
 * карты файлов в событии нет по типу).
 */
interface AddonsStore {
  /** Счётчик изменений реестра пакетов расширений. */
  revision: number
  /** Пакет установлен/одобрен/снят — поднять `revision`. */
  applyEvent: () => void
}

export const useAddonsStore = create<AddonsStore>((set) => ({
  revision: 0,
  applyEvent: () => set((s) => ({ revision: s.revision + 1 })),
}))
