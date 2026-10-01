import { useCallback, useEffect, useRef, useState } from 'react'
import { SYNTH_VERSION } from '@itphx/synth-shared/version'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'

/** Уникальный ключ конкретного ожидающего воркера (для «Позже» без «залипания»). */
const workerKeys = new WeakMap<ServiceWorker, string>()
let workerKeySeq = 0
function workerKey(worker: ServiceWorker): string {
  let key = workerKeys.get(worker)
  if (!key) {
    key = `sw-${++workerKeySeq}`
    workerKeys.set(worker, key)
  }
  return key
}

/** Периодическая фоновая проверка обновлений. */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000
/** Простой, после которого первое действие пользователя провоцирует проверку. */
const IDLE_THRESHOLD_MS = 60 * 60 * 1000

/**
 * Баннер обновления PWA/SPA. Показывается в двух случаях:
 * — service worker установил новую версию и ждёт команды (skipWaiting убран из install);
 * — серверная версия (публичный `GET /api/v2/health`) отличается от версии текущего бандла.
 *
 * Версия проверяется при монтировании, раз в 30 минут, при возврате в приложение и
 * на первом действии после длительного простоя — без ручной перезагрузки. Кнопка
 * «Обновить» отправляет SKIP_WAITING (если воркер ждёт), иначе перезагружает страницу.
 * «Позже» скрывает баннер до появления новой версии. Компонент расположен вне
 * `AuthGate`, поэтому работает и на экране входа.
 */
export function PwaUpdatePrompt() {
  const { t } = useI18n()
  const [updateReady, setUpdateReady] = useState(false)
  /** Перезагружаем только если обновление инициировал пользователь. */
  const reloadOnControllerChange = useRef(false)
  /** Ключи отложенных обновлений: новое значение покажет баннер снова. */
  const dismissed = useRef<Set<string>>(new Set())
  /** Текущая регистрация SW и последняя обнаруженная серверная версия. */
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const latestVersion = useRef<string | null>(null)

  const handleUpdate = useCallback(async () => {
    const reg = await navigator.serviceWorker.getRegistration()
    if (reg?.waiting) {
      reloadOnControllerChange.current = true
      reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      // страховка: если controllerchange не придёт — перезагружаемся сами
      window.setTimeout(() => {
        reloadOnControllerChange.current = false
        window.location.reload()
      }, 1500)
    } else {
      // ждать нечего (например, расхождение версий) — перезагружаем страницу
      setUpdateReady(false)
      window.location.reload()
    }
  }, [])

  const handleLater = useCallback(() => {
    const waiting = registrationRef.current?.waiting
    if (waiting) dismissed.current.add(workerKey(waiting))
    if (latestVersion.current) dismissed.current.add(`ver:${latestVersion.current}`)
    setUpdateReady(false)
  }, [])

  useEffect(() => {
    if (!import.meta.env.PROD) return
    if (!('serviceWorker' in navigator)) return

    let registration: ServiceWorkerRegistration | null = null
    let cancelled = false
    let intervalId: number | null = null
    let versionMismatch = false
    let lastActivityAt = Date.now()
    const removeListeners: Array<() => void> = []
    const watchedWorkers = new WeakSet<ServiceWorker>()

    const addListener = (
      target: EventTarget,
      type: string,
      handler: EventListener,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler, options)
      removeListeners.push(() => target.removeEventListener(type, handler, options))
    }

    // Единый пересчёт видимости баннера по обоим источникам (SW.waiting и версия).
    const recompute = () => {
      if (cancelled) return
      const waiting = registration?.waiting
      const swKey = waiting && navigator.serviceWorker.controller ? workerKey(waiting) : null
      const verKey = versionMismatch && latestVersion.current ? `ver:${latestVersion.current}` : null
      const visible =
        (swKey !== null && !dismissed.current.has(swKey)) ||
        (verKey !== null && !dismissed.current.has(verKey))
      setUpdateReady(visible)
    }

    // Сверка версии сервера с версией текущего бандла (публичный health).
    const checkVersion = async () => {
      try {
        const health = await synthApi.getHealth()
        if (cancelled) return
        versionMismatch = health.version !== SYNTH_VERSION
        latestVersion.current = versionMismatch ? health.version : null
        recompute()
      } catch {
        // health недоступен — оставляем прежнее состояние, не мешаем работе
      }
    }

    const checkForUpdate = () => {
      registration?.update().catch(() => {}).then(recompute)
    }

    // `waiting` может появиться позже — следим за его statechange.
    const watchWaiting = (worker: ServiceWorker | null) => {
      if (!worker || watchedWorkers.has(worker)) return
      watchedWorkers.add(worker)
      addListener(worker, 'statechange', recompute)
    }

    const onUpdateFound = () => {
      const installing = registration?.installing
      if (!installing) return
      addListener(installing, 'statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          recompute()
        }
        watchWaiting(registration?.waiting ?? null)
      })
    }

    const onControllerChange = () => {
      // Новый SW принял управление — ждать больше нечего.
      setUpdateReady(false)
      dismissed.current.clear()
      if (!reloadOnControllerChange.current) return
      reloadOnControllerChange.current = false
      window.location.reload()
    }

    // Возврат в приложение — повод проверить обновление (важно для PWA после сна).
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      void checkVersion()
      checkForUpdate()
    }

    // Первое действие после длительного простоя — тоже повод проверить версию.
    const onActivity = () => {
      const now = Date.now()
      if (now - lastActivityAt > IDLE_THRESHOLD_MS) void checkVersion()
      lastActivityAt = now
    }

    // Стабильный URL без `?v=`: версионируется сам файл `/sw.js` (кэш шелла), а
    // `updateViaCache: 'none'` заставляет браузер всегда перепроверять байты.
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        if (cancelled) return
        registration = reg
        registrationRef.current = reg
        watchWaiting(reg.waiting)
        recompute()
        addListener(reg, 'updatefound', onUpdateFound)
      })
      .catch(() => {})

    addListener(navigator.serviceWorker, 'controllerchange', onControllerChange)
    addListener(document, 'visibilitychange', onVisibilityChange)
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      addListener(window, type, onActivity, { passive: true })
    }

    // Проверка при монтировании + периодическая (состояние не «залипает»).
    void checkVersion()
    intervalId = window.setInterval(() => {
      void checkVersion()
      checkForUpdate()
    }, UPDATE_CHECK_INTERVAL_MS)

    return () => {
      cancelled = true
      if (intervalId !== null) window.clearInterval(intervalId)
      for (const remove of removeListeners) remove()
      registrationRef.current = null
    }
  }, [])

  if (!updateReady) return null

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pointer-events-none"
    >
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border bg-background p-3 shadow-lg">
        <Icon name="refresh" className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm text-foreground">{t('pwa.updateAvailable')}</span>
        <button
          type="button"
          onClick={handleLater}
          className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
        >
          {t('pwa.updateLater')}
        </button>
        <button
          type="button"
          onClick={() => void handleUpdate()}
          className="shrink-0 rounded-lg bg-interactive-selection px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-interactive-selection/90"
        >
          {t('pwa.updateNow')}
        </button>
      </div>
    </div>
  )
}
