import { useEffect, useRef } from 'react'

export function useAutoScroll(targetId: string | null) {
  const pendingRef = useRef<string | null>(null)

  useEffect(() => {
    pendingRef.current = targetId
  }, [targetId])

  useEffect(() => {
    const id = pendingRef.current
    if (!id) return
    const timer = setTimeout(() => {
      // Безопасность окружения: в jsdom/SSR и после teardown jsdom глобальные
      // `CSS`/`document` и `Element.scrollIntoView` могут отсутствовать —
      // тихо выходим, наблюдаемое поведение в браузере не меняется.
      if (typeof document === 'undefined') return
      const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id
      const el = document.querySelector(`[data-tree-node="${escaped}"]`)
      if (el) {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
        pendingRef.current = null
      }
    }, 80)
    return () => clearTimeout(timer)
  }, [])
}
