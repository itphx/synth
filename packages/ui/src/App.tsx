import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ToastContainer } from 'react-toastify'
import { TooltipProvider } from './components/ui/tooltip'
import { TitleTooltipBridge } from './components/ui/TitleTooltipBridge'
import { useUIStore } from '@/stores/useUIStore'
import { useI18nStore } from '@/lib/i18n/store'
import { DEFAULT_THEME, DEFAULT_THEME_MODE, DEFAULT_LOCALE } from '@/lib/defaults'
import { Sidebar } from './components/layout/Sidebar'
import { Header } from './components/layout/Header'
import { LeftPanel } from './components/panels/LeftPanel'
import { RightPanel } from './components/panels/RightPanel'
import { ProjectsTabToolbar } from './components/panels/ProjectsTabToolbar'
import { FilesTabToolbar } from './components/panels/FilesTabToolbar'
import { GitTabToolbar } from './components/panels/GitTabToolbar'
import { CenterPanel } from './components/layout/CenterPanel'
import { MobileDrawer } from './components/layout/MobileDrawer'
import { BackendConnection } from './components/layout/BackendConnection'
import { ConnectionGuard } from './components/layout/ConnectionGuard'
import { PwaUpdatePrompt } from './components/layout/PwaUpdatePrompt'
import { HybridOfflineBanner } from './components/layout/HybridOfflineBanner'
import { EntityEditDialog } from './components/ui/EntityEditDialog'
import { ConfirmDialog } from './components/ui/confirm-dialog'
import { AuthGate } from './components/auth/AuthGate'
import { profileService } from '@/lib/api/profileService'
import {
  applyServerDefaultUiScale,
  getDefaultUiScale,
  normalizeUiScale,
  setServerScaleDefaults,
} from '@/lib/uiScale'
import { useAuthStore } from '@/stores/authStore'
import { useConfirmStore } from '@/stores/confirmStore'
import { useDevice } from '@/hooks/useDevice'
import { useViewportHeight } from '@/hooks/useViewportHeight'

/**
 * Тяжёлые модалки (настройки+админка ≈ 0.8 МБ, логи и аудит, аналитика и
 * отчёты) грузятся лениво: в entry-граф их код не входит, чанк подтягивается при
 * первом открытии (и прогревается в простое — см. эффект в `App`), см.
 * `useMountedOnce`.
 */
const LazySettingsModal = lazy(() =>
  import('./components/settings/SettingsModal').then((m) => ({ default: m.SettingsModal })),
)
const LazyLogsModal = lazy(() =>
  import('./components/logviewer/LogsModal').then((m) => ({ default: m.LogsModal })),
)
const LazyAnalyticsModal = lazy(() =>
  import('./components/analytics/AnalyticsModal').then((m) => ({ default: m.AnalyticsModal })),
)

function SettingsModal() {
  return (
    <Suspense fallback={null}>
      <LazySettingsModal />
    </Suspense>
  )
}

function LogsModal() {
  return (
    <Suspense fallback={null}>
      <LazyLogsModal />
    </Suspense>
  )
}

function AnalyticsModal() {
  return (
    <Suspense fallback={null}>
      <LazyAnalyticsModal />
    </Suspense>
  )
}

/**
 * Монтирует узел при первом открытии и оставляет смонтированным. Так тяжёлый чанк
 * не тянется при загрузке, но закрытие остаётся анимированным: Base UI держит popup
 * в DOM до конца transition (`data-[ending-style]`), поэтому мгновенный unmount
 * «съедал» бы анимацию и сбрасывал внутреннее состояние диалога.
 */
function useMountedOnce(open: boolean): boolean {
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) setMounted(true)
  }, [open])

  return mounted
}

function DefaultsSync() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const isInitialized = useAuthStore(s => s.isInitialized)

  useEffect(() => {
    if (!isInitialized) {
      return
    }

    if (!isAuthenticated) {
      // Тему/режим НЕ сбрасываем: ThemeSystemContext на старте применил
      // последнюю использованную тему из cookie/localStorage
      // (theme-persistence), и экран входа должен остаться в ней.
      // Авторизованная ветка ниже перезапишет её темой профиля с сервера.
      useI18nStore.getState().setLocale(DEFAULT_LOCALE)
      return
    }

    const apply = async () => {
      const prefs = await profileService.getEffectivePreferences()
      if (prefs) {
        useUIStore.setState({
          theme: prefs.theme || DEFAULT_THEME,
          themeMode: prefs.themeMode || DEFAULT_THEME_MODE,
        })
        // Язык — единственный источник истины `useI18nStore` (персистится).
        useI18nStore.getState().setLocale(prefs.locale || DEFAULT_LOCALE)
      }

      const defaults = await profileService.getDefaults()
      setServerScaleDefaults({
        mobile: defaults.uiScaleMobile ?? null,
        desktop: defaults.uiScaleDesktop ?? null,
      })
      if (applyServerDefaultUiScale()) {
        useUIStore.setState({ uiScale: normalizeUiScale(getDefaultUiScale()) })
      }
    }
    apply()
  }, [isAuthenticated, isInitialized])

  return null
}

function App() {
  const leftPanel = useUIStore(s => s.leftPanel)
  const rightPanel = useUIStore(s => s.rightPanel)
  const setLeftPanelWidth = useUIStore(s => s.setLeftPanelWidth)
  const setRightPanelWidth = useUIStore(s => s.setRightPanelWidth)
  const setSettingsDialogOpen = useUIStore(s => s.setSettingsDialogOpen)
  const setSettingsPage = useUIStore(s => s.setSettingsPage)
  const isSettingsDialogOpen = useUIStore(s => s.isSettingsDialogOpen)
  const isLogsDialogOpen = useUIStore(s => s.isLogsDialogOpen)
  const isAnalyticsDialogOpen = useUIStore(s => s.isAnalyticsDialogOpen)
  const settingsModalMounted = useMountedOnce(isSettingsDialogOpen)
  const logsModalMounted = useMountedOnce(isLogsDialogOpen)
  const analyticsModalMounted = useMountedOnce(isAnalyticsDialogOpen)
  const leftPanelTab = useUIStore(s => s.leftPanelTab)
  const mobileLeftOpen = useUIStore(s => s.mobileLeftOpen)
  const mobileRightOpen = useUIStore(s => s.mobileRightOpen)
  const setMobileLeftOpen = useUIStore(s => s.setMobileLeftOpen)
  const setMobileRightOpen = useUIStore(s => s.setMobileRightOpen)
  const forwardMode = useUIStore(s => s.forwardMode)
  const { deviceType } = useDevice()
  useViewportHeight()
  const isMobile = deviceType !== 'desktop'
  const confirmOpen = useConfirmStore(s => s.open)
  const confirmOptions = useConfirmStore(s => s.options)
  const closeConfirm = useConfirmStore(s => s.closeConfirm)

  const centerNodeRef = useRef<HTMLDivElement | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)

  const applyCentralNarrow = useCallback((narrow: boolean) => {
    useUIStore.getState().setCentralNarrow(narrow)
    document.documentElement.classList.toggle('central-narrow', narrow)
  }, [])

  const centerRef = useCallback((node: HTMLDivElement | null) => {
    centerNodeRef.current = node
    roRef.current?.disconnect()
    roRef.current = null
    if (!node) {
      applyCentralNarrow(false)
      return
    }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        applyCentralNarrow(w > 0 && w < 800)
      }
    })
    ro.observe(node)
    roRef.current = ro
  }, [applyCentralNarrow])

  useEffect(() => {
    if (typeof ResizeObserver !== 'undefined') return
    const onResize = () => {
      const el = centerNodeRef.current
      if (!el) return
      const w = el.getBoundingClientRect().width
      applyCentralNarrow(w > 0 && w < 800)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [applyCentralNarrow])

  useEffect(() => {
    if (isMobile) {
      useUIStore.getState().setMobileLeftOpen(false)
      useUIStore.getState().setMobileRightOpen(false)
    }
  }, [isMobile])

  // Прогрев ленивых чанков в простое: первый открытый диалог не ждёт сеть.
  // Тот же `import()` переиспользует уже созданный чанк (и кэш SW).
  useEffect(() => {
    const warm = () => {
      void import('./components/settings/SettingsModal')
      void import('./components/logviewer/LogsModal')
      void import('./components/analytics/AnalyticsModal')
    }
    const idle = window.requestIdleCallback?.bind(window)
    if (!idle) {
      const timer = window.setTimeout(warm, 3000)
      return () => window.clearTimeout(timer)
    }
    const handle = idle(warm, { timeout: 8000 })
    return () => window.cancelIdleCallback?.(handle)
  }, [])

  const leftHeaderActions = leftPanelTab === 'projects' ? <ProjectsTabToolbar />
    : leftPanelTab === 'files' ? <FilesTabToolbar />
    : leftPanelTab === 'git' ? <GitTabToolbar />
    : undefined

  const panelContent = <LeftPanel />

  const centerColumn = (
    <div ref={centerRef} className="flex flex-col flex-1 min-w-0 min-h-0 relative">
      <Header onSettingsClick={() => { setSettingsPage('profile'); setSettingsDialogOpen(true) }} />
      <HybridOfflineBanner />
      <CenterPanel />
      {forwardMode.active && (
        <div
          className="absolute inset-0 z-50 bg-black/40 pointer-events-auto"
          onClick={() => useUIStore.getState().cancelForwardMode()}
        />
      )}
    </div>
  )

  const desktopLayout = (
    <div className="flex desktop-shell">
      <Sidebar
        side="left"
        width={leftPanel.width}
        isOpen={leftPanel.isOpen}
        onWidthChange={setLeftPanelWidth}
        headerActions={leftHeaderActions}
      >
        {panelContent}
      </Sidebar>

      {centerColumn}

      <Sidebar
        side="right"
        width={rightPanel.width}
        isOpen={rightPanel.isOpen}
        onWidthChange={setRightPanelWidth}
      >
        <RightPanel />
      </Sidebar>
    </div>
  )

  const mobileLayout = (
    <div className="app-shell relative flex w-full flex-col overflow-hidden bg-background pt-safe">
      {centerColumn}
      <MobileDrawer
        side="left"
        open={mobileLeftOpen}
        onClose={() => setMobileLeftOpen(false)}
        headerActions={leftHeaderActions}
      >
        <LeftPanel />
      </MobileDrawer>
      <MobileDrawer
        side="right"
        open={mobileRightOpen}
        onClose={() => setMobileRightOpen(false)}
      >
        <RightPanel />
      </MobileDrawer>
    </div>
  )

  return (
    <>
      <DefaultsSync />
      <AuthGate>
        <BackendConnection />
        <ConnectionGuard />
        <TooltipProvider>
          <TitleTooltipBridge />
          {isMobile ? mobileLayout : desktopLayout}

          {/* Ленивые модалки монтируются при первом открытии (дальше живут в DOM,
              чтобы закрытие анимировалось; `open` управляется стором). */}
          {settingsModalMounted && <SettingsModal />}
          {logsModalMounted && <LogsModal />}
          {analyticsModalMounted && <AnalyticsModal />}
          <EntityEditDialog />
        </TooltipProvider>

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={(open) => { if (!open) closeConfirm(false) }}
          title={confirmOptions?.title ?? ''}
          message={confirmOptions?.message}
          confirmLabel={confirmOptions?.confirmLabel}
          cancelLabel={confirmOptions?.cancelLabel}
          variant={confirmOptions?.variant ?? 'default'}
          icon={confirmOptions?.icon}
          onConfirm={() => closeConfirm(true)}
        />
      </AuthGate>
      <PwaUpdatePrompt />
      <ToastContainer
        position="bottom-right"
        newestOnTop
        limit={5}
        autoClose={5000}
        closeButton
        hideProgressBar
        closeOnClick={false}
        toastClassName="synth-toast"
        style={{
          // @ts-expect-error CSS custom properties
          '--toastify-toast-min-height': '2.75rem',
          '--toastify-toast-padding': '0.625rem 0.875rem',
          '--toastify-color-success': 'oklch(0.68 0.12 145)',
          '--toastify-color-warning': 'oklch(0.7 0.13 95)',
          '--toastify-color-error': 'oklch(0.65 0.15 30)',
          '--toastify-color-info': 'oklch(0.68 0.12 230)',
          '--toastify-icon-color-success': 'oklch(0.68 0.12 145)',
          '--toastify-icon-color-warning': 'oklch(0.7 0.13 95)',
          '--toastify-icon-color-error': 'oklch(0.65 0.15 30)',
          '--toastify-icon-color-info': 'oklch(0.68 0.12 230)',
          '--toastify-color-progress-success': 'oklch(0.68 0.12 145)',
          '--toastify-color-progress-warning': 'oklch(0.7 0.13 95)',
          '--toastify-color-progress-error': 'oklch(0.65 0.15 30)',
          '--toastify-color-progress-info': 'oklch(0.68 0.12 230)',
        }}
      />
    </>
  )
}

export default App
