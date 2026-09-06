import { useCallback, useSyncExternalStore } from 'react'

function getMql(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  return window.matchMedia(query)
}

function subscribe(query: string, callback: () => void): () => void {
  const mql = getMql(query)
  if (!mql) return () => {}
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', callback)
    return () => mql.removeEventListener('change', callback)
  }
  mql.addListener(callback)
  return () => mql.removeListener(callback)
}

function matches(query: string): boolean {
  return getMql(query)?.matches ?? false
}

/** Реактивная подписка на CSS media-query через useSyncExternalStore. SSR не нужен. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    useCallback((onStoreChange: () => void) => subscribe(query, onStoreChange), [query]),
    useCallback(() => matches(query), [query]),
    useCallback(() => false, [])
  )
}
