// schedules: домен API v2 (ADR-095) — объект `schedulesApi` и его DTO.

import type { Schedule, ScheduleInput, ScheduleJob } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

/**
 * Фильтры списка расписаний (`GET /api/v2/schedules`).
 *
 * Скоуп отдаётся **серверу**: при большом числе расписаний клиентская
 * выборка «все и отфильтровать» могла не содержать запись нужного скоупа.
 */
export interface ScheduleListOptions {
  /** Цель `bound`/`queue` — id сессии. */
  sessionId?: string
  /** Проект расписания (PROP-141: проект у расписания обязателен). */
  projectId?: string
}

export const schedulesApi = {
  // --- Шедулер расписаний (ADR-051 / ADR-089) ---
  /** GET /schedules — список расписаний (по скоупу — фильтр на сервере). */
  async getSchedules(options?: ScheduleListOptions): Promise<{ schedules: Schedule[] }> {
    const params = new URLSearchParams()
    if (options?.sessionId) params.set('sessionId', options.sessionId)
    if (options?.projectId) params.set('projectId', options.projectId)
    const query = params.toString()
    return fetchJSON<{ schedules: Schedule[] }>(
      `${BASE_URL}/schedules${query ? `?${query}` : ''}`,
    )
  },

  /** POST /schedules — создание расписания. */
  async createSchedule(input: ScheduleInput): Promise<Schedule> {
    const res = await fetchJSON<{ schedule: Schedule }>(`${BASE_URL}/schedules`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return res.schedule
  },

  /** PUT /schedules/:id — обновление расписания (полная замена полей). */
  async updateSchedule(id: string, input: ScheduleInput): Promise<Schedule> {
    const res = await fetchJSON<{ schedule: Schedule }>(
      `${BASE_URL}/schedules/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    )
    return res.schedule
  },

  /** DELETE /schedules/:id — удаление расписания. */
  async deleteSchedule(id: string): Promise<void> {
    return fetchJSON<void>(`${BASE_URL}/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  /** POST /schedules/:id/run — принудительный запуск (ingest события сейчас). */
  async runSchedule(id: string): Promise<Schedule> {
    const res = await fetchJSON<{ schedule: Schedule }>(
      `${BASE_URL}/schedules/${encodeURIComponent(id)}/run`,
      { method: 'POST' },
    )
    return res.schedule
  },

  /** GET /schedules/:id/jobs — история срабатываний расписания (ADR-051). */
  async getScheduleJobs(scheduleId: string, limit = 20): Promise<{ jobs: ScheduleJob[] }> {
    return fetchJSON<{ jobs: ScheduleJob[] }>(
      `${BASE_URL}/schedules/${encodeURIComponent(scheduleId)}/jobs?limit=${encodeURIComponent(String(limit))}`,
    )
  },
}
