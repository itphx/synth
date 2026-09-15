import { useCallback, useEffect, useState } from 'react'

type FullscreenRequest = () => Promise<void> | void

interface FullscreenDocument extends Document {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: FullscreenRequest
}

interface FullscreenElement extends Element {
  webkitRequestFullscreen?: FullscreenRequest
}

function getDocument(): FullscreenDocument | null {
  return typeof document === 'undefined' ? null : (document as FullscreenDocument)
}

function readSupported(): boolean {
  const doc = getDocument()
  if (!doc) return false
  return Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled)
}

function readFullscreen(): boolean {
  const doc = getDocument()
  if (!doc) return false
  return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement)
}

/**
 * Полноэкранный режим через Fullscreen API с fallback на webkit-префикс.
 * Ориентация не фиксируется. В SSR/jsdom, где API отсутствует, `supported === false`.
 */
export function useFullscreen(): {
  isFullscreen: boolean
  supported: boolean
  toggle: () => void
} {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(readFullscreen)
  const [supported, setSupported] = useState<boolean>(readSupported)

  useEffect(() => {
    const doc = getDocument()
    if (!doc) return

    setSupported(readSupported())
    setIsFullscreen(readFullscreen())

    const handleChange = () => setIsFullscreen(readFullscreen())

    doc.addEventListener('fullscreenchange', handleChange)
    doc.addEventListener('webkitfullscreenchange', handleChange)

    return () => {
      doc.removeEventListener('fullscreenchange', handleChange)
      doc.removeEventListener('webkitfullscreenchange', handleChange)
    }
  }, [])

  const toggle = useCallback(() => {
    const doc = getDocument()
    if (!doc) return

    if (readFullscreen()) {
      const exit = (doc.exitFullscreen as FullscreenRequest | undefined)
        ?? doc.webkitExitFullscreen
      try {
        void Promise.resolve(exit?.call(doc)).catch(() => {})
      } catch {
        // Вызов может быть отклонён (например, без user gesture) — гасим ошибку.
      }
      return
    }

    const target = doc.documentElement as FullscreenElement
    const request = (target.requestFullscreen as FullscreenRequest | undefined)
      ?? target.webkitRequestFullscreen
    try {
      void Promise.resolve(request?.call(target)).catch(() => {})
    } catch {
      // Вызов может быть отклонён (например, без user gesture) — гасим ошибку.
    }
  }, [])

  return { isFullscreen, supported, toggle }
}
