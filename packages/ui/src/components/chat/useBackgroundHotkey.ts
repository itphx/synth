// ADR-111 §detach: горячая клавиша `ctrl+b` — перевести все идущие блокирующие
// прогоны активной сессии в фон. Образец глобального `keydown` — `QuestionDock`
// (`ctrl+enter`) и `FileEditorTab` (`ctrl+s`): слушатель на `window`, снимается
// на размонтировании.

import { useEffect, useRef } from 'react'
import { moveSessionToBackground } from '@/lib/backgroundDetach'

/**
 * Глобальный `ctrl+b` в чате.
 *
 * Активна только пока сессия стримит (`enabled`). Не срабатывает при
 * автоповторе (`e.repeat`), во время IME-композиции (`e.isComposing`) и когда
 * фокус в `contenteditable` — там `ctrl+b` оставляем браузеру (ввод не ломаем).
 */
export function useBackgroundHotkey(sessionId: string, enabled: boolean): void {
  const inFlight = useRef(false)

  useEffect(() => {
    if (!enabled || !sessionId) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'b') return
      if (event.repeat || event.isComposing) return
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      // jsdom не реализует `isContentEditable` — страхуемся атрибутом.
      if (target?.closest?.('[contenteditable]:not([contenteditable="false"])')) return
      if (inFlight.current) return

      event.preventDefault()
      inFlight.current = true
      void moveSessionToBackground(sessionId).finally(() => {
        inFlight.current = false
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionId, enabled])
}
