// skill-bundles: домен API v2 (ADR-095) — объект `skillBundlesApi` и его DTO.

import type { SkillBundle } from '@itphx/synth-shared'
import { BASE_URL, fetchJSON } from './base'

/** ADR-046 §7.3: ответ GET /api/v2/skill-bundles. */
export interface SkillBundlesResponse {
  bundles: SkillBundle[]
}

export const skillBundlesApi = {
  // --- Bundles (ADR-046 §7.3) ---
  /** GET /skill-bundles — список YAML-групп скиллов. */
  async getSkillBundles(): Promise<SkillBundlesResponse> {
    return fetchJSON<SkillBundlesResponse>(`${BASE_URL}/skill-bundles`)
  },

  /** GET /skill-bundles/:name — один bundle. */
  async getSkillBundle(name: string): Promise<SkillBundle> {
    return fetchJSON<SkillBundle>(`${BASE_URL}/skill-bundles/${encodeURIComponent(name)}`)
  },

  /** POST /skill-bundles — создание bundle. */
  async createSkillBundle(input: SkillBundle): Promise<SkillBundle> {
    return fetchJSON<SkillBundle>(`${BASE_URL}/skill-bundles`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  /** PATCH /skill-bundles/:name — правка bundle. */
  async updateSkillBundle(name: string, input: Omit<SkillBundle, 'name'>): Promise<SkillBundle> {
    return fetchJSON<SkillBundle>(`${BASE_URL}/skill-bundles/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...input, name }),
    })
  },

  /** DELETE /skill-bundles/:name — удаление bundle. */
  async deleteSkillBundle(name: string): Promise<void> {
    await fetchJSON<{ status: string }>(`${BASE_URL}/skill-bundles/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
  },
}
