import { useEffect } from 'react'
import { ToastContainer } from 'react-toastify'
import { TooltipProvider } from './components/ui/tooltip'
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
import { BackendConnection } from './components/layout/BackendConnection'
import { UpdateNotification } from './components/layout/UpdateNotification'
import { HybridOfflineBanner } from './components/layout/HybridOfflineBanner'
import { SettingsModal } from './components/settings/SettingsModal'
import { LogsModal } from './components/logviewer/LogsModal'
import { AuthGate } from './components/auth/AuthGate'
import { profileService } from '@/lib/api/profileService'
import { useAuthStore } from '@/stores/authStore'

function DefaultsSync() {
  const { isAuthenticated, isInitialized } = useAuthStore()

  useEffect(() => {
    if (!isInitialized) {
      return
    }

    if (!isAuthenticated) {
      useUIStore.setState({
        theme: DEFAULT_THEME,
        themeMode: DEFAULT_THEME_MODE,
        locale: DEFAULT_LOCALE,
      })
      useI18nStore.getState().setLocale(DEFAULT_LOCALE)
      return
    }

    const apply = async () => {
      const prefs = await profileService.getEffectivePreferences()
      if (prefs) {
        useUIStore.setState({
          theme: prefs.theme || DEFAULT_THEME,
          themeMode: prefs.themeMode || DEFAULT_THEME_MODE,
          locale: prefs.locale || DEFAULT_LOCALE,
        })
        if (prefs.locale) {
          useI18nStore.getState().setLocale(prefs.locale)
        }
      }
    }
    apply()
  }, [isAuthenticated, isInitialized])

  return null
}

function App() {
  const { leftPanel, rightPanel, setLeftPanelWidth, setRightPanelWidth, setSettingsDialogOpen, setSettingsPage, leftPanelTab } = useUIStore()
  const forwardMode = useUIStore(s => s.forwardMode)

  const leftHeaderActions = leftPanelTab === 'projects' ? <ProjectsTabToolbar />
    : leftPanelTab === 'files' ? <FilesTabToolbar />
    : leftPanelTab === 'git' ? <GitTabToolbar />
    : undefined

  const panelContent = <LeftPanel />

  return (
    <>
      <DefaultsSync />
      <AuthGate>
        <BackendConnection />
        <UpdateNotification />
        <TooltipProvider>
        <div className="flex h-screen">
          <Sidebar
            side="left"
            width={leftPanel.width}
            isOpen={leftPanel.isOpen}
            onWidthChange={setLeftPanelWidth}
            headerActions={leftHeaderActions}
          >
            {panelContent}
          </Sidebar>

          <div className="flex flex-col flex-1 min-w-0 relative">
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

          <Sidebar
            side="right"
            width={rightPanel.width}
            isOpen={rightPanel.isOpen}
            onWidthChange={setRightPanelWidth}
          >
            <RightPanel />
          </Sidebar>
        </div>
        </TooltipProvider>

        <SettingsModal />
        <LogsModal />
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
            '--toastify-toast-min-height': '44px',
            '--toastify-toast-padding': '10px 14px',
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
      </AuthGate>
    </>
  )
}

export default App
