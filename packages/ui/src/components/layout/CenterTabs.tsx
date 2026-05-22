import { useRef, useEffect } from 'react'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'

const TAB_ICONS: Record<CenterTab['type'], string> = {
  chat: 'chat-new',
  'file-viewer': 'file-3',
  'file-editor': 'edit-2',
}

export function CenterTabs() {
  const { t } = useI18n()
  const { centerTabs, activeCenterTabId, setActiveCenterTab, closeTab } = useUIStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (activeCenterTabId && scrollRef.current) {
      const el = scrollRef.current.querySelector(`[data-tab-id="${activeCenterTabId}"]`)
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    }
  }, [activeCenterTabId])

  if (centerTabs.length === 0) {
    return null
  }

  return (
    <div className="flex shrink-0 items-center border-b border-border bg-background px-1">
      <div
        ref={scrollRef}
        className="flex flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none"
      >
        {centerTabs.map((tab) => {
          const isActive = tab.id === activeCenterTabId
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={`group flex shrink-0 items-center gap-1.5 rounded-t-md px-3 py-1.5 cursor-pointer transition-colors select-none ${
                isActive
                  ? 'bg-card text-foreground border-x border-t border-border'
                  : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover'
              }`}
              onClick={() => setActiveCenterTab(tab.id)}
            >
              <Icon name={TAB_ICONS[tab.type]} className="size-4 shrink-0" />
              <span className="text-xs font-medium truncate max-w-[140px]">{tab.title}</span>
              <button
                className="ml-0.5 rounded-sm p-0.5 opacity-0 group-hover:opacity-100 hover:bg-interactive-hover transition-opacity shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
                title={t('center.closeTab')}
              >
                <Icon name="close" className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
