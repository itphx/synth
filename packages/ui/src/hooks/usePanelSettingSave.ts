import { useCallback, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'

/** Окно подавления повторных success-тостов по умолчанию (мс). */
export const PANEL_SAVE_THROTTLE_MS = 1500

/**
 * Ключ error-тоста: строка либо функция, выбирающая ключ по ошибке
 * (для спец-ошибок вроде 403 forbidden / 409 confirm-required).
 */
export type PanelSettingErrorKey = string | ((error: unknown) => string | undefined)

export interface PanelSettingSaveOptions {
  /** Минимальный интервал между success-тостами (мс); `<= 0` — без троттлинга. */
  throttleMs?: number
  /** Ключ success-тоста по умолчанию (`panel.saved`). */
  successKey?: string
  /** Ключ error-тоста по умолчанию (`panel.saveError`). */
  errorKey?: PanelSettingErrorKey
  /** Сессия для истории уведомлений (пробрасывается в `notify`). */
  sessionId?: string
}

export interface PanelSettingRunOptions<T> {
  /** Идентификатор контрола — по нему считается pending (проп `Toggle.pending`). */
  key: string
  /** Асинхронное сохранение; ошибку хук ловит сам (наружу не бросает). */
  run: () => Promise<T>
  /** Успех: обновление локального состояния/списка (до success-тоста). */
  onSuccess?: (result: T) => void
  /** Ошибка: откат оптимистичного UI к серверному состоянию. */
  onError?: (error: unknown) => void
  successKey?: string
  errorKey?: PanelSettingErrorKey
  /** Не показывать success-тост (например, промежуточный шаг подтверждения). */
  silentSuccess?: boolean
  /** Не показывать error-тост (ошибку обрабатывает вызывающий код). */
  silentError?: boolean
}

export interface PanelSettingSave {
  /** Выполнить сохранение: pending по `key`, success/error-тосты, откат. */
  run<T>(options: PanelSettingRunOptions<T>): Promise<T | undefined>
  /** Идёт ли сохранение по конкретному ключу. */
  isPending(key: string): boolean
  /** Все ключи в полёте. */
  pendingKeys: ReadonlySet<string>
}

/**
 * Единый шаблон сохранения немедленных настроек в правой панели:
 * pending контрола → (throttled) success-тост → при ошибке error-тост и откат.
 *
 * Хук не бросает ошибку наружу: при сбое возвращает `undefined`, а вызывающий
 * код через `onError` возвращает контрол к актуальному серверному состоянию
 * (никаких «залипших» оптимистичных значений). Error-тосты не троттлятся.
 */
export function usePanelSettingSave(opts: PanelSettingSaveOptions = {}): PanelSettingSave {
  const { t } = useI18n()
  const { notify } = useNotification()
  const {
    throttleMs = PANEL_SAVE_THROTTLE_MS,
    successKey: defaultSuccessKey,
    errorKey: defaultErrorKey,
    sessionId,
  } = opts

  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set<string>())
  const lastSuccessAtRef = useRef(0)

  const run = useCallback(
    async <T,>(options: PanelSettingRunOptions<T>): Promise<T | undefined> => {
      const { key, run: task } = options
      setPendingKeys((prev) => {
        if (prev.has(key)) return prev
        const next = new Set(prev)
        next.add(key)
        return next
      })
      try {
        const result = await task()
        options.onSuccess?.(result)
        if (!options.silentSuccess) {
          const now = Date.now()
          if (throttleMs <= 0 || now - lastSuccessAtRef.current >= throttleMs) {
            lastSuccessAtRef.current = now
            notify({
              text: t(options.successKey ?? defaultSuccessKey ?? 'panel.saved'),
              type: 'success',
              category: 'system',
              sessionId,
            })
          }
        }
        return result
      } catch (error) {
        if (!options.silentError) {
          const errorKey = options.errorKey ?? defaultErrorKey
          const resolved = typeof errorKey === 'function' ? errorKey(error) : errorKey
          notify({
            text: t(resolved ?? 'panel.saveError'),
            type: 'error',
            category: 'error',
            sessionId,
          })
        }
        options.onError?.(error)
        return undefined
      } finally {
        setPendingKeys((prev) => {
          if (!prev.has(key)) return prev
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [t, notify, throttleMs, defaultSuccessKey, defaultErrorKey, sessionId],
  )

  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys])

  return { run, isPending, pendingKeys }
}
