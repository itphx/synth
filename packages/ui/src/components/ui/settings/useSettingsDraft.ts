import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface UseSettingsDraftOptions<T> {
  /** Внешнее (сохранённое) значение настройки. */
  value: T | null
  /** Значение по умолчанию (для `isDefault`/`resetToDefault`). */
  defaultValue?: T | null
  /** Пользовательское сравнение; по умолчанию — глубокое через `JSON.stringify`. */
  equals?: (a: T, b: T) => boolean
  /** Сохранение черновика; может вернуть итоговое значение. */
  onSave?: (draft: T) => Promise<T | void>
}

export interface UseSettingsDraftResult<T> {
  draft: T | null
  saved: T | null
  dirty: boolean
  saving: boolean
  isDefault: boolean
  setDraft: (next: T | ((prev: T) => T)) => void
  update: (patch: Partial<T>) => void
  save: () => Promise<boolean>
  revert: () => void
  resetToDefault: () => void
}

function defaultEquals<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * ADR-072: контракт черновика настроек.
 *
 * `draft` живёт локально, `saved` следует за внешним `value`. Внешнее изменение
 * перетирает `draft` только пока пользователь не внёс правки (`!dirty`).
 */
export function useSettingsDraft<T>(opts: UseSettingsDraftOptions<T>): UseSettingsDraftResult<T> {
  const { value, defaultValue = null, equals, onSave } = opts
  const eq = equals ?? defaultEquals

  const [saved, setSaved] = useState<T | null>(value)
  const [draft, setDraftState] = useState<T | null>(value)
  const [saving, setSaving] = useState(false)

  const dirty = useMemo(
    () => (draft === saved ? false : !eq(draft as T, saved as T)),
    [draft, saved, eq],
  )
  const isDefault = useMemo(
    () => defaultValue != null && eq(draft as T, defaultValue),
    [draft, defaultValue, eq],
  )

  // `dirty` для эффекта синхронизации: ref, чтобы не перезапускать эффект на
  // каждое изменение черновика и не перетирать только что сохранённый draft.
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  useEffect(() => {
    setSaved(value)
    setDraftState((prev) => (dirtyRef.current ? prev : value))
  }, [value])

  const setDraft = useCallback((next: T | ((prev: T) => T)) => {
    setDraftState((prev) => {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev as T) : next
      return resolved
    })
  }, [])

  const update = useCallback((patch: Partial<T>) => {
    setDraftState((prev) =>
      prev == null ? prev : ({ ...(prev as object), ...patch } as T),
    )
  }, [])

  const savingRef = useRef(saving)
  savingRef.current = saving

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty || savingRef.current || draft == null || !onSave) {
      return false
    }
    setSaving(true)
    try {
      const result = await onSave(draft)
      const next = (result ?? draft) as T
      setSaved(next)
      setDraftState(next)
      return true
    } catch {
      return false
    } finally {
      setSaving(false)
    }
  }, [dirty, draft, onSave])

  const revert = useCallback(() => {
    setDraftState(saved)
  }, [saved])

  const resetToDefault = useCallback(() => {
    if (defaultValue != null) {
      setDraftState(defaultValue)
    }
  }, [defaultValue])

  return {
    draft,
    saved,
    dirty,
    saving,
    isDefault,
    setDraft,
    update,
    save,
    revert,
    resetToDefault,
  }
}
