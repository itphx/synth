import { useCallback, useEffect, useRef, useState } from 'react'
import { SYNTH_VERSION } from '@itphx/synth-shared/version'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import { BUILD_ID } from '@/lib/build-info'
import { useAuthStore } from '@/stores/authStore'
import { useTransportStore } from '@/stores/transportStore'
import {
  acknowledgeBuild,
  clearShellCaches,
  consumeShellReloadMarker,
  isBuildAcknowledged,
} from '@/lib/appShell'

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
/** Страховка: controllerchange не пришёл — перезагружаемся сами. */
const RELOAD_FALLBACK_MS = 1500
/** Сколько авто-попыток подряд допускается на один и тот же ключ обновления. */
const MAX_AUTO_RELOADS = 2
/** Ключ sessionStorage с защитой от цикла авто-обновления. */
const AUTO_RELOAD_STORAGE_KEY = 'synth.pwa.autoReload'

/**
 * Перезагрузка допустима только когда связь заведомо не нужна или жива:
 * — `guest` — экран входа, транспорта нет (обновление PWA не должно застревать);
 * — `authenticated` + `online` — связь есть;
 * — `checking`/`unreachable` и любая не-`online` фаза транспорта — откладываем
 *   до следующей проверки, иначе приложение перезапускалось бы в разрыв.
 */
function canReloadNow(): boolean {
  const authPhase = useAuthStore.getState().authPhase
  if (authPhase === 'guest') return true
  if (authPhase !== 'authenticated') return false
  return useTransportStore.getState().phase === 'online'
}

interface AutoReloadRecord {
  /** Ключ обновления: `workerKey(waiting)` либо `ver:<version>`. */
  key: string
  /** Сколько авто-попыток уже сделано для этого ключа. */
  count: number
}

/** Прошлая авто-попытка: приватный режим может запретить sessionStorage. */
function readAutoReload(): AutoReloadRecord | null {
  try {
    const raw = window.sessionStorage.getItem(AUTO_RELOAD_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AutoReloadRecord> | null
    if (typeof parsed?.key !== 'string' || typeof parsed.count !== 'number') return null
    return { key: parsed.key, count: parsed.count }
  } catch {
    return null
  }
}

function writeAutoReload(record: AutoReloadRecord): void {
  try {
    window.sessionStorage.setItem(AUTO_RELOAD_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // приватный режим/квота — авто-обновление работает без защиты от цикла
  }
}

/**
 * Авто-обновление PWA/SPA. Обнаружив новую версию, приложение применяет её
 * **само**, без баннера и вопроса:
 * — service worker установил новую версию и ждёт команды (`waiting` при живом
 *   controller) → `SKIP_WAITING` + перезагрузка по `controllerchange` (страховка
 *   через 1.5 с);
 * — идентификатор сборки сервера (`health.build`) отличается от build id
 *   текущего бандла → сброс кэшей шелла, `registration.update()` и одна
 *   перезагрузка (пересборка под той же semver тоже замечается);
 * — build id неизвестен с любой стороны → прежнее сравнение `health.version`
 *   с `SYNTH_VERSION`; расхождение → немедленная перезагрузка страницы.
 *
 * Версия/build проверяются при монтировании, раз в 30 минут, при возврате в
 * приложение и на первом действии после длительного простоя.
 *
 * Защита от цикла: в `sessionStorage` хранится ключ обновления и число
 * авто-попыток. После `MAX_AUTO_RELOADS` попыток на тот же ключ авто-применение
 * отключается — показывается прежний баннер с кнопками «Позже»/«Обновить»
 * (аварийный фоллбек). При смене ключа счётчик сбрасывается.
 *
 * Компонент расположен вне `AuthGate`, поэтому авто-обновление работает и на
 * экране входа.
 */
export function PwaUpdatePrompt() {
  const { t } = useI18n()
  /** Баннер показывается только в аварийном фоллбеке (лимит авто-попыток). */
  const [updateReady, setUpdateReady] = useState(false)
  /** Перезагружаем только если обновление инициировал пользователь. */
  const reloadOnControllerChange = useRef(false)
  /** Ключи отложенных обновлений: новое значение покажет баннер снова. */
  const dismissed = useRef<Set<string>>(new Set())
  /** Текущая регистрация SW и последняя обнаруженная серверная версия. */
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const latestVersion = useRef<string | null>(null)
  /** Серверный build id, разошедшийся с бандлом (для «Позже»/ручного обновления). */
  const latestBuild = useRef<string | null>(null)
  /** Авто-применение уже запрошено в этой загрузке страницы (по ключу). */
  const autoAttempted = useRef<Set<string>>(new Set())
  /** Отложенное (из-за обрыва) обновление: пересчитать при восстановлении связи. */
  const recomputeRef = useRef<(() => void) | null>(null)
  const transportPhase = useTransportStore((s) => s.phase)
  const authPhase = useAuthStore((s) => s.authPhase)

  /** Применить обновление без вопроса. */
  const applyUpdate = useCallback((waiting: ServiceWorker | null, clearCaches = false) => {
    const finish = (pending: ServiceWorker | null) => {
      // Связь потеряна — не перезагружаемся; следующая проверка повторит.
      if (!canReloadNow()) return
      if (pending) {
        reloadOnControllerChange.current = true
        pending.postMessage({ type: 'SKIP_WAITING' })
        // страховка: если controllerchange не придёт — перезагружаемся сами
        window.setTimeout(() => {
          reloadOnControllerChange.current = false
          window.location.reload()
        }, RELOAD_FALLBACK_MS)
        return
      }
      // ждать нечего (например, расхождение версий/build id) — перезагружаем страницу
      setUpdateReady(false)
      window.location.reload()
    }

    if (!clearCaches) {
      finish(waiting)
      return
    }

    // Расхождение build id: сбрасываем кэши → проверяем обновление SW → reload.
    // Свежий `waiting` берём после update(): он мог появиться только что.
    void clearShellCaches().then(async () => {
      const reg =
        registrationRef.current ??
        (await navigator.serviceWorker.getRegistration().catch(() => undefined))
      if (!reg) {
        finish(waiting)
        return
      }
      await reg.update().catch(() => {})
      finish(reg.waiting ?? waiting)
    })
  }, [])

  /**
   * Попробовать применить обновление автоматически.
   * `true` — применять/уже применено (баннер не нужен), `false` — лимит
   * авто-попыток исчерпан (показываем аварийный баннер).
   */
  const tryAutoApply = useCallback(
    (key: string, waiting: ServiceWorker | null, clearCaches = false): boolean => {
      // Не расходуем авто-попытку в разрыве: применим, когда связь вернётся.
      if (!canReloadNow()) return true
      if (autoAttempted.current.has(key)) return true
      const prev = readAutoReload()
      const count = prev && prev.key === key ? prev.count : 0
      if (count >= MAX_AUTO_RELOADS) return false
      autoAttempted.current.add(key)
      // Смена ключа (новый воркер/версия/build id) — счётчик начинается с 1.
      writeAutoReload({ key, count: count + 1 })
      applyUpdate(waiting, clearCaches)
      return true
    },
    [applyUpdate],
  )

  /** Ручное обновление из аварийного баннера. */
  const handleUpdate = useCallback(async () => {
    // Build mismatch: без сброса кэшей перезагрузка вернёт тот же старый шелл.
    if (latestBuild.current) await clearShellCaches()
    const reg = await navigator.serviceWorker.getRegistration()
    if (reg?.waiting) {
      reloadOnControllerChange.current = true
      reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      // страховка: если controllerchange не придёт — перезагружаемся сами
      window.setTimeout(() => {
        reloadOnControllerChange.current = false
        window.location.reload()
      }, RELOAD_FALLBACK_MS)
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
    if (latestBuild.current) dismissed.current.add(`build:${latestBuild.current}`)
    setUpdateReady(false)
  }, [])

  useEffect(() => {
    if (!import.meta.env.PROD) return
    if (!('serviceWorker' in navigator)) return

    let registration: ServiceWorkerRegistration | null = null
    let cancelled = false
    let intervalId: number | null = null
    let versionMismatch = false
    let buildMismatch = false
    let lastActivityAt = Date.now()
    // Страницу только что перезагрузили ради обновления (блок «Обновления» или
    // прошлая авто-перезагрузка): до первого ответа `/health` этой загрузки
    // авто-применение не запускаем — иначе waiting-SW успеет перезагрузить
    // страницу второй раз.
    let shellReloadGrace = consumeShellReloadMarker()
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

    // Единый пересчёт по трём источникам (build id, SW.waiting, версия):
    // сначала авто-применение, баннер — только когда авто-попытки исчерпаны.
    const recompute = () => {
      if (cancelled) return
      const waiting = registration?.waiting
      const swKey = waiting && navigator.serviceWorker.controller ? workerKey(waiting) : null
      const buildKey = buildMismatch && latestBuild.current ? `build:${latestBuild.current}` : null
      const verKey = versionMismatch && latestVersion.current ? `ver:${latestVersion.current}` : null

      // Перезагрузка уже была ради этой сборки (блок «Обновления») — не делаем
      // вторую: ожидающий воркер принимаем молча, авто-применение не запускаем.
      if (shellReloadGrace) {
        if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' })
        const graceKeys = [swKey, buildKey, verKey].filter((key): key is string => Boolean(key))
        for (const key of graceKeys) autoAttempted.current.add(key)
        setUpdateReady(false)
        return
      }

      // Расхождение build id — самый сильный сигнал (waiting SW может быть
      // старой сборки): сброс кэшей → update SW → reload.
      if (buildKey) {
        if (tryAutoApply(buildKey, waiting ?? null, true)) {
          setUpdateReady(false)
          return
        }
        setUpdateReady(!dismissed.current.has(buildKey))
        return
      }

      if (swKey) {
        if (tryAutoApply(swKey, waiting ?? null)) {
          setUpdateReady(false)
          return
        }
        // Лимит на этот воркер — аварийный баннер, версию не трогаем.
        setUpdateReady(!dismissed.current.has(swKey))
        return
      }

      if (verKey) {
        if (tryAutoApply(verKey, null)) {
          setUpdateReady(false)
          return
        }
        setUpdateReady(!dismissed.current.has(verKey))
        return
      }

      setUpdateReady(false)
    }
    // Дать внешнему эффекту (смена фазы связи/authPhase) повторить пересчёт,
    // не дожидаясь 30-минутного интервала.
    recomputeRef.current = recompute

    // Сверка сборки/версии сервера с текущим бандлом (публичный health).
    // Приоритет — build id; semver сравнивается только когда build id пуст
    // с любой стороны (локальная сборка/старый сервер).
    const checkVersion = async () => {
      // Свёрнутое/фоновое приложение не проверяет версию (не будим сеть зря).
      if (document.visibilityState === 'hidden') return
      try {
        const health = await synthApi.getHealth()
        if (cancelled) return
        const serverBuild = health.build ?? ''
        const buildKnown = Boolean(serverBuild) && Boolean(BUILD_ID)
        buildMismatch = buildKnown && serverBuild !== BUILD_ID && !isBuildAcknowledged(serverBuild)
        versionMismatch = !buildKnown && health.version !== SYNTH_VERSION
        latestBuild.current = buildMismatch ? serverBuild : null
        latestVersion.current = versionMismatch ? health.version : null
        if (shellReloadGrace) {
          // Первый health после перезагрузки ради обновления: shell уже новый,
          // второй reload не нужен. Несовпадение build id запоминаем как
          // согласованное (иначе PWA перезагружал бы страницу на каждой проверке,
          // когда `SYNTH_BUILD_ID` остался от образа, а пакет обновлён из npm).
          shellReloadGrace = false
          if (buildMismatch) acknowledgeBuild(serverBuild)
          buildMismatch = false
          versionMismatch = false
          latestBuild.current = null
          latestVersion.current = null
          const waiting = registration?.waiting
          if (waiting) {
            waiting.postMessage({ type: 'SKIP_WAITING' })
            autoAttempted.current.add(workerKey(waiting))
          }
        }
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
      recomputeRef.current = null
    }
  }, [tryAutoApply])

  // Связь восстановилась (или пользователь вышел на экран входа) — применяем
  // отложенное обновление тем же `recompute()`, без новых таймеров.
  useEffect(() => {
    recomputeRef.current?.()
  }, [transportPhase, authPhase])

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
