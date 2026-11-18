import { useEffect, useRef } from 'react'

import { useUIStore } from '@/stores/useUIStore'
import { useI18n } from '@/lib/i18n'
import { verifyTerminalTabs } from '@/lib/terminalTabs'
import { SynthLogo } from '../ui/SynthLogo'
import { CenterTabs } from './CenterTabs'
import { ChatTab } from '../chat/ChatTab'
import { FileViewerTab } from '../chat/FileViewerTab'
import { FileEditorTab } from '../chat/FileEditorTab'
import { CommitDetailTab } from '../chat/CommitDetailTab'
import { PipelineTab } from '../pipelines/PipelineTab'
import { PipelineRunTab } from '../pipelines/PipelineRunTab'
import { TerminalView } from '../terminal/TerminalView'
import { TerminalSessionView } from '../terminal/TerminalSessionView'
import { ProcessLogTab } from '../processes/ProcessLogTab'
import { BlockingLogTab } from '../processes/BlockingLogTab'

function EmptyState() {
  const { t } = useI18n()
  return (
    <div className="flex flex-1 items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="relative isolate">
          {/* Мягкое свечение вокруг логотипа; не перекрывает контент и не влияет на лейаут */}
          <div
            className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-primary/20 blur-3xl"
            aria-hidden="true"
          />
          <SynthLogo width={120} height={120} className="text-primary" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('app.title')}</h1>
        <p className="text-muted-foreground">{t('app.subtitle')}</p>
        <p className="text-xs text-muted-foreground/60 mt-4">{t('center.noTabs')}</p>
      </div>
    </div>
  )
}

export function CenterPanel() {
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)

  const activeTab = centerTabs.find((t) => t.id === activeCenterTabId)

  // Терминалы живут в памяти процесса: после рестарта ядра сервер их не
  // знает (`GET /terminals/:id` → 404) — сохранённые вкладки терминала
  // закрываем, чтобы они не «висели» пустым экраном.
  const verifiedRef = useRef(false)
  useEffect(() => {
    if (verifiedRef.current) return
    verifiedRef.current = true
    void verifyTerminalTabs()
  }, [])

  const renderTabContent = () => {
    if (!activeTab) {
      return <EmptyState />
    }

    switch (activeTab.type) {
      case 'chat':
        return <ChatTab tab={activeTab} />
      case 'file-viewer':
        return <FileViewerTab tab={activeTab} />
      case 'file-editor':
        return <FileEditorTab tab={activeTab} />
      case 'commit-detail':
        return <CommitDetailTab tab={activeTab} />
      // ADR-101 (Э7): страницы пайплайна и прогона.
      case 'pipeline':
        return <PipelineTab tab={activeTab} />
      case 'pipeline-run':
        return <PipelineRunTab tab={activeTab} />
      // PROP-132: вкладка терминала. Вкладка сессии — с переключателем
      // терминалов; одиночная — просто терминал.
      case 'terminal':
        return activeTab.data.sessionId ? (
          <TerminalSessionView tab={activeTab} />
        ) : (
          <TerminalView tab={activeTab} />
        )
      // Экран «Вывод процесса» (per-run: лог фонового прогона).
      case 'process-log':
        // ADR-111 §detach: у блокирующего прогона своя вкладка live-лога —
        // read-only поток, который читается до завершения прогона.
        return activeTab.data.blockingRunId ? (
          <BlockingLogTab tab={activeTab} />
        ) : (
          <ProcessLogTab tab={activeTab} />
        )
      default:
        return <EmptyState />
    }
  }

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <CenterTabs />
      <div className="flex flex-1 overflow-hidden">
        {renderTabContent()}
      </div>
    </main>
  )
}
