import { create } from 'zustand'
import type {
  CommandDiagnostic,
  CommandSummary,
  SkillBundle,
  SkillDetail,
  SkillDiagnostic,
  SkillSummary,
  SkillsDisabledRequest,
  SkillsUpdatedEventData,
} from '@itphx/synth-shared'
import {
  synthApi,
  type SkillsSettingsResponse,
  type SkillsTrustedProjectDirsSource,
  type ToolsPolicy,
} from '../lib/api/synthApi'
import { i18nText } from '@/lib/i18n/text'

/** ADR-126 §12: данные события `skill.invoked`. */
export interface SkillInvokedEvent {
  sessionId: string
  name: string
  source: 'user' | 'model'
  scope?: string
  agent?: string
  timestamp?: string
}

/** ADR-126 §12: данные события `command.invoked`. */
export interface CommandInvokedEvent {
  sessionId: string
  command: string
  args?: string
  actor: 'user' | 'cli'
  timestamp?: string
}

/**
 * Область события шины `skills.updated` (`SkillsUpdatedEventData`) — то, что
 * нужно стору, чтобы разложить изменение по адресатам.
 *
 * Имя скилла/бандла и вид мутации стору не нужны: событие — сигнал «состав
 * изменился, перечитай», а не источник данных (содержимого скиллов в событии
 * нет по построению — инвариант 13 `AGENTS.md`).
 */
/**
 * Область события `skills.updated`, которую получает стор.
 *
 * Все поля опциональны: `transportStore` передаёт payload целиком
 * (`{action, name?, scope?, projectId?, sessionId?}`), а компоненты/тесты могут
 * дать только область. Обязательным остаётся сам сигнал — вызов `applyEvent()`.
 */
export type SkillsEventScope = Partial<SkillsUpdatedEventData>

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
  /** Project-trust (ADR-126/069): эффективный список доверенных каталогов. */
  settingsTrustedProjectDirs: string[]
  /** Значения из `config.yaml` (`skills.trustedProjectDirs`). */
  settingsTrustedProjectDirsDefaults: string[]
  settingsTrustedProjectDirsSource: SkillsTrustedProjectDirsSource
  /** `true` — изменения доверия применяются после перезапуска инстанса. */
  settingsTrustRestartRequired: boolean
  settingsLoading: boolean
  settingsError: string | null

  // Метрики из событий (ADR-126 §12): пригодятся для статистики (часть b)
  skillInvocationCounts: Record<string, number>
  commandInvocationCounts: Record<string, number>
  lastSkillInvocation: SkillInvokedEvent | null
  lastCommandInvocation: CommandInvokedEvent | null

  /**
   * Счётчик изменений реестра скиллов (событие шины `skills.updated`).
   *
   * Растёт на **каждое** серверное событие: панели, которые держат собственные
   * срезы (админская и пользовательская панели скиллов, «Команды», долларовый
   * пикер композера), перечитывают своё по нему. Сам реестр перечитывает
   * `applyEvent`.
   */
  revision: number
  /**
   * Счётчики изменений по проектам (`skills.updated` со `scope: 'project'`).
   *
   * Ключ — `projectId`. Нужны, чтобы панель проекта перечитывала свой скоуп
   * только на события **своего** проекта, а чужие изменения её не трогали.
   */
  projectRevisions: Record<string, number>
  /** Счётчики изменений по сессиям (`skills.updated` со `scope: 'session'`). */
  sessionRevisions: Record<string, number>

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
  /** Project-trust: сохранить список (`null` — сброс к конфигу). */
  saveSkillsTrustedProjectDirs: (dirs: string[] | null) => Promise<void>
  resetSkillsSettings: () => Promise<void>

  recordSkillInvoked: (event: SkillInvokedEvent) => void
  recordCommandInvoked: (event: CommandInvokedEvent) => void

  /**
   * Реестр скиллов изменился на сервере (событие шины `skills.updated`):
   * поднять `revision` и scoped-счётчики, перечитать загруженное.
   */
  applyEvent: (info?: SkillsEventScope) => void
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
  settingsTrustedProjectDirs: [],
  settingsTrustedProjectDirsDefaults: [],
  settingsTrustedProjectDirsSource: 'default',
  settingsTrustRestartRequired: false,
  settingsLoading: false,
  settingsError: null,

  skillInvocationCounts: {},
  commandInvocationCounts: {},
  lastSkillInvocation: null,
  lastCommandInvocation: null,

  revision: 0,
  projectRevisions: {},
  sessionRevisions: {},

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
        ...trustedProjectDirsPatch(r),
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
        // Ответ мог прийти от старого сервера без полей доверия — не затираем текущие.
        ...trustedProjectDirsPatch(r, get().settingsTrustedProjectDirs),
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

  saveSkillsTrustedProjectDirs: async (dirs) => {
    set({ settingsLoading: true, settingsError: null })
    try {
      const r = await synthApi.updateSkillsSettings({ trustedProjectDirs: dirs })
      // При сбросе (`null`) сервер возвращает эффективный список из конфига;
      // если старый сервер поля не отдал — подставляем конфиг-дефолт.
      const fallback = dirs ?? r.trustedProjectDirsDefaults ?? get().settingsTrustedProjectDirsDefaults
      set({
        ...trustedProjectDirsPatch(r, fallback),
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
      const trustedDefaults = get().settingsTrustedProjectDirsDefaults
      set({
        settingsDisabled: { ...EMPTY_SKILLS_DISABLED },
        settingsDisabledForNewProjects: { ...EMPTY_SKILLS_DISABLED_FOR_NEW_PROJECTS },
        settingsPolicy: DEFAULT_SKILLS_POLICY,
        settingsTrustedProjectDirs: trustedDefaults,
        settingsTrustedProjectDirsSource: trustedDefaults.length > 0 ? 'config' : 'default',
        settingsTrustRestartRequired: false,
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

  applyEvent: (info) => {
    const projectId = info?.projectId
    const sessionId = info?.sessionId
    // Счётчики поднимаются всегда (общий `revision`), scoped — только когда в
    // событии есть соответствующий id: панель чужого проекта/сессии не должна
    // перечитываться (её селектор не меняется).
    set((s) => ({
      revision: s.revision + 1,
      projectRevisions: projectId
        ? { ...s.projectRevisions, [projectId]: (s.projectRevisions[projectId] ?? 0) + 1 }
        : s.projectRevisions,
      sessionRevisions: sessionId
        ? { ...s.sessionRevisions, [sessionId]: (s.sessionRevisions[sessionId] ?? 0) + 1 }
        : s.sessionRevisions,
    }))
    // Перечитываем **только загруженное**: событие — сигнал «состав изменился»,
    // а не приказ тянуть админские разделы впервые (без прав они ответили бы
    // ошибкой). Реестр скиллов грузит любой, у кого он уже открыт; бандлы и
    // instance-настройки — их разделы. Локальные правки списка
    // (create/update/delete) не затрагиваются: они работают поверх того же
    // состояния, что и перечитывание.
    if (get().skills !== null) void get().fetchSkills()
    if (get().bundles !== null) void get().fetchBundles()
    if (get().settingsDisabled !== null) void get().fetchSkillsSettings()
  },
}))

/**
 * Revision изменений скиллов **конкретного проекта** (`0` — событий не было).
 *
 * Селектор для `useSkillsStore(...)`: панель проекта подписывается точечно и не
 * перечитывается на события чужих проектов.
 */
export function skillsRevisionForProject(
  store: Pick<SkillsStore, 'projectRevisions'>,
  projectId: string | null | undefined,
): number {
  if (!projectId) return 0
  return store.projectRevisions[projectId] ?? 0
}

/** Revision изменений скиллов **конкретной сессии** (`0` — событий не было). */
export function skillsRevisionForSession(
  store: Pick<SkillsStore, 'sessionRevisions'>,
  sessionId: string | null | undefined,
): number {
  if (!sessionId) return 0
  return store.sessionRevisions[sessionId] ?? 0
}

/** Хук-обёртка над `skillsRevisionForProject` (подписка точечная). */
export function useSkillsRevisionForProject(projectId: string | null | undefined): number {
  return useSkillsStore((s) => skillsRevisionForProject(s, projectId))
}

/** Хук-обёртка над `skillsRevisionForSession` (подписка точечная). */
export function useSkillsRevisionForSession(sessionId: string | null | undefined): number {
  return useSkillsStore((s) => skillsRevisionForSession(s, sessionId))
}

/**
 * Патч состояния доверенных каталогов из ответа настроек скиллов.
 * Поля аддитивные: старый сервер их не отдаёт — берём безопасные значения
 * (`effectiveFallback` сохраняет текущий список, источник — `default`).
 */
function trustedProjectDirsPatch(
  r: SkillsSettingsResponse,
  effectiveFallback: string[] = [],
): Pick<
  SkillsStore,
  | 'settingsTrustedProjectDirs'
  | 'settingsTrustedProjectDirsDefaults'
  | 'settingsTrustedProjectDirsSource'
  | 'settingsTrustRestartRequired'
> {
  return {
    settingsTrustedProjectDirs: r.trustedProjectDirs ?? effectiveFallback,
    settingsTrustedProjectDirsDefaults: r.trustedProjectDirsDefaults ?? [],
    settingsTrustedProjectDirsSource: r.trustedProjectDirsSource ?? 'default',
    settingsTrustRestartRequired: r.restartRequired ?? false,
  }
}

/** Деталь скилла → сводка реестра (без тела/файлов). */
function toSummary(detail: SkillDetail): SkillSummary {
  const { meta, body, files, ...summary } = detail
  void meta
  void body
  void files
  return summary
}
