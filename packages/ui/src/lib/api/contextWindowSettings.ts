// context-window: серверная политика предупреждений о заполнении контекстного окна.
//
// Настройка уровня инстанса (`GET /api/v2/settings/context-window`): что делать
// при приближении к окну модели — `off` (не предупреждать), `warn` (тост и блок
// над композером) или `enforce` (серверная политика ужесточает ход).
//
// UI-правило: неизвестный ответ/ошибка/404 — деградация к `warn` (клиент не
// должен молча терять предупреждение из-за того, что сервер старше интерфейса).

import { useEffect, useSyncExternalStore } from 'react'
import { BASE_URL, fetchJSON } from './base'

export type ContextWindowPolicy = 'off' | 'warn' | 'enforce'

/** Источник эффективного значения (env > runtime > config > default). */
export type ContextWindowSettingsSource = 'env' | 'runtime' | 'config' | 'default'

export interface ContextWindowSettings {
  /** Эффективная политика. */
  policy: ContextWindowPolicy
  /** Сохранённое runtime-значение (`null`/отсутствует — runtime не задан). */
  saved?: ContextWindowPolicy | null
  /** База без runtime и env (к чему вернёт сброс). */
  defaults?: ContextWindowPolicy
  /** Источник эффективного значения. */
  source?: ContextWindowSettingsSource
  /** Политика зафиксирована env-переменной (`SYNTH_CONTEXT_WINDOW_POLICY`). */
  envLocked?: boolean
  /** Применяется сразу — рестарт не требуется. */
  restartRequired?: boolean
  /** Дополнительные поля политики (пороги и пр.) — не обязательны для UI. */
  [key: string]: unknown
}

/** Дефолт, когда API недоступен/не знает настройки. */
export const DEFAULT_CONTEXT_WINDOW_POLICY: ContextWindowPolicy = 'warn'

function isPolicy(value: unknown): value is ContextWindowPolicy {
  return value === 'off' || value === 'warn' || value === 'enforce'
}

const SOURCES: readonly ContextWindowSettingsSource[] = ['env', 'runtime', 'config', 'default']

function isSource(value: unknown): value is ContextWindowSettingsSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

/** Нормализует тело ответа: допускаем `{policy}` и `{settings:{policy}}`. */
function readPolicy(raw: unknown): ContextWindowPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const body = raw as Record<string, unknown>
  if (isPolicy(body.policy)) return body.policy
  const nested = body.settings
  if (nested && typeof nested === 'object' && isPolicy((nested as Record<string, unknown>).policy)) {
    return (nested as Record<string, unknown>).policy as ContextWindowPolicy
  }
  return undefined
}

/**
 * Разбор ответа `GET/PUT/DELETE /settings/context-window`. Неизвестные/битые
 * поля не ломают чтение: политика деградирует к `warn`, остальные поля
 * остаются неопределёнными (старый сервер их не отдаёт).
 */
function normalizeSettings(raw: unknown): ContextWindowSettings {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    ...body,
    policy: readPolicy(body) ?? DEFAULT_CONTEXT_WINDOW_POLICY,
    saved: isPolicy(body.saved) ? body.saved : null,
    defaults: isPolicy(body.defaults) ? body.defaults : DEFAULT_CONTEXT_WINDOW_POLICY,
    source: isSource(body.source) ? body.source : undefined,
    envLocked: body.envLocked === true,
    restartRequired: body.restartRequired === true,
  }
}

/**
 * `GET /settings/context-window` со строгой ошибкой — для админ-раздела:
 * он показывает причину сбоя, а не молча деградирует.
 */
export async function fetchContextWindowSettings(): Promise<ContextWindowSettings> {
  const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/context-window`)
  return normalizeSettings(raw)
}

/**
 * `GET /settings/context-window`. Любая ошибка (сеть, 404, старый сервер) —
 * `null`: вызывающий берёт дефолт, а не показывает ложную политику.
 */
export async function getContextWindowSettings(): Promise<ContextWindowSettings | null> {
  try {
    return await fetchContextWindowSettings()
  } catch {
    return null
  }
}

/** Обновляет модульный кэш после успешной мутации и будит подписчиков. */
function syncCache(settings: ContextWindowSettings): void {
  cachedPolicy = settings.policy
  emit()
}

/**
 * `PUT /settings/context-window` `{policy}` — runtime-override. Применяется
 * сразу (оркестратор читает резолвер перед каждым LLM-вызовом); при env-фиксации
 * сервер отвечает `409 CONFLICT`. Кэш хука обновляется ответом сервера.
 */
export async function putContextWindowPolicy(
  policy: ContextWindowPolicy,
): Promise<ContextWindowSettings> {
  const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/context-window`, {
    method: 'PUT',
    body: JSON.stringify({ policy }),
  })
  const settings = normalizeSettings(raw)
  syncCache(settings)
  return settings
}

/**
 * `DELETE /settings/context-window` — сброс runtime-значения к env/config/default.
 * Эффективная политика после сброса тоже попадает в кэш хука.
 */
export async function deleteContextWindowPolicy(): Promise<ContextWindowSettings> {
  const raw = await fetchJSON<Record<string, unknown>>(`${BASE_URL}/settings/context-window`, {
    method: 'DELETE',
  })
  const settings = normalizeSettings(raw)
  syncCache(settings)
  return settings
}

// --- Кэш на модуль -----------------------------------------------------------
// Политика читается один раз за жизнь вкладки: это инстанс-настройка, которая
// применяется при старте сервера, а не поток данных. Повторный `GET` на каждый
// компонент (шапка, статистика, композер) был бы лишним трафиком.

let cachedPolicy: ContextWindowPolicy | null = null
let inflight: Promise<ContextWindowPolicy> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Текущее значение (для тестов и не-React потребителей). */
export function getContextWindowPolicy(): ContextWindowPolicy {
  return cachedPolicy ?? DEFAULT_CONTEXT_WINDOW_POLICY
}

/** Загружает политику (идемпотентно; ошибка → дефолт `warn`). */
export async function loadContextWindowPolicy(): Promise<ContextWindowPolicy> {
  if (cachedPolicy !== null) return cachedPolicy
  if (!inflight) {
    inflight = getContextWindowSettings()
      .then((settings) => {
        cachedPolicy = settings?.policy ?? DEFAULT_CONTEXT_WINDOW_POLICY
        emit()
        return cachedPolicy
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

/** Политика предупреждений о контекстном окне (live, дефолт `warn`). */
export function useContextWindowPolicy(): ContextWindowPolicy {
  const policy = useSyncExternalStore(subscribe, getContextWindowPolicy, getContextWindowPolicy)
  useEffect(() => {
    void loadContextWindowPolicy()
  }, [])
  return policy
}

/**
 * Сброс кэша — только для тестов (политика живёт на модуль). Аргумент
 * позволяет задать значение без похода в API.
 */
export function resetContextWindowPolicyCache(policy: ContextWindowPolicy | null = null): void {
  cachedPolicy = policy
  inflight = null
  emit()
}
