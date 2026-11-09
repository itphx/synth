// Возможности инстанса (`GET /api/v2/meta`) — **единственная** точка обращения
// клиента к `/meta` (ADR-118 §8, ADR-115, PROP-125).
//
// Мета отвечает на три вопроса сразу:
// - сверка модели сообщений перед подключением транспорта (`messageModel`);
// - эффективные лимиты вложений (`attachments.*`, ADR-115);
// - признаки инстанса `features` (`remoteMcp`, `users`) — по ним UI решает,
//   показывать ли раздел настроек, завязанный на опциональный эндпоинт.
//
// Ответ кэшируется на 60 с (данные меняются редко) и дедуплицируется:
// одновременные вызовы ждут один и тот же запрос.

import { create } from 'zustand'
import type { InstanceCapabilities } from '@itphx/synth-shared/types'
import { synthApi } from '@/lib/api/synthApi'

/** TTL кэша ответа `/meta` — лимиты и признаки меняются редко. */
const CACHE_TTL_MS = 60_000

export interface InstanceCapabilitiesState {
  /** Последний ответ `/meta`; `null` — мета недоступна (или ещё не грузили). */
  capabilities: InstanceCapabilities | null
  /**
   * Загрузить возможности инстанса.
   *
   * - кэш 60 с (`force: true` — обойти кэш и взять свежий ответ);
   * - одновременные вызовы дедуплицируются (один inflight-промис);
   * - ошибка сети/старый сервер → `null` (фичи не объявлены → fail-closed).
   */
  load: (opts?: { force?: boolean }) => Promise<InstanceCapabilities | null>
  /** Сброс кэша и состояния (между тестами). */
  resetForTests: () => void
}

// Кэш и inflight живут на уровне модуля: состояние стора — снимок ответа,
// а время жизни кэша не должно подписывать всех на перерисовку.
let cached: { caps: InstanceCapabilities | null; at: number } | null = null
let inflight: Promise<InstanceCapabilities | null> | null = null

export const useInstanceCapabilitiesStore = create<InstanceCapabilitiesState>((set) => ({
  capabilities: null,

  load: async (opts) => {
    // Уже идущий запрос — присоединяемся к нему (дедуп).
    if (inflight) return inflight
    if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.caps
    }

    inflight = (async () => {
      try {
        const caps = await synthApi.getInstanceCapabilities()
        cached = { caps, at: Date.now() }
        set({ capabilities: caps })
        return caps
      } catch {
        // Мета недоступна (сеть/старый сервер) — возможностей нет: кэшируем
        // «пусто» на TTL, чтобы не дёргать `/meta` на каждый чих, и чистим
        // состояние (fail-closed: фичи не объявлены).
        cached = { caps: null, at: Date.now() }
        set({ capabilities: null })
        return null
      } finally {
        inflight = null
      }
    })()

    return inflight
  },

  resetForTests: () => {
    cached = null
    inflight = null
    set({ capabilities: null })
  },
}))

/**
 * Признаки инстанса (`features`).
 *
 * `undefined` — сервер их не объявил (старый сервер или мета недоступна):
 * раздел, требующий фичи, скрыт (fail-closed).
 */
export const selectFeatures = (
  s: InstanceCapabilitiesState,
): InstanceCapabilities['features'] => s.capabilities?.features

/**
 * Есть ли фича инстанса — **строго** `=== true`.
 *
 * `undefined`/`false` → «фичи нет» (сервер не объявил — скрываем раздел).
 */
export const selectHasFeature =
  (name: string) =>
  (s: InstanceCapabilitiesState): boolean => {
    // Набор признаков расширяемый (сервер может объявлять новые), поэтому
    // индекс по строке — через общий тип словаря.
    const features = s.capabilities?.features as Record<string, boolean | undefined> | undefined
    return features?.[name] === true
  }
