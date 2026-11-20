import { create } from 'zustand'

/**
 * Счётчик изменений словарей классификации (событие шины
 * `dictionaries.updated`, инстансный канал, ADR-034/ADR-035).
 *
 * Список словарей живёт не в сторе, а в секции «Словари»
 * (`DictionarySection` в `components/settings/RoutingSettings.tsx`): стору
 * достаточно поднять `revision`, по нему секция перечитывает список без
 * перезагрузки страницы. Payload события сюда не нужен — в нём только категория,
 * язык и вид мутации (содержимого словаря в событии нет по типу).
 *
 * Баг, ради которого сигнал появился: «словарь, сохранённый или сброшенный во
 * второй вкладке настроек, виден только после перезагрузки страницы» — метка
 * источника (`user`/`system`) и размер словаря оставались прежними.
 */
interface DictionariesStore {
  /** Счётчик изменений словарей. */
  revision: number
  /** Словарь сохранён или сброшен к системному — поднять `revision`. */
  applyEvent: () => void
}

export const useDictionariesStore = create<DictionariesStore>((set) => ({
  revision: 0,
  applyEvent: () => set((s) => ({ revision: s.revision + 1 })),
}))
