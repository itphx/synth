/**
 * Память позиции прокрутки ленты чата — **на сессию**, а не на вкладку.
 *
 * Почему это отдельный модуль. `CenterPanel` рендерит только активную вкладку,
 * но вкладки одного типа реконсилируются React'ом **без размонтирования**:
 * `<ChatTab tab={activeTab} />` (и внутри — `MessageList`) получает новый
 * `tab`/`sessionId`, а вместе с ним по наследству — `scrollTop` контейнера и
 * флаг «приклеен к низу» (`autoScroll`) предыдущей сессии. В результате
 * переход «основная сессия → дочерняя (саб-агент) → обратно» оставлял ленту
 * основной сессии там, где её оставили в дочерней (прокрутили начало прогона
 * ребёнка — основная открывалась вверху), и наоборот: автоскролл вниз после
 * возврата не срабатывал, потому что `autoScroll` уже был снят чужой лентой.
 *
 * Поэтому позиция запоминается здесь по `sessionId` и восстанавливается в
 * `MessageList` при монтировании/смене сессии — уже **после** фактической
 * отрисовки ленты (см. `useChatScrollRestore`-эффект в `MessageList`).
 *
 * Память ограничена последними {@link CHAT_SCROLL_MEMORY_LIMIT} сессиями
 * (LRU по записи): вкладок и сессий за долгую работу много, а держать историю
 * прокрутки всех сессий инстанса незачем. Точечная чистка — `forgetChatScroll`
 * (вызывается при удалении сессии).
 */
export interface ChatScrollState {
  /** Прокрутка была «приклеена» к низу — при возврате держим низ (с новыми сообщениями). */
  atBottom: boolean
  /** Числовая позиция (px от начала ленты) — восстанавливается, если не были внизу. */
  scrollTop: number
}

/** Сколько сессий помним (последние записанные). */
export const CHAT_SCROLL_MEMORY_LIMIT = 20

/** Порядок в `Map` — порядок записи: первая запись самая старая (её и вытесняем). */
const memory = new Map<string, ChatScrollState>()

/**
 * Запомнить позицию прокрутки сессии.
 *
 * Повторная запись переносит сессию в конец очереди (она «свежая»), поэтому
 * вытесняются именно те сессии, к которым дольше всего не возвращались.
 * `scrollTop` нормализуется: отрицательные/нечисловые значения не должны
 * ломать восстановление.
 */
export function rememberChatScroll(sessionId: string, state: ChatScrollState): void {
  if (!sessionId) return
  const scrollTop = Number.isFinite(state.scrollTop) ? Math.max(0, state.scrollTop) : 0
  memory.delete(sessionId)
  memory.set(sessionId, { atBottom: state.atBottom === true, scrollTop })
  while (memory.size > CHAT_SCROLL_MEMORY_LIMIT) {
    const oldest = memory.keys().next()
    if (oldest.done) break
    memory.delete(oldest.value)
  }
}

/** Позиция прокрутки сессии; `null` — сессию ещё не запоминали. */
export function readChatScroll(sessionId: string): ChatScrollState | null {
  const state = memory.get(sessionId)
  if (!state) return null
  return { atBottom: state.atBottom, scrollTop: state.scrollTop }
}

/** Забыть сессию (удаление сессии, «забыть всё» в тестах). */
export function forgetChatScroll(sessionId: string): void {
  memory.delete(sessionId)
}

/** Полная очистка памяти (тесты, выход из аккаунта). */
export function clearChatScrollMemory(): void {
  memory.clear()
}

/** Сколько сессий сейчас в памяти (тесты/диагностика). */
export function chatScrollMemorySize(): number {
  return memory.size
}
