// scripts: домен API v2 (ADR-095) — реестр скриптов проекта и `!`-запуск.
//
// ADR-126 §5: `!name [args]` — **первый непробельный токен** обычного сообщения;
// резолвится по реестру скриптов и запускает объявленный скрипт фоновым
// процессом (ADR-113). Реестр: `.synth/scripts/<name>.md` (project) >
// `{dataDir}/scripts` (instance) > `config.scripts.paths`; приоритет, trust-гейт
// и диагностика — как у команд и скиллов.
//
// HTTP — в контуре сессии (`GET /:id/scripts`, `POST /:id/scripts/:name/run`),
// доступ решает граничный guard (инвариант 16). Резолвинг `!`-токена — в core,
// не в UI (иначе разойдутся CLI, гибрид и шлюзы).

import type {
  ScriptDiagnostic,
  ScriptRunResponse,
  ScriptSummary,
} from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

export type { ScriptDiagnostic, ScriptRunResponse, ScriptSummary }

/** ADR-126 §5: ответ `GET /api/v2/sessions/:id/scripts`. */
export interface SessionScriptsResponse {
  scripts: ScriptSummary[]
  diagnostics?: ScriptDiagnostic[]
}

/** ADR-126 §5: параметры выборки реестра скриптов сессии. */
export interface ListSessionScriptsOptions {
  /** `diagnostics=1` — отдать диагностику реестра (недоверенный каталог, коллизии). */
  diagnostics?: boolean
}

export const scriptsApi = {
  /**
   * ADR-126 §5: `GET /sessions/:id/scripts` — реестр скриптов сессии
   * (project + instance + config). Скрипт с `available: false` виден, но не
   * запускается (недоверенный каталог или правило прав).
   */
  async listSessionScripts(
    sessionId: string,
    opts?: ListSessionScriptsOptions,
  ): Promise<SessionScriptsResponse> {
    const q = opts?.diagnostics ? '?diagnostics=1' : ''
    return fetchJSON<SessionScriptsResponse>(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/scripts${q}`,
    )
  },

  /**
   * ADR-126 §5: `POST /sessions/:id/scripts/:name/run` — запуск скрипта
   * фоновым процессом. Ответ `202` — запуск неблокирующий.
   *
   * Аргументы не переиспользуются при повторном запуске («Запустить снова»
   * в «Процессах» идёт без аргументов).
   *
   * `arguments` — **строка** аргументов, не массив: их разбирает сервер
   * (`splitScriptArguments`, без shell). Пустая строка не отправляется вовсе,
   * чтобы поле `arguments` оставалось необязательным.
   */
  async runSessionScript(
    sessionId: string,
    name: string,
    args?: string,
  ): Promise<ScriptRunResponse> {
    return fetchJSON<ScriptRunResponse>(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/scripts/${encodeURIComponent(name)}/run`,
      {
        method: 'POST',
        body: JSON.stringify(args && args.trim().length > 0 ? { arguments: args } : {}),
      },
    )
  },
}
