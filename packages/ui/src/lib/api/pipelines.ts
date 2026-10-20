// pipelines: домен API v2 (ADR-095) — пайплайны инстанса (ADR-051, PROP-059).
//
// Определения пайплайнов ставит установщик пакета расширения (ADR-086 §5);
// этот контур только читает реестр и отдаёт экземпляры прогонов.
//
// Типы объявлены локально (как в соседних доменах): тянуть core в браузерный
// бандл нельзя (см. `packages/ui/AGENTS.md`).

import { BASE_URL, fetchJSON } from './base'

/** Статус экземпляра пайплайна (прогон автомата). */
export type PipelineInstanceStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'

/** Статус шага внутри экземпляра. */
export type PipelineStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

/** Шаг пайплайна (декларация). */
export interface PipelineStep {
  id: string
  /** Вид шага; по умолчанию — `agent`. */
  kind?: 'agent' | 'loop'
  title?: string
  agent?: string
  skill?: string
  prompt?: string
  /** Событие-продвижение (триггер пайплайна или гейт). */
  waitsFor?: { source?: string; type?: string }
  timeoutSec?: number
}

/** Определение пайплайна в реестре инстанса. */
export interface PipelineDefinition {
  id: string
  name: string
  description?: string
  version?: string
  steps: PipelineStep[]
  onError?: 'fail' | 'retry' | 'rollback'
  maxAttempts?: number
  ttl?: string
  /** Провенанс: каким пакетом расширения установлено. */
  installedBy?: { pack: string; version: string }
  createdAt: string
  updatedAt: string
}

/** Состояние шага внутри экземпляра. */
export interface PipelineStepState {
  id: string
  status: PipelineStepStatus
  sessionId?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

/** Триггер, породивший экземпляр. */
export interface PipelineTrigger {
  source?: string
  type?: string
  dedupKey?: string
}

/** Экземпляр пайплайна — конкретный прогон автомата. */
export interface PipelineInstance {
  id: string
  pipelineId: string
  pipelineVersion?: string
  status: PipelineInstanceStatus
  trigger?: PipelineTrigger
  steps: PipelineStepState[]
  currentStep?: string
  attempts: number
  error?: string
  createdAt: string
  updatedAt: string
}

/** Фильтр выборки экземпляров (все поля — по «И»). */
export interface PipelineInstanceFilter {
  pipelineId?: string
  status?: PipelineInstanceStatus
  limit?: number
}

/** Ответ `GET /api/v2/pipelines` — реестр определений. */
export interface PipelinesListResponse {
  pipelines: PipelineDefinition[]
}

/** Ответ `GET /api/v2/pipelines/instances` — экземпляры (свежие первыми). */
export interface PipelineInstancesListResponse {
  instances: PipelineInstance[]
}

export const pipelinesApi = {
  // --- ADR-051/PROP-059: пайплайны инстанса ---
  /** GET /pipelines — определения пайплайнов (ставит установщик пакета). */
  async getPipelines(): Promise<PipelineDefinition[]> {
    const response = await fetchJSON<PipelinesListResponse>(`${BASE_URL}/pipelines`)
    return response.pipelines ?? []
  },

  /** GET /pipelines/instances — экземпляры прогонов (фильтры `pipelineId`/`status`/`limit`). */
  async getPipelineInstances(filter?: PipelineInstanceFilter): Promise<PipelineInstance[]> {
    const params = new URLSearchParams()
    if (filter?.pipelineId) params.set('pipelineId', filter.pipelineId)
    if (filter?.status) params.set('status', filter.status)
    if (filter?.limit) params.set('limit', String(filter.limit))
    const query = params.toString()
    const response = await fetchJSON<PipelineInstancesListResponse>(
      `${BASE_URL}/pipelines/instances${query ? `?${query}` : ''}`,
    )
    return response.instances ?? []
  },
}
