import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'
import { useI18n } from '@/lib/i18n'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useProjectsStore } from '@/stores/projectsStore'

const TAB_ICONS: Record<CenterTab['type'], string> = {
  chat: 'chat-new',
  'file-viewer': 'file-3',
  'file-editor': 'edit-2',
  'commit-detail': 'git-commit',
}

const TAB_CONTENT_FLOOR = 160
const TAB_MAX_WIDTH = 200

function TabTooltipLabel({ tab }: { tab: CenterTab }) {
  const { t } = useI18n()
  const projects = useProjectsStore((s) => s.projects)
  const project = tab.data.projectId ? projects.find((p) => p.id === tab.data.projectId) : undefined
  const projectName = project?.name

  if (tab.type === 'chat') {
    return projectName
      ? t('center.tabTooltip.chat', { title: tab.title, project: projectName })
      : t('center.tabTooltip.noProject.chat', { title: tab.title })
  }
  if (tab.type === 'file-viewer') {
    return projectName
      ? t('center.tabTooltip.fileViewer', { title: tab.title, project: projectName })
      : t('center.tabTooltip.noProject.fileViewer', { title: tab.title })
  }
  if (tab.type === 'commit-detail') {
    return projectName
      ? t('center.tabTooltip.commitDetail', { title: tab.title, project: projectName })
      : t('center.tabTooltip.noProject.commitDetail', { title: tab.title })
  }
  return projectName
    ? t('center.tabTooltip.fileEditor', { title: tab.title, project: projectName })
    : t('center.tabTooltip.noProject.fileEditor', { title: tab.title })
}

function SortableTab({
  tab,
  isActive,
  onClose,
}: {
  tab: CenterTab
  isActive: boolean
  onClose: (id: string) => void
}) {
  const setActiveCenterTab = useUIStore((s) => s.setActiveCenterTab)
  const { t } = useI18n()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: tab.id,
    disabled: isActive,
  })

  const measureRef = useRef<HTMLDivElement>(null)
  const [effectiveMinWidth, setEffectiveMinWidth] = useState<number | undefined>(80)

  const combinedRef = useCallback((el: HTMLDivElement | null) => {
    setNodeRef(el)
    if (el) measureRef.current = el
  }, [setNodeRef])

  useLayoutEffect(() => {
    if (measureRef.current) {
      const width = measureRef.current.scrollWidth
      if (width > TAB_CONTENT_FLOOR) {
        setEffectiveMinWidth(TAB_CONTENT_FLOOR)
      } else {
        setEffectiveMinWidth(undefined)
      }
    }
  }, [tab.title, tab.type])

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    maxWidth: TAB_MAX_WIDTH,
    minWidth: effectiveMinWidth,
    flexBasis: 'auto',
    flexShrink: 1,
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          ref={combinedRef}
          style={style}
          {...attributes}
          {...(isActive ? {} : listeners)}
          data-tab-id={tab.id}
          className={cn(
            'group flex shrink items-center gap-1.5 rounded-t-md px-3 py-1.5 cursor-pointer select-none',
            isActive
              ? 'bg-card text-foreground border-x border-t border-border'
              : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover',
            isDragging && 'opacity-50',
          )}
          onClick={() => setActiveCenterTab(tab.id)}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(tab.id)
            }
          }}
        >
          <Icon name={TAB_ICONS[tab.type]} className="size-4 shrink-0" />
          <span className="text-xs font-medium truncate">{tab.title}</span>
          <button
            className="ml-0.5 rounded-sm p-0.5 opacity-0 group-hover:opacity-100 hover:bg-interactive-hover transition-opacity shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.id)
            }}
            title={t('center.closeTab')}
          >
            <Icon name="close" className="size-3" />
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <TabTooltipLabel tab={tab} />
      </TooltipContent>
    </Tooltip>
  )
}

function DraggingTabOverlay({ tab }: { tab: CenterTab }) {
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 rounded-t-md px-3 py-1.5 bg-card text-foreground border-x border-t border-border shadow-lg opacity-90"
      style={{ maxWidth: TAB_MAX_WIDTH }}
    >
      <Icon name={TAB_ICONS[tab.type]} className="size-4 shrink-0" />
      <span className="text-xs font-medium truncate">{tab.title}</span>
      <Icon name="close" className="size-3 ml-0.5" />
    </div>
  )
}

export function CenterTabs() {
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeCenterTabId = useUIStore((s) => s.activeCenterTabId)
  const closeTab = useUIStore((s) => s.closeTab)
  const reorderTabs = useUIStore((s) => s.reorderTabs)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeDragTab, setActiveDragTab] = useState<CenterTab | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const tabIds = useMemo(() => centerTabs.map((t) => t.id), [centerTabs])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const tab = centerTabs.find((t) => t.id === event.active.id)
    if (tab) setActiveDragTab(tab)
  }, [centerTabs])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragTab(null)
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = centerTabs.findIndex((t) => t.id === active.id)
    const newIdx = centerTabs.findIndex((t) => t.id === over.id)
    if (oldIdx >= 0 && newIdx >= 0) {
      reorderTabs(oldIdx, newIdx)
    }
  }, [centerTabs, reorderTabs])

  const handleClose = useCallback((tabId: string) => {
    closeTab(tabId)
  }, [closeTab])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current
    const hasLeft = scrollLeft > 1
    const hasRight = scrollWidth - scrollLeft - clientWidth > 1
    const el = scrollRef.current
    if (hasLeft && hasRight) {
      el.setAttribute('data-scroll-shadow', 'left-right')
    } else if (hasLeft) {
      el.setAttribute('data-scroll-shadow', 'left')
    } else if (hasRight) {
      el.setAttribute('data-scroll-shadow', 'right')
    } else {
      el.removeAttribute('data-scroll-shadow')
    }
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    handleScroll()
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

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
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          <div
            ref={scrollRef}
            onWheel={handleWheel}
            className="tab-scroll-container flex flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none"
          >
            {centerTabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeCenterTabId}
                onClose={handleClose}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeDragTab && <DraggingTabOverlay tab={activeDragTab} />}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
