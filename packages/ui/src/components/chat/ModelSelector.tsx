import { useState, useMemo, useEffect, useRef, useCallback, memo } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useProvidersStore } from '@/stores/providersStore'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { useUIStore } from '@/stores/useUIStore'
import { synthApi } from '@/lib/api/synthApi'
import { ProviderIcon } from '@/components/admin/ProviderIcon'
import { Icon } from '../icon/Icon'
import { OverlayScrollbar } from '../ui/OverlayScrollbar'
import type { ModelInfo, ProviderInfo } from '@/lib/api/synthApi'

type DropdownItem =
  | { type: 'empty'; text: string; id: string }
  | { type: 'label'; text: string; icon: string; id: string; isProvider?: boolean; collapsed?: boolean; providerUrl?: string }
  | { type: 'separator'; id: string }
  | { type: 'model'; model: ModelInfo; provider: ProviderInfo; isFavorite: boolean; id: string }

export function ModelSelector({ compact = false, sessionId, alwaysShowLabel = false }: { compact?: boolean; sessionId?: string; alwaysShowLabel?: boolean }) {
  const providers = useProvidersStore(s => s.providers)
  const models = useProvidersStore(s => s.models)
  const selectedProviderName = useProvidersStore(s => s.selectedProviderName)
  const selectedModelName = useProvidersStore(s => s.selectedModelName)
  const setSelectedProvider = useProvidersStore(s => s.setSelectedProvider)
  const setSelectedModel = useProvidersStore(s => s.setSelectedModel)
  const favorites = useProvidersStore(s => s.favorites)
  const recents = useProvidersStore(s => s.recents)
  const toggleFavorite = useProvidersStore(s => s.toggleFavorite)
  const loadProviders = useProvidersStore(s => s.loadProviders)
  const loadModels = useProvidersStore(s => s.loadModels)
  const loading = useProvidersStore(s => s.loading)
  const error = useProvidersStore(s => s.error)
  const { t } = useI18n()
  const { deviceType } = useDevice()
  const centralNarrow = useUIStore((s) => s.centralNarrow)
  const isMobile = deviceType !== 'desktop' || centralNarrow
  const [searchQuery, setSearchQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(new Set())

  const currentProvider = providers.find((p) => p.name === selectedProviderName)
  const scrollContainerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (providers.length === 0 || models.length === 0) {
      Promise.all([loadProviders(), loadModels()])
    }
  }, [providers.length, models.length])

  const handleRefresh = () => {
    Promise.all([loadProviders(), loadModels()])
  }

  const toggleCollapse = (providerName: string) => {
    setCollapsedProviders((prev) => {
      const next = new Set(prev)
      if (next.has(providerName)) {
        next.delete(providerName)
      } else {
        next.add(providerName)
      }
      return next
    })
  }

  if (compact) {
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="model-selector-trigger flex shrink-0 items-center gap-1.5 cursor-pointer hover:opacity-70 min-w-0">
            <ProviderIcon icon={currentProvider?.icon ?? ''} baseUrl={currentProvider?.url} size={14} className="text-muted-foreground shrink-0" />
            <span className="font-medium text-foreground text-xs truncate">
              {selectedModelName || currentProvider?.model || '—'}
            </span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            sideOffset={4}
            className="min-w-[12.5rem] p-1 bg-popover text-popover-foreground rounded-xl ring-1 ring-foreground/10 shadow-lg z-50"
            align="end"
            collisionPadding={8}
          >
            {models.filter((m) => m.enabled).slice(0, 10).map((m) => {
              const p = providers.find((pv) => pv.name === m.provider)
              return (
              <DropdownMenu.Item
                key={`${m.provider}:${m.name}`}
                onClick={() => {
                  setSelectedProvider(m.provider)
                  setSelectedModel(m.name)
                }}
                className="text-xs flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-interactive-hover data-[highlighted]:bg-interactive-selection outline-none"
              >
                <ProviderIcon icon={p?.icon ?? ''} baseUrl={p?.url} size={14} className="text-muted-foreground shrink-0" />
                <span className="font-medium truncate flex-1">{m.name}</span>
                {selectedModelName === m.name && (
                  <Icon name="check" className="size-3.5 text-primary shrink-0" />
                )}
              </DropdownMenu.Item>
            )})}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    )
  }

  const filteredModels = useMemo(
    () => models.filter((m) => m.enabled),
    [models],
  )

  const filteredBySearch = useMemo(() => {
    if (!searchQuery.trim()) return filteredModels
    const q = searchQuery.toLowerCase()
    return filteredModels.filter((m) => m.name.toLowerCase().includes(q))
  }, [filteredModels, searchQuery])

  const favoriteModels = useMemo(() => {
    return favorites
      .map((fav) => {
        const [prov, ...nameParts] = fav.split(':')
        const name = nameParts.join(':')
        const model = models.find((m) => m.provider === prov && m.name === name)
        const provider = providers.find((p) => p.name === prov)
        return model && provider ? { model, provider } : null
      })
      .filter(Boolean) as { model: ModelInfo; provider: ProviderInfo }[]
  }, [favorites, models, providers])

  const recentModels = useMemo(() => {
    return recents
      .slice(0, 5)
      .map((rec) => {
        const [prov, ...nameParts] = rec.split(':')
        const name = nameParts.join(':')
        const model = models.find((m) => m.provider === prov && m.name === name)
        const provider = providers.find((p) => p.name === prov)
        return model && provider ? { model, provider } : null
      })
      .filter(Boolean) as { model: ModelInfo; provider: ProviderInfo }[]
  }, [recents, models, providers])

  const groupedByProvider = useMemo(() => {
    const groups: Record<string, { provider: ProviderInfo; models: ModelInfo[] }> = {}
    for (const model of filteredBySearch) {
      const provider = providers.find((p) => p.name === model.provider)
      if (!provider) continue
      if (!groups[provider.name]) {
        groups[provider.name] = { provider, models: [] }
      }
      groups[provider.name].models.push(model)
    }
    return Object.values(groups)
  }, [filteredBySearch, providers])

  const isFavorite = useCallback(
    (model: ModelInfo) => favorites.includes(`${model.provider}:${model.name}`),
    [favorites],
  )

  const listItems = useMemo((): DropdownItem[] => {
    const items: DropdownItem[] = []
    const hasSearch = searchQuery.trim().length > 0

    if (!hasSearch && favoriteModels.length > 0) {
      items.push({ type: 'label', text: t('chat.modelControls.favorites'), icon: 'star-fill', id: 'label-fav' })
      for (const { model, provider } of favoriteModels) {
        items.push({
          type: 'model',
          model,
          provider,
          isFavorite: true,
          id: `fav-${provider.name}:${model.name}`,
        })
      }
    }

    if (!hasSearch && recentModels.length > 0) {
      if (items.length > 0) {
        items.push({ type: 'separator', id: 'sep-recent' })
      }
      items.push({ type: 'label', text: t('chat.modelControls.recent'), icon: 'time', id: 'label-recent' })
      for (const { model, provider } of recentModels) {
        items.push({
          type: 'model',
          model,
          provider,
          isFavorite: isFavorite(model),
          id: `recent-${provider.name}:${model.name}`,
        })
      }
    }

    if (groupedByProvider.length > 0) {
      if (items.length > 0) {
        items.push({ type: 'separator', id: 'sep-groups' })
      }
      for (const { provider, models: pModels } of groupedByProvider) {
        const collapsed = collapsedProviders.has(provider.name)
        items.push({
          type: 'label',
          text: provider.name,
          icon: provider.icon || '',
          id: `label-${provider.name}`,
          isProvider: true,
          collapsed,
          providerUrl: provider.url,
        })
        if (!collapsed) {
          for (const model of pModels) {
            items.push({
              type: 'model',
              model,
              provider,
              isFavorite: isFavorite(model),
              id: `${provider.name}:${model.name}`,
            })
          }
        }
      }
    }

    if (items.length === 0) {
      if (error && providers.length === 0 && models.length === 0) {
        items.push({ type: 'empty', text: error, id: 'error' })
      } else {
        items.push({ type: 'empty', text: t('chat.modelControls.noModelsFound'), id: 'empty' })
      }
    }

    return items
  }, [favoriteModels, recentModels, groupedByProvider, searchQuery, isFavorite, collapsedProviders])

  const handleSelectModel = useCallback(
    (model: ModelInfo, provider: ProviderInfo) => {
      setSelectedProvider(provider.name)
      setSelectedModel(model.name)
      if (sessionId) {
        synthApi.updateSession(sessionId, {
          settings: {
            provider: provider.name,
            model: model.name,
          },
        }).catch(() => {})
      }
      setOpen(false)
      setSearchQuery('')
    },
    [setSelectedProvider, setSelectedModel, sessionId],
  )

  const getItemSize = useCallback(
    (index: number) => {
      const item = listItems[index]
      if (!item) return 28
      switch (item.type) {
        case 'empty': return 44
        case 'label': return item.isProvider ? 32 : 26
        case 'separator': return 9
        case 'model': return 28
      }
    },
    [listItems],
  )

  const virtualizer = useVirtualizer({
    count: listItems.length,
    getScrollElement: useCallback(() => scrollContainerRef.current, [open]),
    estimateSize: getItemSize,
    overscan: 8,
  })

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        virtualizer.measure()
        virtualizer.scrollToIndex(0, { align: 'start' })
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [open])

  useEffect(() => {
    virtualizer.scrollToIndex(0, { align: 'start' })
  }, [searchQuery])

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="model-selector-trigger flex shrink-0 items-center gap-1.5 cursor-pointer hover:opacity-70 min-w-0"
          aria-label={selectedModelName || currentProvider?.model || t('chat.modelControls.searchModels')}
        >
          <ProviderIcon icon={currentProvider?.icon ?? ''} baseUrl={currentProvider?.url} size={14} className="text-muted-foreground shrink-0" />
          {(!isMobile || alwaysShowLabel) && (
            <>
              {alwaysShowLabel && currentProvider?.name && (
                <span className="min-w-0 max-w-[7.5rem] truncate text-xs text-muted-foreground">
                  {currentProvider.name}
                </span>
              )}
              <span className="min-w-0 font-medium text-xs text-foreground whitespace-nowrap max-w-[12.5rem] truncate">
                {selectedModelName || currentProvider?.model || '—'}
              </span>
            </>
          )}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          sideOffset={4}
          className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col bg-popover text-popover-foreground rounded-xl ring-1 ring-foreground/10 shadow-lg z-50"
          align="end"
          alignOffset={-40}
          collisionPadding={8}
        >
          <div className="p-2 border-b border-border/40">
            <div className="relative flex items-center gap-1">
              <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder={t('chat.modelControls.searchModels')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-[5.5rem] h-8 w-full text-xs bg-background border border-border rounded-md px-2 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus={!isMobile}
              />
              {searchQuery.trim().length > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setSearchQuery('')
                  }}
                  className="absolute right-[3.125rem] top-1/2 -translate-y-1/2 p-1 rounded hover:bg-interactive-hover text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </button>
              )}
              {(virtualizer.scrollOffset ?? 0) > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    virtualizer.scrollToIndex(0, { align: 'start' })
                  }}
                  className="absolute right-[4.5rem] top-1/2 -translate-y-1/2 p-1 rounded hover:bg-interactive-hover text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleRefresh()
                }}
                disabled={loading}
                className="absolute right-7 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-interactive-hover text-muted-foreground hover:text-foreground transition-colors"
                title={t('chat.modelControls.refresh')}
              >
                <Icon name="refresh" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  const allCollapsed = collapsedProviders.size === groupedByProvider.length
                  if (allCollapsed) {
                    setCollapsedProviders(new Set())
                  } else {
                    setCollapsedProviders(new Set(groupedByProvider.map((g) => g.provider.name)))
                  }
                }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-interactive-hover text-muted-foreground hover:text-foreground transition-colors"
                title={collapsedProviders.size === groupedByProvider.length ? t('chat.modelControls.expandAll') : t('chat.modelControls.collapseAll')}
              >
                <Icon
                  name={collapsedProviders.size === groupedByProvider.length ? 'arrow-down-s' : 'arrow-up-s'}
                  className="h-3.5 w-3.5"
                />
              </button>
            </div>
          </div>

          <div className="relative flex flex-col flex-1 min-h-0 w-full max-h-[min(400px,calc(100dvh-12rem))]">
            <div
              ref={(el) => {
                scrollContainerRef.current = el
              }}
              className="overlay-scrollbar-target flex-1 min-h-0 w-full overflow-auto"
            >
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((vItem) => {
                  const item = listItems[vItem.index]
                  if (!item) return null

                  const style: React.CSSProperties = {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: vItem.size,
                    transform: `translateY(${vItem.start}px)`,
                  }

                  if (item.type === 'empty') {
                    return (
                      <div key={item.id} style={style} className="flex items-center justify-center px-2 text-xs text-muted-foreground">
                        {item.text}
                      </div>
                    )
                  }

                  if (item.type === 'label') {
                    const iconName = item.icon as string
                    if (item.isProvider) {
                      return (
                        <div
                          key={item.id}
                          style={style}
                          onClick={() => toggleCollapse(item.text)}
                          className="flex items-center gap-2 px-2 py-1.5 border-b border-border/30 cursor-pointer hover:bg-interactive-hover rounded-none"
                        >
                          <ProviderIcon icon={item.icon} baseUrl={item.providerUrl} size={16} />
                          <span className="font-semibold text-xs text-foreground flex-1">{item.text}</span>
                          <Icon
                            name={item.collapsed ? 'arrow-right-s' : 'arrow-down-s'}
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          />
                        </div>
                      )
                    }
                    return (
                      <div key={item.id} style={style} className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30">
                        <Icon name={iconName as 'star-fill' | 'time'} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="text-[0.625rem] font-semibold text-muted-foreground uppercase tracking-wider">{item.text}</span>
                      </div>
                    )
                  }

                  if (item.type === 'separator') {
                    return <div key={item.id} style={style} className="flex items-center px-2"><hr className="w-full border-t border-border/30" /></div>
                  }

                  if (item.type === 'model') {
                    return (
                      <div key={item.id} style={style}>
                        <VirtualModelRow
                          model={item.model}
                          provider={item.provider}
                          isSelected={selectedModelName === item.model.name && selectedProviderName === item.provider.name}
                          isFavorite={item.isFavorite}
                          onToggleFavorite={() => toggleFavorite(item.model)}
                          onSelect={() => handleSelectModel(item.model, item.provider)}
                        />
                      </div>
                    )
                  }

                  return null
                })}
              </div>
            </div>
            <OverlayScrollbar
              containerRef={scrollContainerRef as React.RefObject<HTMLElement>}
              minThumbSize={24}
              hideDelayMs={1000}
            />
          </div>

        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

interface ModelRowProps {
  model: ModelInfo
  provider: ProviderInfo
  isSelected: boolean
  isFavorite: boolean
  onToggleFavorite: () => void
  onSelect: () => void
}

const VirtualModelRow = memo(function VirtualModelRow({
  model,
  provider,
  isSelected,
  isFavorite,
  onToggleFavorite,
  onSelect,
}: ModelRowProps) {
  return (
    <div
      onClick={onSelect}
      className="text-xs group flex items-center gap-2 pl-4 pr-2 py-1.5 rounded-lg cursor-pointer hover:bg-interactive-hover outline-none"
    >
      <ProviderIcon icon={provider.icon || ''} baseUrl={provider.url} size={14} className="text-muted-foreground shrink-0" />
      <span className="font-medium truncate flex-1">{model.name}</span>
      {isSelected && <Icon name="check" className="h-3.5 w-3.5 text-primary shrink-0" />}
      {model.context_window != null && model.context_window > 0 && (
        <span className="text-[0.625rem] text-muted-foreground shrink-0">{model.context_window}</span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite()
        }}
        className="shrink-0 p-0.5 opacity-0 group-hover:opacity-100 hover:text-primary transition-opacity"
      >
        <Icon
          name={isFavorite ? 'star-fill' : 'star'}
          className={`h-3 w-3 ${isFavorite ? 'text-primary' : 'text-muted-foreground'}`}
        />
      </button>
    </div>
  )
})
