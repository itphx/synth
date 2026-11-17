import type { Schedule, ScheduleInput, ScheduleTarget } from '@itphx/synth-shared/types'

/**
 * Общие чистые помощники формы расписания (PROP-141, этап 7b).
 *
 * Вынесены отдельно от модального редактора: карточке расписания в панели
 * «Автоматизация» тоже нужен перевод сущности → вход API (переключение
 * включения), а дублировать его в двух местах нельзя.
 */

/** ADR-051/ADR-089: настройка триггера — ровно одно из `cron` / `every`. */
export type TriggerKind = 'cron' | 'every'
/** Вид цели расписания. */
export type TargetMode = ScheduleTarget['mode']
/** ADR-101: цель `pipeline` — проект, пайплайн и payload прогона. */
export type PipelineTarget = Extract<ScheduleTarget, { mode: 'pipeline' }>

/** Интервалы `every` (парсер core: целое число + `s|m|h|d`). */
export const EVERY_OPTIONS = ['30s', '15m', '1h', '24h'] as const
/** TTL ephemeral-сессии (парсер `parseTtl`: `s|m|h|d`); пусто — дефолт инстанса. */
export const TTL_OPTIONS = ['', '30s', '15m', '1h', '24h', '7d'] as const

export interface ScheduleEditorState {
  id?: string
  name: string
  enabled: boolean
  trigger: TriggerKind
  cron: string
  every: string
  mode: TargetMode
  sessionId: string
  agentTemplate: string
  project: string
  ttl: string
  prompt: string
  /**
   * ADR-101: цель `pipeline` редактируется формой: проект-владелец, пайплайн
   * и payload прогона (текст JSON). Версия спецификации не редактируется
   * (по умолчанию — последняя опубликованная) и сохраняется при правке.
   */
  pipelineProjectId: string
  pipelineId: string
  pipelinePayload: string
  pipelineVersion?: number
}

/** Пустая форма создания расписания. */
export const EMPTY_SCHEDULE_EDITOR: ScheduleEditorState = {
  name: '',
  enabled: true,
  trigger: 'cron',
  cron: '*/5 * * * *',
  every: '15m',
  mode: 'bound',
  sessionId: '',
  agentTemplate: '',
  project: '',
  ttl: '',
  prompt: '',
  pipelineProjectId: '',
  pipelineId: '',
  pipelinePayload: '',
}

/** Полная сущность → вход обновления (сохраняет payload/ownerId при toggle). */
export function scheduleToInput(schedule: Schedule): ScheduleInput {
  return {
    name: schedule.name,
    enabled: schedule.enabled,
    cron: schedule.cron,
    every: schedule.every,
    target: schedule.target,
    prompt: schedule.prompt,
    payload: schedule.payload,
    ownerId: schedule.ownerId,
  }
}

/**
 * ADR-101: payload цели `pipeline` — JSON-объект (вход прогона).
 * Пустой текст — «payload не задан»; невалидный JSON или не-объект — ошибка
 * (массив/примитив отвергаются: сервер ждёт объект).
 */
export function parsePipelinePayload(
  text: string,
): { ok: true; value?: Record<string, unknown> } | { ok: false } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** ADR-101: цель `pipeline` из полей формы (пустые поля не включаются). */
export function buildPipelineTarget(editor: ScheduleEditorState): PipelineTarget {
  const payload = parsePipelinePayload(editor.pipelinePayload)
  return {
    mode: 'pipeline',
    projectId: editor.pipelineProjectId.trim(),
    pipelineId: editor.pipelineId.trim(),
    ...(editor.pipelineVersion !== undefined ? { version: editor.pipelineVersion } : {}),
    ...(payload.ok && payload.value ? { payload: payload.value } : {}),
  }
}

/** Черновик формы → вход API: пустые строки опускаются. */
export function editorToInput(editor: ScheduleEditorState): ScheduleInput {
  const target: ScheduleTarget =
    editor.mode === 'ephemeral'
      ? {
          mode: 'ephemeral',
          agentTemplate: editor.agentTemplate || undefined,
          // PROP-141: проект у ephemeral-цели обязателен (инстансных
          // автоматизаций нет) — пустое значение отвергает сервер.
          project: editor.project.trim(),
          ttl: editor.ttl || undefined,
        }
      : editor.mode === 'pipeline'
        ? buildPipelineTarget(editor)
        : { mode: editor.mode, sessionId: editor.sessionId }
  return {
    name: editor.name.trim(),
    enabled: editor.enabled,
    cron: editor.trigger === 'cron' ? editor.cron.trim() : undefined,
    every: editor.trigger === 'every' ? editor.every : undefined,
    target,
    prompt: editor.prompt.trim() || undefined,
  }
}

/** Сущность → черновик формы (для правки). */
export function scheduleToEditor(schedule: Schedule): ScheduleEditorState {
  const target = schedule.target
  return {
    id: schedule.id,
    name: schedule.name,
    enabled: schedule.enabled,
    trigger: schedule.every ? 'every' : 'cron',
    cron: schedule.cron ?? '',
    every: schedule.every ?? '15m',
    mode: target.mode,
    sessionId: target.mode === 'bound' || target.mode === 'queue' ? target.sessionId : '',
    agentTemplate: target.mode === 'ephemeral' ? target.agentTemplate ?? '' : '',
    project: target.mode === 'ephemeral' ? target.project ?? '' : '',
    ttl: target.mode === 'ephemeral' ? target.ttl ?? '' : '',
    prompt: schedule.prompt ?? '',
    // ADR-101: цель `pipeline` редактируется формой — поля заполняются
    // из цели; версия спецификации не редактируется и сохраняется.
    pipelineProjectId: target.mode === 'pipeline' ? target.projectId : '',
    pipelineId: target.mode === 'pipeline' ? target.pipelineId : '',
    pipelinePayload:
      target.mode === 'pipeline' && target.payload ? JSON.stringify(target.payload, null, 2) : '',
    pipelineVersion: target.mode === 'pipeline' ? target.version : undefined,
  }
}
