// schedules: домен API v2 (ADR-095) — объект `schedulesApi` и его DTO.

import type { Schedule, ScheduleInput, ScheduleJob } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

export const schedulesApi = {
  // --- Шедулер расписаний (ADR-051 / ADR-089) ---
  /** GET /schedules — список расписаний инстанса. */
  async getSchedules(): Promise<{ schedules: Schedule[] }> {
    return fetchJSON<{ schedules: Schedule[] }>(`${BASE_URL}/schedules`)
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
