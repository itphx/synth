import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ThemeMode, Locale } from '../lib/theme/themes'
import { profileService } from '@/lib/api/profileService'
import { applyUiScale, normalizeUiScale, persistUiScale, readUiScale } from '@/lib/uiScale'

export type TransportMode = 'auto' | 'ws' | 'sse'

const LEFT_PANEL_MIN_WIDTH = 280
const LEFT_PANEL_MAX_WIDTH = 500
const RIGHT_PANEL_MIN_WIDTH = 320
const RIGHT_PANEL_MAX_WIDTH = 860

interface LeftPanelState {
  isOpen: boolean
  width: number
  minWidth: number
  maxWidth: number
}

interface RightPanelState {
  isOpen: boolean
  width: number
  minWidth: number
  maxWidth: number
}

export type CenterTabType = 'chat' | 'file-viewer' | 'file-editor' | 'commit-detail'

export interface CenterTab {
  id: string
  type: CenterTabType
  title: string
  data: {
    sessionId?: string
    filePath?: string
    projectId?: string
    commitHash?: string
    repoPath?: string
  }
  editingState?: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
}

export type StatusType = 'info' | 'warning' | 'error' | 'success' | 'stream'

export interface StatusMessage {
  id: string
  text: string
  type: StatusType
  timestamp: number
}

export interface ForwardModeState {
  active: boolean
  sourceSessionId: string | null
  sourceIndices: number[]
  mode: 'forward' | 'merge'
}

interface UIStore {
  leftPanel: LeftPanelState
  rightPanel: RightPanelState
  toggleLeftPanel: () => void
  setLeftPanelWidth: (width: number) => void
  setLeftPanelOpen: (open: boolean) => void
  toggleRightPanel: () => void
  setRightPanelWidth: (width: number) => void
  setRightPanelOpen: (open: boolean) => void

  /** Мобильные дроверы (phone/tablet) — не персистятся и не связаны с desktop-полями. */
  mobileLeftOpen: boolean
  setMobileLeftOpen: (open: boolean) => void
  mobileRightOpen: boolean
  setMobileRightOpen: (open: boolean) => void

  /** Центральная колонка узкая (десктоп с открытыми панелями) — runtime-флаг,
   *  выставляется ResizeObserver'ом в App. Не персистится. */
  centralNarrow: boolean
  setCentralNarrow: (narrow: boolean) => void

  leftPanelTab: string
  setLeftPanelTab: (tab: string) => void
  rightPanelTab: string
  setRightPanelTab: (tab: string) => void
  collapsedProjects: Set<string>
  toggleProjectCollapse: (projectId: string) => void

  isSettingsDialogOpen: boolean
  setSettingsDialogOpen: (open: boolean) => void
  settingsPage: string
  setSettingsPage: (page: string) => void

  isLogsDialogOpen: boolean
  setLogsDialogOpen: (open: boolean) => void
  logsPage: string
  setLogsPage: (page: string) => void

  forwardMode: ForwardModeState
  enterForwardMode: (sourceSessionId: string, sourceIndices: number[], mode: 'forward' | 'merge') => void
  cancelForwardMode: () => void
  forwardConfirmAction: ((targetSessionId: string, position: 'after' | 'before', summarize: boolean) => void) | null

  theme: string
  setTheme: (theme: string) => void
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void

  locale: Locale
  setLocale: (locale: Locale) => void

  uiScale: number
  setUiScale: (scale: number) => void

  centerTabs: CenterTab[]
  activeCenterTabId: string | null
  openTab: (tab: CenterTab) => void
  updateTabTitle: (tabId: string, newTitle: string) => void
  setTabEditingState: (tabId: string, editingState: CenterTab['editingState']) => void
  closeTab: (tabId: string) => void
  setActiveCenterTab: (tabId: string) => void
  reorderTabs: (fromIndex: number, toIndex: number) => void

  transportMode: TransportMode
  setTransportMode: (mode: TransportMode) => void

  intermediateTextDisplay: 'inline' | 'bottom'
  setIntermediateTextDisplay: (mode: 'inline' | 'bottom') => void

  /** AD-071 §2.6: сигнал изменения instance-wide `tools.disabled` — статистика
   *  и таблицы MCP перезапрашиваются без рестарта. Runtime, не персистится. */
  toolsDisabledTick: number
  bumpToolsDisabledTick: () => void
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      leftPanel: {
        isOpen: true,
        width: LEFT_PANEL_MIN_WIDTH,
        minWidth: LEFT_PANEL_MIN_WIDTH,
        maxWidth: LEFT_PANEL_MAX_WIDTH,
      },
      rightPanel: {
        isOpen: false,
        width: RIGHT_PANEL_MIN_WIDTH,
        minWidth: RIGHT_PANEL_MIN_WIDTH,
        maxWidth: RIGHT_PANEL_MAX_WIDTH,
      },

      toggleLeftPanel: () =>
        set((state) => ({
          leftPanel: {
            ...state.leftPanel,
            isOpen: !state.leftPanel.isOpen,
          },
        })),

      setLeftPanelOpen: (open) =>
        set((state) => ({
          leftPanel: {
            ...state.leftPanel,
            isOpen: open,
          },
        })),

      setLeftPanelWidth: (width) =>
        set((state) => ({
          leftPanel: {
            ...state.leftPanel,
            width: Math.min(
              state.leftPanel.maxWidth,
              Math.max(state.leftPanel.minWidth, width)
            ),
          },
        })),

      toggleRightPanel: () =>
        set((state) => ({
          rightPanel: {
            ...state.rightPanel,
            isOpen: !state.rightPanel.isOpen,
          },
        })),

      setRightPanelOpen: (open) =>
        set((state) => ({
          rightPanel: {
            ...state.rightPanel,
            isOpen: open,
          },
        })),

      setRightPanelWidth: (width) =>
        set((state) => ({
          rightPanel: {
            ...state.rightPanel,
            width: Math.min(
              state.rightPanel.maxWidth,
              Math.max(state.rightPanel.minWidth, width)
            ),
          },
        })),

      mobileLeftOpen: false,
      setMobileLeftOpen: (open) => set({ mobileLeftOpen: open }),
      mobileRightOpen: false,
      setMobileRightOpen: (open) => set({ mobileRightOpen: open }),

      centralNarrow: false,
      setCentralNarrow: (narrow) => set({ centralNarrow: narrow }),

      leftPanelTab: 'projects',
      setLeftPanelTab: (tab) => set({ leftPanelTab: tab }),
      // AD-071: дефолтная вкладка правой панели — «Контекст».
      rightPanelTab: 'context',
      setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
      collapsedProjects: new Set<string>(),
      toggleProjectCollapse: (projectId) =>
        set((state) => {
          const next = new Set(state.collapsedProjects)
          if (next.has(projectId)) {
            next.delete(projectId)
          } else {
            next.add(projectId)
          }
          return { collapsedProjects: next }
        }),

      isSettingsDialogOpen: false,
      setSettingsDialogOpen: (open) => set({ isSettingsDialogOpen: open }),
      settingsPage: 'appearance',
      setSettingsPage: (page) => set({ settingsPage: page }),

      isLogsDialogOpen: false,
      setLogsDialogOpen: (open) => set({ isLogsDialogOpen: open }),
      logsPage: 'core',
      setLogsPage: (page) => set({ logsPage: page }),

      forwardMode: {
        active: false,
        sourceSessionId: null,
        sourceIndices: [],
        mode: 'forward',
      },
      enterForwardMode: (sourceSessionId, sourceIndices, mode) =>
        set({ forwardMode: { active: true, sourceSessionId, sourceIndices, mode } }),
      cancelForwardMode: () =>
        set({ forwardMode: { active: false, sourceSessionId: null, sourceIndices: [], mode: 'forward' } }),
      forwardConfirmAction: null,

      theme: 'flexoki',
      setTheme: (theme) => {
        set({ theme })
        profileService.syncThemeToProfile(theme)
      },
      themeMode: 'system',
      setThemeMode: (mode) => {
        set({ themeMode: mode })
        profileService.syncThemeModeToProfile(mode)
      },

      locale: 'ru',
      setLocale: (locale) => {
        set({ locale })
        profileService.syncLocaleToProfile(locale)
      },

      uiScale: readUiScale(),
      setUiScale: (scale) => {
        applyUiScale(scale)
        persistUiScale(scale)
        set({ uiScale: normalizeUiScale(scale) })
      },

      centerTabs: [],
      activeCenterTabId: null,

      openTab: (tab) =>
        set((state) => {
          const existingIdx = state.centerTabs.findIndex((t) => t.id === tab.id)
          if (existingIdx >= 0) {
            const nextTabs = [...state.centerTabs]
            nextTabs[existingIdx] = { ...nextTabs[existingIdx], title: tab.title }
            return { centerTabs: nextTabs, activeCenterTabId: tab.id, mobileLeftOpen: false }
          }
          return {
            centerTabs: [...state.centerTabs, tab],
            activeCenterTabId: tab.id,
            mobileLeftOpen: false,
          }
        }),

      updateTabTitle: (tabId, newTitle) =>
        set((state) => ({
          centerTabs: state.centerTabs.map((t) =>
            t.id === tabId ? { ...t, title: newTitle } : t
          ),
        })),

      setTabEditingState: (tabId, editingState) =>
        set((state) => ({
          centerTabs: state.centerTabs.map((t) =>
            t.id === tabId ? { ...t, editingState } : t
          ),
        })),

      closeTab: (tabId) =>
        set((state) => {
          const idx = state.centerTabs.findIndex((t) => t.id === tabId)
          const nextTabs = state.centerTabs.filter((t) => t.id !== tabId)
          let nextActive = state.activeCenterTabId
          if (state.activeCenterTabId === tabId) {
            if (nextTabs.length === 0) {
              nextActive = null
            } else {
              const newIdx = Math.min(idx, nextTabs.length - 1)
              nextActive = nextTabs[newIdx].id
            }
          }
          return { centerTabs: nextTabs, activeCenterTabId: nextActive }
        }),

      setActiveCenterTab: (tabId) => set({ activeCenterTabId: tabId }),

      reorderTabs: (fromIndex, toIndex) =>
        set((state) => {
          const tabs = [...state.centerTabs]
          const [moved] = tabs.splice(fromIndex, 1)
          tabs.splice(toIndex, 0, moved!)
          return { centerTabs: tabs }
        }),

      transportMode: 'auto',
      setTransportMode: (mode: TransportMode) => {
        set({ transportMode: mode })
        profileService.syncTransportModeToProfile(mode)
      },

      intermediateTextDisplay: 'inline',
      setIntermediateTextDisplay: (mode) => {
        set({ intermediateTextDisplay: mode })
        profileService.syncIntermediateTextDisplayToProfile(mode)
      },

      toolsDisabledTick: 0,
      bumpToolsDisabledTick: () => set((state) => ({ toolsDisabledTick: state.toolsDisabledTick + 1 })),
    }),
    {
      name: 'synth-ui-settings',
      partialize: (state) => ({
        leftPanelWidth: state.leftPanel.width,
        rightPanelWidth: state.rightPanel.width,
        leftPanelIsOpen: state.leftPanel.isOpen,
        rightPanelIsOpen: state.rightPanel.isOpen,
        leftPanelTab: state.leftPanelTab,
        rightPanelTab: state.rightPanelTab,
        centerTabs: state.centerTabs,
        activeCenterTabId: state.activeCenterTabId,
        collapsedProjects: [...state.collapsedProjects],
      }),
      merge: (persisted, current) => {
        const p = persisted as Record<string, unknown> | undefined
        return {
          ...current,
          leftPanel: {
            ...current.leftPanel,
            width: Math.min(current.leftPanel.maxWidth, Math.max(current.leftPanel.minWidth, (p?.leftPanelWidth as number) ?? current.leftPanel.width)),
            isOpen: (p?.leftPanelIsOpen as boolean) ?? current.leftPanel.isOpen,
          },
          rightPanel: {
            ...current.rightPanel,
            width: Math.min(current.rightPanel.maxWidth, Math.max(current.rightPanel.minWidth, (p?.rightPanelWidth as number) ?? current.rightPanel.width)),
            isOpen: (p?.rightPanelIsOpen as boolean) ?? current.rightPanel.isOpen,
          },
          leftPanelTab: (p?.leftPanelTab as string) ?? current.leftPanelTab,
          rightPanelTab: (p?.rightPanelTab as string) ?? current.rightPanelTab,
          centerTabs: (p?.centerTabs as CenterTab[]) ?? current.centerTabs,
          activeCenterTabId: (p?.activeCenterTabId as string | null) ?? current.activeCenterTabId,
          collapsedProjects: new Set(p?.collapsedProjects as string[] ?? []),
        }
      },
    }
  )
)
