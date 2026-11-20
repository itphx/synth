import { create } from 'zustand'

/**
 * Счётчик изменений реестра сниппетов (событие шины `snippets.updated`,
 * ADR-126 §4, инстансный канал).
 *
 * Список сниппетов живёт не в сторе, а в компонентах: редактор уровня
 * (`SnippetScopeEditor` — настройки, админ-раздел и панель проекта) грузит его
 * запросом `GET /api/v2/snippets?scope=…`, `#`-пикер композера
 * (`SnippetAutocomplete`) — тем же запросом по проекту сессии. Стору достаточно
 * поднять `revision`, по нему оба перечитывают свой список без перезагрузки
 * страницы. Payload события сюда не нужен — в нём только имя сниппета и вид
 * мутации (текста сниппета и описания в событии нет по типу).
 */
interface SnippetsStore {
  /** Счётчик изменений реестра сниппетов. */
  revision: number
  /** Сниппет создан/изменён/удалён — поднять `revision`. */
  applyEvent: () => void
}

export const useSnippetsStore = create<SnippetsStore>((set) => ({
  revision: 0,
  applyEvent: () => set((s) => ({ revision: s.revision + 1 })),
}))
