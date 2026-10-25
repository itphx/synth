// pipeline-project: домен API v2 для **пайплайнов проекта** (ADR-101, Э6/Э7).
//
// Это НЕ legacy-контур ADR-100 (`lib/api/pipelines.ts`, §5.34 — реестр
// определений инстанса): здесь пайплайн как **второй движок** — спецификация
// с черновиком и опубликованными версиями, прогоны с журналом и HITL-гейты.
//
// Пути (§5.35 `docs/API_V2.md`):
//   GET/POST   /api/v2/projects/:id/pipelines
//   GET/PUT/DELETE /api/v2/projects/:id/pipelines/:pid
//   POST       /api/v2/projects/:id/pipelines/:pid/publish
//   GET/POST   /api/v2/projects/:id/pipelines/:pid/runs
//   GET        /api/v2/pipeline-runs/:runId
//   POST       /api/v2/pipeline-runs/:runId/resume | /cancel
//   GET        /api/v2/pipeline-templates
//   POST       /api/v2/pipeline-templates/:tid/instantiate
//
// Права (ADR-089 §5.5/§5.8, инвариант 21): читать — право чтения проекта,
// менять — право изменения содержимого (`OWNER`/`EDITOR`/`LEAD`/`ADMIN`);
// шаблоны инстанса — `ADMIN` (в managed). Enforcement — на сервере (guard на
// границе), UI лишь прячет недоступные действия.
//
// Типы спецификации берём из `@itphx/synth-shared/types` (browser-safe subpath:
// value-импорты из корня тян��т `node:fs` — см. `packages/ui/AGENTS.md`).
// DTO ответов API объявлены локально: контракт сервера — запись хранилища
// (`PipelineRecord`/`PipelineVersionRecord`/`PipelineRunRecord`), а не
// shared-`PipelineRun` (в нём нет снимка спецификации и `createdAt`).

import type {
  PipelineExit,
  PipelineMode,
  PipelineNode,
  PipelineRunEventType,
  PipelineRunStatus,
  PipelineRunTrigger,
  PipelineSpec,
} from '@itphx/synth-shared/types'

import { BASE_URL, fetchJSON } from './base'

// ─────────────── DTO ───────────────

/** Провенанс установки (каким пакетом расширения принесён шаблон). */
export interface PipelineProvenance {
  pack: string
  version: string
  /** Шаблон инстанса, из которого создан пайплайн (ADR-101). */
  templateId?: string
}

/**
 * Пайплайн проекта — краткое представление (`GET .../pipelines` и
 * `GET .../pipelines/:pid`): метаданные + черновик спецификации.
 */
export interface ProjectPipeline {
  id: string
  name: string
  description?: string
  icon?: string
  /** Область: `project` (пайплайн проекта) или `instance` (шаблон инстанса). */
  scope: 'project' | 'instance'
  projectId?: string
  /** Номер версии, которая станет следующей опубликованной. */
  draftVersion: number
  /** Номер опубликованной версии (если публикация была). */
  publishedVersion?: number
  /** Есть ли черновик (неопубликованные правки). */
  hasDraft: boolean
  installedBy?: PipelineProvenance
  createdAt: string
  updatedAt: string
  /** Черновик спецификации (может отсутствовать). */
  draft?: PipelineSpec
}

/** Опубликованная версия — неизменяемый снимок спецификации. */
export interface PipelineVersion {
  pipelineId: string
  version: number
  spec: PipelineSpec
  publishedAt: string
  publishedBy?: string
}

/** Деталь пайплайна: черновик + опубликованная версия + список версий. */
export interface ProjectPipelineDetail {
  pipeline: ProjectPipeline
  published: PipelineVersion | null
  versions: PipelineVersion[]
}

/**
 * Прогон пайплайна — запись состояния (самодостаточная: несёт снимок
 * спецификации, поэтому переживает удаление пайплайна).
 */
export interface PipelineRunRecord {
  id: string
  pipelineId: string
  /** Версия спецификации, по которой идёт прогон. */
  version: number
  /** Снимок спецификации на момент запуска. */
  spec?: PipelineSpec
  projectId?: string
  status: PipelineRunStatus
  /** Текущий узел (исполняемый/ожидающий). */
  currentNode?: string
  trigger?: PipelineRunTrigger
  startedAt?: string
  finishedAt?: string
  error?: string
  createdAt?: string
  updatedAt?: string
}

/** Событие журнала прогона (append-only). */
export interface PipelineRunEvent {
  runId: string
  ts: string
  type: PipelineRunEventType
  payload?: Record<string, unknown>
}

/** Прогон + журнал (`GET /api/v2/pipeline-runs/:runId`). */
export interface PipelineRunDetail {
  run: PipelineRunRecord
  events: PipelineRunEvent[]
}

/** Шаблон инстанса — источник для инстанцирования в проект. */
export interface PipelineTemplate {
  id: string
  name: string
  description?: string
  /** `adr-100` — legacy-определение пакета, `adr-101` — запись `scope:'instance'`. */
  format: 'adr-100' | 'adr-101'
  version?: number
  installedBy?: PipelineProvenance
  /** Спецификация (новый формат). */
  spec?: PipelineSpec
  /** Шаги (legacy-определение ADR-100). */
  steps?: Array<Record<string, unknown>>
}

// ─────────────── Тела запросов ───────────────

/**
 * Спецификация **в теле запроса**: серверные поля (`id`/`version`/`status`/
 * `projectId`) проставляет сервер — присылать их не нужно (а пустая строка
 * в них означает «не задано» и сервером игнорируется).
 */
export type PipelineSpecInput = Omit<
  PipelineSpec,
  'id' | 'version' | 'status' | 'projectId'
> &
  Partial<Pick<PipelineSpec, 'id' | 'version' | 'status' | 'projectId'>>

/**
 * Тело создания/правки пайплайна: спецификация целиком. Серверные поля
 * (`id`/`version`/`status`/`projectId`) проставляются на сервере.
 */
export interface PipelineSpecBody {
  name?: string
  description?: string
  spec: PipelineSpecInput
}

/** Тело запуска прогона (по умолчанию — последняя опубликованная версия). */
export interface PipelineRunStartBody {
  trigger?: PipelineRunTrigger
  version?: number
}

/** Тело HITL-действия (возобновление прогона). */
export interface PipelineRunResumeBody {
  approved: boolean
  output?: Record<string, unknown>
  comment?: string
}

/** Тело инстанцирования шаблона в проект. */
export interface PipelineTemplateInstantiateBody {
  projectId: string
  name?: string
  /**
   * Идемпотентность: если пайплайн из этого шаблона в проекте уже есть —
   * вернуть его (`created:false`), иначе создать (`created:true`).
   */
  ensure?: boolean
}

/** Фильтр выборки прогонов (`GET .../runs`). */
export interface PipelineRunsFilter {
  status?: PipelineRunStatus
  limit?: number
}

// ─────────────── Домен ───────────────

/** Кодирование id проекта/пайплайна/прогона в путь. */
const enc = (value: string): string => encodeURIComponent(value)

export const pipelineProjectApi = {
  // ─────────────── Пайплайны проекта ───────────────

  /** GET /projects/:id/pipelines — пайплайны проекта. */
  async getProjectPipelines(projectId: string): Promise<ProjectPipeline[]> {
    const response = await fetchJSON<{ pipelines?: ProjectPipeline[] }>(
      `${BASE_URL}/projects/${enc(projectId)}/pipelines`,
    )
    return response.pipelines ?? []
  },

  /** POST /projects/:id/pipelines — создать пайплайн (черновик). */
  async createProjectPipeline(projectId: string, body: PipelineSpecBody): Promise<ProjectPipeline> {
    const response = await fetchJSON<{ pipeline: ProjectPipeline }>(
      `${BASE_URL}/projects/${enc(projectId)}/pipelines`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    return response.pipeline
  },

  /** GET /projects/:id/pipelines/:pid — деталь (черновик + опубликованная версия). */
  async getProjectPipeline(projectId: string, pipelineId: string): Promise<ProjectPipelineDetail> {
    return fetchJSON<ProjectPipelineDetail>(
      `${BASE_URL}/projects/${enc(projectId)}/pipelines/${enc(pipelineId)}`,
    )
  },

  /** PUT /projects/:id/pipelines/:pid — сохранить черновик (версия не меняется). */
  async updateProjectPipeline(
    projectId: string,
    pipelineId: string,
    body: PipelineSpecBody,
  ): Promise<ProjectPipeline> {
    const response = await fetchJSON<{ pipeline: ProjectPipeline }>(
      `${BASE_URL}/projects/${enc(projectId)}/pipelines/${enc(pipelineId)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    )
    return response.pipeline
  },

  /** DELETE /projects/:id/pipelines/:pid — удалить пайплайн (прогоны остаются). */
  async deleteProjectPipeline(projectId: string, pipelineId: string): Promise<void> {
    await fetchJSON<void>(
      `${BASE_URL}/projects/${enc(projectId)}/pipelines/${enc(pipelineId)}`,
      { method: 'DELETE' },
    )
  },

  /** POST /projects/:id/pipelines/:pid/publish — опубликовать версию черновика. */
  async publishProjectPipeline(
    projectId: string,
    pipelineId: string,
  ): Promise<{ pipeline: ProjectPipeline; published: PipelineVersion | null }> {
    return fetchJSON<{ pipeline: ProjectPipeline; published: PipelineVersion | null }>(
      `${BASE_URL}/projects/${enc(projectId)}/pipelines/${enc(pipelineId)}/publish`,
      { method: 'POST' },
    )
  },

  // ─────────────── Прогоны ───────────────

  /** GET /projects/:id/pipelines/:pid/runs — прогоны пайплайна. */
  async listPipelineRuns(
    projectId: string,
    pipelineId: string,
    filter?: PipelineRunsFilter,
  ): Promise<PipelineRunRecord[]> {
    const params = new URLSearchParams()
    if (filter?.status) params.set('status', filter.status)
    if (filter?.limit) params.set('limit', String(filter.limit))
    const query = params.toString()
    const response = await fetchJSON<{ runs?: PipelineRunRecord[] }>(
      `${BASE_URL}/projects/${enc(projectId)}/pipelines/${enc(pipelineId)}/runs${query ? `?${query}` : ''}`,
    )
    return response.runs ?? []
  },

  /** POST /projects/:id/pipelines/:pid/runs — запустить прогон (идёт в фоне). */
  async startPipelineRun(
    projectId: string,
    pipelineId: string,
    body?: PipelineRunStartBody,
  ): Promise<PipelineRunRecord> {
    const response = await fetchJSON<{ run: PipelineRunRecord }>(
      `${BASE_URL}/projects/${enc(projectId)}/pipelines/${enc(pipelineId)}/runs`,
      { method: 'POST', body: JSON.stringify(body ?? {}) },
    )
    return response.run
  },

  /** GET /pipeline-runs/:runId — прогон и журнал событий. */
  async getPipelineRun(runId: string, opts?: { limit?: number }): Promise<PipelineRunDetail> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    const query = params.toString()
    return fetchJSON<PipelineRunDetail>(
      `${BASE_URL}/pipeline-runs/${enc(runId)}${query ? `?${query}` : ''}`,
    )
  },

  /** POST /pipeline-runs/:runId/resume — HITL-решение человека. */
  async resumePipelineRun(runId: string, body: PipelineRunResumeBody): Promise<PipelineRunRecord> {
    const response = await fetchJSON<{ run: PipelineRunRecord }>(
      `${BASE_URL}/pipeline-runs/${enc(runId)}/resume`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    return response.run
  },

  /** POST /pipeline-runs/:runId/cancel — отмена прогона. */
  async cancelPipelineRun(runId: string): Promise<PipelineRunRecord> {
    const response = await fetchJSON<{ run: PipelineRunRecord }>(
      `${BASE_URL}/pipeline-runs/${enc(runId)}/cancel`,
      { method: 'POST' },
    )
    return response.run
  },

  // ─────────────── Шаблоны инстанса ───────────────

  /** GET /pipeline-templates — шаблоны инстанса (ADMIN в managed). */
  async getPipelineTemplates(): Promise<PipelineTemplate[]> {
    const response = await fetchJSON<{ templates?: PipelineTemplate[] }>(
      `${BASE_URL}/pipeline-templates`,
    )
    return response.templates ?? []
  },

  /** POST /pipeline-templates/:tid/instantiate — создать пайплайн проекта из шаблона. */
  async instantiatePipelineTemplate(
    templateId: string,
    body: PipelineTemplateInstantiateBody,
  ): Promise<ProjectPipeline> {
    const response = await fetchJSON<{ pipeline: ProjectPipeline }>(
      `${BASE_URL}/pipeline-templates/${enc(templateId)}/instantiate`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    return response.pipeline
  },
}

/** Типы спецификации переиспользуются компонентами страницы пайплайна. */
export type { PipelineExit, PipelineMode, PipelineNode, PipelineRunStatus, PipelineSpec }
