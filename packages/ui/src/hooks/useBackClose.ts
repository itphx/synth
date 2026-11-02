/**
 * Закрытие оверлеев системной кнопкой «назад» (Android/PWA).
 *
 * PWA открывается в `display: standalone`, поэтому при пустой истории браузера
 * Android-назад сворачивает приложение. Решение: пока оверлей открыт, в историю
 * кладётся **своя** запись (`history.pushState`), а `popstate` закрывает верхний
 * оверлей — приложение остаётся на месте.
 *
 * Стек нужен, чтобы вложенные оверлеи закрывались по одному: один `back` —
 * верхняя запись. Программное закрытие (крестик/backdrop/Esc) снимает свою
 * запись и делает `history.back()`, чтобы не копить мусор в истории; такое
 * «своё» `popstate` **подавляется**, иначе оно закрыло бы оверлей под ним.
 */
import { useEffect, useRef } from 'react'

interface BackEntry {
  id: number
  close: () => void
}

const stack: BackEntry[] = []
let seq = 0
/** Сколько ближайших `popstate` — следствие нашего `history.back()`. */
let suppress = 0
let listenerAttached = false

const OVERLAY_STATE_KEY = 'synthBackOverlay'

function onPopState(): void {
  if (suppress > 0) {
    suppress -= 1
    return
  }
  const entry = stack.pop()
  if (!entry) return
  entry.close()
}

function ensureListener(): void {
  if (listenerAttached || typeof window === 'undefined') return
  window.addEventListener('popstate', onPopState)
  listenerAttached = true
}

/**
 * Положить запись истории для оверлея. Возвращает disposer: он же вызывается
 * на unmount оверлея и снимает запись, если оверлей закрыли программно.
 */
function pushEntry(close: () => void): () => void {
  if (typeof window === 'undefined' || !window.history) return () => {}
  ensureListener()
  const id = ++seq
  stack.push({ id, close })
  window.history.pushState(
    { ...((window.history.state as Record<string, unknown> | null) ?? {}), [OVERLAY_STATE_KEY]: id },
    '',
  )

  let active = true
  return () => {
    if (!active) return
    active = false
    const index = stack.findIndex((entry) => entry.id === id)
    // Запись уже снята popstate'ом — history.back() не нужен.
    if (index === -1) return
    const wasTop = index === stack.length - 1
    stack.splice(index, 1)
    const state = window.history.state as Record<string, unknown> | null
    if (wasTop && state?.[OVERLAY_STATE_KEY] === id) {
      suppress += 1
      window.history.back()
    }
  }
}

/**
 * Регистрирует оверлей в стеке «назад», пока он открыт.
 *
 * `close` можно передавать нестабильной ссылкой: хук хранит её в ref и
 * перерегистрирует запись только при изменении `open`.
 */
export function useBackClose(open: boolean, close: () => void): void {
  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  }, [close])
  useEffect(() => {
    if (!open) return
    return pushEntry(() => closeRef.current())
  }, [open])
}

/** Сброс состояния модуля — только для тестов. */
export function __resetBackCloseForTests(): void {
  stack.length = 0
  suppress = 0
  seq = 0
  if (listenerAttached && typeof window !== 'undefined') {
    window.removeEventListener('popstate', onPopState)
  }
  listenerAttached = false
}
