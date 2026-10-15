import { create } from 'zustand'
import type {
  CommandDiagnostic,
  CommandSummary,
  SkillBundle,
  SkillDetail,
  SkillDiagnostic,
  SkillSummary,
  SkillsDisabledRequest,
} from '@itphx/synth-shared'
import {
  synthApi,
  type ToolsPolicy,
} from '../lib/api/synthApi'
import { i18nText } from '@/lib/i18n/text'

/** ADR-046 §8.2: данные события `skill.invoked`. */
export interface SkillInvokedEvent {
  sessionId: string
  name: string
  source: 'user' | 'model'
  scope?: string
  agent?: string
  timestamp?: string
}

/** ADR-046 §8.2: данные события `command.invoked`. */
export interface CommandInvokedEvent {
  sessionId: string
  command: string
  args?: string
  actor: 'user' | 'cli'
  timestamp?: string
}

/** Дефолт instance-отключений (пусто) и политики (`auto`) — для Reset/`isDefault`. */
export const EMPTY_SKILLS_DISABLED: SkillsDisabledRequest = { categories: [], groups: [], skills: [] }
/** Дефолт сида новых проектов (пусто — все обнаруженные скиллы включаются). */
export const EMPTY_SKILLS_DISABLED_FOR_NEW_PROJECTS: SkillsDisabledRequest = { categories: [], groups: [], skills: [] }
export const DEFAULT_SKILLS_POLICY: ToolsPolicy = 'auto'

export interface SkillsStore {
  // Реестр скиллов
  skills: SkillSummary[] | null
  skillsDiagnostics: SkillDiagnostic[]
  skillsLoading: boolean
  skillsError: string | null

  // Деталь выбранного скилла
  selectedSkill: SkillDetail | null
  selectedLoading: boolean
  selectedError: string | null

  // Команды
  commands: CommandSummary[] | null
  commandDiagnostics: CommandDiagnostic[]
  commandsLoading: boolean
  commandsError: string | null

  // Bundles
  bundles: SkillBundle[] | null
  bundlesLoading: boolean
  bundlesError: string | null

  // Instance-wide отключения и политика
  settingsDisabled: SkillsDisabledRequest | null
  /** Сид новых проектов: что не включать по умолчанию. */
  settingsDisabledForNewProjects: SkillsDisabledRequest | null
  settingsPolicy: ToolsPolicy
  settingsLoading: boolean
  settingsError: string | null

  // Метрики из событий (ADR-046 §8.2): пригодятся для статистики (часть b)
  skillInvocationCounts: Record<string, number>
  commandInvocationCounts: Record<string, number>
  lastSkillInvocation: SkillInvokedEvent | null
  lastCommandInvocation: CommandInvokedEvent | null

  fetchSkills: (params?: { projectId?: string; diagnostics?: boolean }) => Promise<void>
  selectSkill: (name: string, opts?: { projectId?: string }) => Promise<void>
  clearSelectedSkill: () => void
  createSkill: (input: {
    name: string
    description: string
    body?: string
    files?: Record<string, string>
  }) => Promise<SkillDetail>
  updateSkill: (
    name: string,
    patch: { description?: string; body?: string; metadata?: Record<string, unknown> },
  ) => Promise<SkillDetail>
  deleteSkill: (name: string) => Promise<void>
  putSkillFile: (name: string, path: string, content: string) => Promise<void>
  deleteSkillFile: (name: string, path: string) => Promise<void>
  reloadSkills: () => Promise<void>

  fetchCommands: (params?: { projectId?: string; diagnostics?: boolean }) => Promise<void>

  fetchBundles: () => Promise<void>
  createBundle: (input: SkillBundle) => Promise<SkillBundle>
  updateBundle: (name: string, input: Omit<SkillBundle, 'name'>) => Promise<SkillBundle>
  deleteBundle: (name: string) => Promise<void>

  fetchSkillsSettings: () => Promise<void>
  saveSkillsSettings: (input: {
    disabled: SkillsDisabledRequest
    disabledForNewProjects?: SkillsDisabledRequest
    policy?: ToolsPolicy
  }) => Promise<void>
  resetSkillsSettings: () => Promise<void>

  recordSkillInvoked: (event: SkillInvokedEvent) => void
  recordCommandInvoked: (event: CommandInvokedEvent) => void
}

export const useSkillsStore = create<SkillsStore>((set, get) => ({
  skills: null,
  skillsDiagnostics: [],
  skillsLoading: false,
  skillsError: null,

  selectedSkill: null,
  selectedLoading: false,
  selectedError: null,

  commands: null,
  commandDiagnostics: [],
  commandsLoading: false,
  commandsError: null,

  bundles: null,
  bundlesLoading: false,
  bundlesError: null,

  settingsDisabled: null,
  settingsDisabledForNewProjects: null,
  settingsPolicy: DEFAULT_SKILLS_POLICY,
  settingsLoading: false,
  settingsError: null,

  skillInvocationCounts: {},
  commandInvocationCounts: {},
  lastSkillInvocation: null,
  lastCommandInvocation: null,

  fetchSkills: async (params) => {
    set({ skillsLoading: true, skillsError: null })
    try {
      const r = await synthApi.getSkills(params)
      set({
        skills: r.skills,
        skillsDiagnostics: r.diagnostics ?? [],
        skillsLoading: false,
      })
    } catch (err) {
      set({
        skillsError: err instanceof Error ? err.message : i18nText('skills.error.load'),
        skillsLoading: false,
      })
    }
  },

  selectSkill: async (name, opts) => {
    set({ selectedLoading: true, selectedError: null })
    try {
      const detail = await synthApi.getSkill(name, opts)
      set({ selectedSkill: detail, selectedLoading: false })
    } catch (err) {
      set({
        selectedSkill: null,
        selectedError: err instanceof Error ? err.message : i18nText('skills.error.loadDetail'),
        selectedLoading: false,
      })
    }
  },

  clearSelectedSkill: () => set({ selectedSkill: null, selectedError: null }),

  createSkill: async (input) => {
    set({ skillsLoading: true, skillsError: null })
    try {
      const detail = await synthApi.createSkill(input)
      const current = get().skills || []
      const summary = toSummary(detail)
      set({
        skills: [...current.filter((s) => s.name !== detail.name), summary],
        skillsLoading: false,
      })
      return detail
    } catch (err) {
      set({
        skillsError: err instanceof Error ? err.message : i18nText('skills.error.save'),
        skillsLoading: false,
      })
      throw err
    }
  },

  updateSkill: async (name, patch) => {
    set({ skillsLoading: true, skillsError: null })
    try {
      const detail = await synthApi.updateSkill(name, patch)
      const current = get().skills || []
      set({
        skills: current.map((s) => (s.name === name ? toSummary(detail) : s)),
        selectedSkill: get().selectedSkill?.name === name ? detail : get().selectedSkill,
        skillsLoading: false,
      })
      return detail
    } catch (err) {
      set({
        skillsError: err instanceof Error ? err.message : i18nText('skills.error.save'),
        skillsLoading: false,
      })
      throw err
    }
  },

  deleteSkill: async (name) => {
    set({ skillsLoading: true, skillsError: null })
    try {
      await synthApi.deleteSkill(name)
      set({
        skills: (get().skills || []).filter((s) => s.name !== name),
        selectedSkill: get().selectedSkill?.name === name ? null : get().selectedSkill,
        skillsLoading: false,
      })
    } catch (err) {
      set({
        skillsError: err instanceof Error ? err.message : i18nText('skills.error.delete'),
        skillsLoading: false,
      })
      throw err
    }
  },

  putSkillFile: async (name, path, content) => {
    await synthApi.putSkillFile(name, path, content)
    if (get().selectedSkill?.name === name) {
      await get().selectSkill(name)
    }
  },

  deleteSkillFile: async (name, path) => {
    await synthApi.deleteSkillFile(name, path)
    if (get().selectedSkill?.name === name) {
      await get().selectSkill(name)
    }
  },

  reloadSkills: async () => {
    set({ skillsLoading: true, skillsError: null })
    try {
      await synthApi.reloadSkills()
      await get().fetchSkills()
    } catch (err) {
      set({
        skillsError: err instanceof Error ? err.message : i18nText('skills.error.reload'),
        skillsLoading: false,
      })
      throw err
    }
  },

  fetchCommands: async (params) => {
    set({ commandsLoading: true, commandsError: null })
    try {
      const r = await synthApi.getCommands(params)
      set({
        commands: r.commands,
        commandDiagnostics: r.diagnostics ?? [],
        commandsLoading: false,
      })
    } catch (err) {
      set({
        commandsError: err instanceof Error ? err.message : i18nText('commands.error.load'),
        commandsLoading: false,
      })
    }
  },

  fetchBundles: async () => {
    set({ bundlesLoading: true, bundlesError: null })
    try {
      const r = await synthApi.getSkillBundles()
      set({ bundles: r.bundles, bundlesLoading: false })
    } catch (err) {
      set({
        bundlesError: err instanceof Error ? err.message : i18nText('skillBundles.error.load'),
        bundlesLoading: false,
      })
    }
  },

  createBundle: async (input) => {
    set({ bundlesLoading: true, bundlesError: null })
    try {
      const bundle = await synthApi.createSkillBundle(input)
      const current = get().bundles || []
      set({
        bundles: [...current.filter((b) => b.name !== bundle.name), bundle].sort((a, b) => a.name.localeCompare(b.name)),
        bundlesLoading: false,
      })
      return bundle
    } catch (err) {
      set({
        bundlesError: err instanceof Error ? err.message : i18nText('skillBundles.error.save'),
        bundlesLoading: false,
      })
      throw err
    }
  },

  updateBundle: async (name, input) => {
    set({ bundlesLoading: true, bundlesError: null })
    try {
      const bundle = await synthApi.updateSkillBundle(name, input)
      set({
        bundles: (get().bundles || [])
          .map((b) => (b.name === name ? bundle : b))
          .sort((a, b) => a.name.localeCompare(b.name)),
        bundlesLoading: false,
      })
      return bundle
    } catch (err) {
      set({
        bundlesError: err instanceof Error ? err.message : i18nText('skillBundles.error.save'),
        bundlesLoading: false,
      })
      throw err
    }
  },

  deleteBundle: async (name) => {
    set({ bundlesLoading: true, bundlesError: null })
    try {
      await synthApi.deleteSkillBundle(name)
      set({
        bundles: (get().bundles || []).filter((b) => b.name !== name),
        bundlesLoading: false,
      })
    } catch (err) {
      set({
        bundlesError: err instanceof Error ? err.message : i18nText('skillBundles.error.delete'),
        bundlesLoading: false,
      })
      throw err
    }
  },

  fetchSkillsSettings: async () => {
    set({ settingsLoading: true, settingsError: null })
    try {
      const r = await synthApi.getSkillsSettings()
      set({
        settingsDisabled: r.disabled,
        settingsDisabledForNewProjects: r.disabledForNewProjects
          ?? EMPTY_SKILLS_DISABLED_FOR_NEW_PROJECTS,
        settingsPolicy: r.policy,
        settingsLoading: false,
      })
    } catch (err) {
      set({
        settingsError: err instanceof Error ? err.message : i18nText('skills.error.loadSettings'),
        settingsLoading: false,
      })
    }
  },

  saveSkillsSettings: async (input) => {
    set({ settingsLoading: true, settingsError: null })
    try {
      const r = await synthApi.updateSkillsSettings(input)
      set({
        settingsDisabled: r.disabled,
        settingsDisabledForNewProjects: r.disabledForNewProjects
          ?? input.disabledForNewProjects
          ?? EMPTY_SKILLS_DISABLED_FOR_NEW_PROJECTS,
        settingsPolicy: r.policy,
        settingsLoading: false,
      })
    } catch (err) {
      set({
        settingsError: err instanceof Error ? err.message : i18nText('skills.error.saveSettings'),
        settingsLoading: false,
      })
      throw err
    }
  },

  resetSkillsSettings: async () => {
    set({ settingsLoading: true, settingsError: null })
    try {
      await synthApi.resetSkillsSettings()
      set({
        settingsDisabled: { ...EMPTY_SKILLS_DISABLED },
        settingsDisabledForNewProjects: { ...EMPTY_SKILLS_DISABLED_FOR_NEW_PROJECTS },
        settingsPolicy: DEFAULT_SKILLS_POLICY,
        settingsLoading: false,
      })
    } catch (err) {
      set({
        settingsError: err instanceof Error ? err.message : i18nText('skills.error.saveSettings'),
        settingsLoading: false,
      })
      throw err
    }
  },

  recordSkillInvoked: (event) => {
    if (!event.name) return
    const counts = get().skillInvocationCounts
    set({
      skillInvocationCounts: { ...counts, [event.name]: (counts[event.name] ?? 0) + 1 },
      lastSkillInvocation: event,
    })
  },

  recordCommandInvoked: (event) => {
    if (!event.command) return
    const counts = get().commandInvocationCounts
    set({
      commandInvocationCounts: { ...counts, [event.command]: (counts[event.command] ?? 0) + 1 },
      lastCommandInvocation: event,
    })
  },
}))

/** Деталь скилла → сводка реестра (без тела/файлов). */
function toSummary(detail: SkillDetail): SkillSummary {
  const { meta, body, files, ...summary } = detail
  void meta
  void body
  void files
  return summary
}
