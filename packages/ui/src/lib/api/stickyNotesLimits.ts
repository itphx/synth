// sticky-notes limits: instance-wide ограничения заметок (`context.stickyNotes`).
//
// Настройка уровня инстанса (`GET/PUT/DELETE /api/v2/settings/sticky-notes`):
// сколько заметок может быть в сессии (`maxCount`) и какая максимальная длина
// одной заметки (`maxChars`). Сервер проверяет лимиты при создании/правке
// заметки (`409 LIMIT_EXCEEDED` / `400 VALIDATION_ERROR`), клиент — заранее,
// чтобы не отправлять заведомо отклоняемый запрос.
//
// UI-правило: неизвестный ответ/ошибка/404 (старый сервер, гибрид) — работаем
// с дефолтами `50/2000` и не падаем: превышение всё равно отклонит сервер.

import { useEffect, useSyncExternalStore } from 'react'
import { BASE_URL, fetchJSON } from './base'

/** Лимиты заметок уровня инстанса. */
export interface StickyNotesLimits {
  /** Максимум заметок в одной сессии. */
  maxCount: number
  /** Максимум символов в одной заметке. */
  maxChars: number
}

/** Источник эффективного значения (runtime > config > default). */
export type StickyNotesLimitsSource = 'runtime' | 'config' | 'default'

/** Ответ `GET/PUT/DELETE /api/v2/settings/sticky-notes`. */
export interface StickyNotesLimitsSettings {
  /** Эффективные лимиты. */
  limits: StickyNotesLimits
  /** Сохранённый runtime-патч (`null`/отсутствует — runtime не задан). */
  saved?: Partial<StickyNotesLimits> | null
  /** База без runtime (к чему вернёт сброс). */
  defaults?: StickyNotesLimits
  /** Источник эффективного значения. */
  source?: StickyNotesLimitsSource
  /** Применяется сразу — рестарт не требуется. */
  restartRequired?: boolean
}

/** Дефолт, когда API недоступен/не знает настройки. */
export const DEFAULT_STICKY_NOTES_LIMITS: StickyNotesLimits = { maxCount: 50, maxChars: 2000 }

/** Допустимые границы полей (валидация до PUT и подсказки в UI). */
export const STICKY_NOTES_LIMITS_BOUNDS: Record<keyof StickyNotesLimits, { min: number; max: number }> = {
  maxCount: { min: 1, max: 1000 },
  maxChars: { min: 1, max: 100000 },
}

/** Машиночитаемые коды отказа сервера при создании/правке заметки. */
export const STICKY_NOTES_LIMIT_EXCEEDED_CODE = 'LIMIT_EXCEEDED'
export const STICKY_NOTES_VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function isSource(value: unknown): value is StickyNotesLimitsSource {
  return value === 'runtime' || value === 'config' || value === 'default'
}

/** Нормализует частичный объект лимитов: известные поля поверх дефолта. */
function normalizeLimits(raw: unknown): StickyNotesLimits {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    maxCount: isPositiveInteger(body.maxCount)
      ? body.maxCount
      : DEFAULT_STICKY_NOTES_LIMITS.maxCount,
    maxChars: isPositiveInteger(body.maxChars)
      ? body.maxChars
      : DEFAULT_STICKY_NOTES_LIMITS.maxChars,
  }
}

function normalizeSaved(raw: unknown): Partial<StickyNotesLimits> | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const saved: Partial<StickyNotesLimits> = {}
  if (isPositiveInteger(body.maxCount)) saved.maxCount = body.maxCount
  if (isPositiveInteger(body.maxChars)) saved.maxChars = body.maxChars
  return Object.keys(saved).length > 0 ? saved : null
}

/**
 * Разбор ответа `GET/PUT/DELETE /settings/sticky-notes`. Терпим к старому
 * серверу: отсутствующие поля не ломают чтение, лимиты деградируют к дефолтам.
 * Плоская форма `{maxCount,maxChars}` (на случай сервера без обёртки) тоже
 * понимается.
 */
function normalizeSettings(raw: unknown): StickyNotesLimitsSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const limitsSource = body.limits ?? body
  return {
    limits: normalizeLimits(limitsSource),
    saved: normalizeSaved(body.saved),
    defaults: normalizeLimits(body.defaults ?? DEFAULT_STICKY_NOTES_LIMITS),
    source: isSource(body.source) ? body.source : undefined,
    restartRequired: body.restartRequired === true,
  }
}

/**
 * `GET /settings/sticky-notes` со строгой ошибкой — для админ-раздела:
 * он показывает причину сбоя и кнопку «Повторить», а не молча деградирует.
 */
export async function fetchStickyNotesLimits(): Promise<StickyNotesLimitsSettings> {
  const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/sticky-notes`)
  return normalizeSettings(raw)
}

/**
 * `GET /settings/sticky-notes` с деградацией: любая ошибка (сеть, 404, старый
 * сервер) — `null`, вызывающий берёт дефолты.
 */
export async function getStickyNotesLimitsSettings(): Promise<StickyNotesLimitsSettings | null> {
  try {
    return await fetchStickyNotesLimits()
  } catch {
    return null
  }
}

/**
 * `PUT /settings/sticky-notes` `{limits}` — runtime-override. Применяется сразу
 * (сервер читает лимиты на каждой операции с заметкой). Кэш хука обновляется
 * ответом сервера.
 */
export async function putStickyNotesLimits(
  patch: Partial<StickyNotesLimits>,
): Promise<StickyNotesLimitsSettings> {
  const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/sticky-notes`, {
    method: 'PUT',
    body: JSON.stringify({ limits: patch }),
  })
  const settings = normalizeSettings(raw)
  syncCache(settings)
  return settings
}

/**
 * `DELETE /settings/sticky-notes` — сброс runtime-значения к config/default.
 * Эффективные лимиты после сброса тоже попадают в кэш хука.
 */
export async function deleteStickyNotesLimits(): Promise<StickyNotesLimitsSettings> {
  const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/sticky-notes`, {
    method: 'DELETE',
  })
  const settings = normalizeSettings(raw)
  syncCache(settings)
  return settings
}

// --- Кэш на модуль -----------------------------------------------------------
// Лимиты — инстанс-настройка, а не поток данных: читаем один раз за жизнь
// вкладки. Композер, панель заметок и чат-таб подписаны на один снимок.

export interface StickyNotesLimitsState {
  /** Эффективные лимиты (при незагруженной настройке — дефолт). */
  limits: StickyNotesLimits
  /** Настройка действительно пришла с сервера (иначе — дефолт-деградация). */
  loaded: boolean
  /** Источник значения, если сервер его отдал. */
  source?: StickyNotesLimitsSource
}

const INITIAL_STATE: StickyNotesLimitsState = {
  limits: DEFAULT_STICKY_NOTES_LIMITS,
  loaded: false,
}

let snapshot: StickyNotesLimitsState = INITIAL_STATE
let inflight: Promise<StickyNotesLimits> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setSnapshot(next: StickyNotesLimitsState): void {
  snapshot = next
  emit()
}

/** Обновляет кэш после успешной мутации и будит подписчиков. */
function syncCache(settings: StickyNotesLimitsSettings): void {
  setSnapshot({ limits: settings.limits, loaded: true, source: settings.source })
}

/** Снимок кэша (стабильная ссылка до изменения — для `useSyncExternalStore`). */
export function getStickyNotesLimitsState(): StickyNotesLimitsState {
  return snapshot
}

/** Текущие лимиты (дефолт `50/2000`, пока настройка не загружена). */
export function getStickyNotesLimits(): StickyNotesLimits {
  return snapshot.limits
}

/** Загружает лимиты (идемпотентно; ошибка → дефолты). */
export async function loadStickyNotesLimits(): Promise<StickyNotesLimits> {
  if (snapshot.loaded) return snapshot.limits
  if (!inflight) {
    inflight = getStickyNotesLimitsSettings()
      .then((settings) => {
        if (settings) {
          syncCache(settings)
        } else {
          // Недоступная настройка: работаем с дефолтами, `loaded` не поднимаем —
          // панель не показывает долю, будто лимит известен.
          setSnapshot({ limits: DEFAULT_STICKY_NOTES_LIMITS, loaded: false })
        }
        return snapshot.limits
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Снимок лимитов заметок (live, с признаком загрузки). */
export function useStickyNotesLimitsState(): StickyNotesLimitsState {
  const state = useSyncExternalStore(subscribe, getStickyNotesLimitsState, getStickyNotesLimitsState)
  useEffect(() => {
    void loadStickyNotesLimits()
  }, [])
  return state
}

/** Эффективные лимиты заметок (live, дефолт `50/2000`). */
export function useStickyNotesLimits(): StickyNotesLimits {
  return useStickyNotesLimitsState().limits
}

/**
 * Ключ i18n для ошибки создания/правки заметки (по `error.code`, с фоллбеком
 * на HTTP-статус). `null` — ошибка не про лимиты, показываем общий текст.
 */
export function stickyNoteErrorKey(
  err: unknown,
): 'chat.notes.limitReached' | 'chat.notes.invalid' | null {
  const code = (err as { code?: unknown })?.code
  if (code === STICKY_NOTES_LIMIT_EXCEEDED_CODE) return 'chat.notes.limitReached'
  if (code === STICKY_NOTES_VALIDATION_ERROR_CODE) return 'chat.notes.invalid'
  const status = (err as { status?: unknown })?.status
  if (status === 409) return 'chat.notes.limitReached'
  if (status === 400) return 'chat.notes.invalid'
  return null
}

/**
 * Сброс кэша — только для тестов (лимиты живут на модуль). Аргумент позволяет
 * задать значение без похода в API.
 */
export function resetStickyNotesLimitsCache(limits: StickyNotesLimits | null = null): void {
  snapshot = limits ? { limits, loaded: true } : INITIAL_STATE
  inflight = null
  emit()
}
