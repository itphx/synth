// Черновики текста композера: ручной персист в localStorage (без zustand-persist).
//
// Текст переживает reload страницы, выгрузку PWA и перемонтирование `ChatInput`.
// Запись дебаунсится (~300 мс), `flush` пишет немедленно; на `pagehide`,
// `visibilitychange` (hidden) и `beforeunload` — принудительный flush.
// Все обращения к localStorage — ленивые и под guard'ом окружения: модуль
// безопасно импортировать в jsdom/Node (на импорте ничего не читается).

/** Ключ localStorage со всеми черновиками композера. */
export const COMPOSER_DRAFTS_KEY = 'synth.composer.drafts.v1'

/** Максимум непустых черновиков; самые старые по `updatedAt` удаляются. */
export const MAX_COMPOSER_DRAFTS = 50

/** Задержка отложенной записи: печать не должна дёргать localStorage на каждый символ. */
export const COMPOSER_DRAFT_WRITE_DELAY_MS = 300

export interface ComposerDraftEntry {
  text: string
  updatedAt: number
}

export type ComposerDraftsMap = Record<string, ComposerDraftEntry>

/** In-memory зеркало: `null` — ещё не читали хранилище (ленивая инициализация). */
let drafts: ComposerDraftsMap | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let listenersAttached = false

/** localStorage может отсутствовать или бросать (приватный режим, квоты). */
function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

function parseStored(raw: string | null): ComposerDraftsMap {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; drafts?: unknown }
    if (!parsed || parsed.version !== 1) return {}
    if (!parsed.drafts || typeof parsed.drafts !== 'object') return {}
    const result: ComposerDraftsMap = {}
    for (const [sessionId, value] of Object.entries(parsed.drafts as Record<string, unknown>)) {
      if (!sessionId || !value || typeof value !== 'object') continue
      const entry = value as { text?: unknown; updatedAt?: unknown }
      if (typeof entry.text !== 'string' || entry.text.trim() === '') continue
      result[sessionId] = {
        text: entry.text,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
      }
    }
    return result
  } catch {
    // Битый JSON — начинаем с чистого листа, не ломая композер.
    return {}
  }
}

function ensureLoaded(): ComposerDraftsMap {
  if (drafts) return drafts
  drafts = parseStored(getStorage()?.getItem(COMPOSER_DRAFTS_KEY) ?? null)
  return drafts
}

function cancelScheduledFlush(): void {
  if (flushTimer === null) return
  clearTimeout(flushTimer)
  flushTimer = null
}

function scheduleFlush(): void {
  cancelScheduledFlush()
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushComposerDrafts()
  }, COMPOSER_DRAFT_WRITE_DELAY_MS)
}

/** Оставить не более `MAX_COMPOSER_DRAFTS` самых свежих записей. */
function pruneDrafts(map: ComposerDraftsMap): ComposerDraftsMap {
  const entries = Object.entries(map)
  if (entries.length <= MAX_COMPOSER_DRAFTS) return map
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  return Object.fromEntries(entries.slice(0, MAX_COMPOSER_DRAFTS))
}

function handleVisibilityChange(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    flushComposerDrafts()
  }
}

/**
 * Навесить слушатели один раз. Вызывается с первого обращения (чтение/запись),
 * а не на этапе импорта модуля — тесты с `vi.resetModules()` не плодят утечки.
 */
function ensureFlushListeners(): void {
  if (listenersAttached || typeof window === 'undefined') return
  listenersAttached = true
  window.addEventListener('pagehide', flushComposerDrafts)
  window.addEventListener('beforeunload', flushComposerDrafts)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
}

/**
 * Черновики всех сессий. Первое чтение подтягивает localStorage; дальше отдаёт
 * in-memory зеркало (включая ещё не записанные изменения).
 */
export function readComposerDrafts(): ComposerDraftsMap {
  ensureFlushListeners()
  return { ...ensureLoaded() }
}

/**
 * Обновить черновик сессии. Пустой/пробельный текст удаляет запись.
 * Запись в localStorage отложена до `flush` или ~300 мс простоя.
 */
export function writeComposerDraft(sessionId: string, text: string): void {
  ensureFlushListeners()
  if (!sessionId) return
  const map = ensureLoaded()
  if (text.trim() === '') {
    if (!(sessionId in map)) return
    delete map[sessionId]
  } else {
    map[sessionId] = { text, updatedAt: Date.now() }
  }
  scheduleFlush()
}

/** Записать накопленные черновики немедленно (с прунингом). */
export function flushComposerDrafts(): void {
  cancelScheduledFlush()
  const storage = getStorage()
  if (!storage) return
  const pruned = pruneDrafts(ensureLoaded())
  drafts = pruned
  try {
    if (Object.keys(pruned).length === 0) {
      storage.removeItem(COMPOSER_DRAFTS_KEY)
    } else {
      storage.setItem(
        COMPOSER_DRAFTS_KEY,
        JSON.stringify({ version: 1, drafts: pruned }),
      )
    }
  } catch {
    // Квота/приватный режим: черновик остаётся только в памяти — UI не падает.
  }
}

/** Полная очистка (тесты, выход пользователя). */
export function clearAllComposerDrafts(): void {
  cancelScheduledFlush()
  drafts = {}
  const storage = getStorage()
  if (!storage) return
  try {
    storage.removeItem(COMPOSER_DRAFTS_KEY)
  } catch {
    // Удаление — best-effort.
  }
}
