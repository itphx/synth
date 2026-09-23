import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Временное status-сообщение: показывается и само исчезает через `timeoutMs`.
 * Таймер очищается при размонтировании и при новом сообщении — без утечек
 * `setState` после unmount.
 */
export function useTransientMessage(
  timeoutMs = 1500,
): [string | null, (message: string | null) => void] {
  const [message, setMessage] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const show = useCallback(
    (next: string | null) => {
      clear()
      setMessage(next)
      if (next !== null) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          setMessage(null)
        }, timeoutMs)
      }
    },
    [clear, timeoutMs],
  )

  useEffect(() => () => clear(), [clear])

  return [message, show]
}
