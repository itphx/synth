import React, { useCallback, useEffect, useState } from 'react'
import { synthApi, type SessionMemoryBlock, type SessionMemoryResponse } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { PanelTab } from './PanelTab'

/**
 * ADR-107 / PROP-047: вкладка «Память» правой панели — read-only срез памяти
 * по активной сессии: что провайдер памяти отдал в контекст последнего хода
 * (факты и recall), каков скоуп (проект/инстанс) и что доступно по индексам.
 *
 * Данные — `GET /api/v2/sessions/:id/memory` (права — чтение сессии). Плагин
 * памяти может быть не активен: сервер отдаёт `readiness: 'unavailable'` и
 * `provider.active: false` — вкладка объясняет это текстом, а не ошибкой.
 *
 * Раздел «Память» в настройках (admin) — другой контур (портал памяти);
 * отсюда для ADMIN есть кнопка перехода туда.
 */

/** Общий стиль бейджа (как в админ-разделе «Память»). */
const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа готовности памяти. */
const READINESS_CLASS: Record<string, string> = {
  ready: 'bg-status-success/15 text-status-success',
  degraded: 'bg-status-warning/15 text-status-warning',
  unavailable: 'bg-destructive/15 text-destructive',
}

/** Цвет бейджа статуса блока памяти. */
const BLOCK_STATUS_CLASS: Record<string, string> = {
  loaded: 'bg-status-success/15 text-status-success',
  truncated: 'bg-status-warning/15 text-status-warning',
  empty: 'bg-muted text-muted-foreground',
  blocked: 'bg-destructive/15 text-destructive',
  suppressed: 'bg-muted text-muted-foreground',
}

/** Статус HTTP-ошибки (503 — порты памяти не подключены). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/** Строка «подпись — значение» (как `StatCell` в «Статистике»). */
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('ml-auto truncate text-right tabular-nums text-foreground', mono && 'font-mono')}>
        {value}
      </span>
    </div>
  )
}

/** Карточка-секция правой панели (как `Section` в «Статистике»). */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {title}
      </h4>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

/**
 * Блок памяти в контексте хода: статус, размер и пояснение.
 *
 * Блока нет — «не передавался» (для recall — «в ходе не было вопроса»).
 */
function BlockRow({
  icon,
  label,
  id,
  block,
  missingHint,
  format,
}: {
  icon: string
  label: string
  /** Стабильный идентификатор блока (для data-testid). */
  id: 'facts' | 'recall'
  block: SessionMemoryBlock | undefined
  /** Пояснение для случая «блока нет». */
  missingHint: string
  format: (value: number) => string
}) {
  const { t } = useI18n()
  if (!block) {
    return (
      <div className="space-y-0.5" data-testid={`memory-block-${id}`}>
        <div className="flex items-center gap-1.5 text-xs">
          <Icon name={icon} className="size-3 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{label}</span>
          <span className="ml-auto text-muted-foreground/80">
            {t('rightPanel.memory.block.notPassed')}
          </span>
        </div>
        <div className="text-[0.6875rem] text-muted-foreground/80">{missingHint}</div>
      </div>
    )
  }
  return (
    <div className="space-y-0.5" data-testid={`memory-block-${id}`}>
      <div className="flex items-center gap-1.5 text-xs">
        <Icon name={icon} className="size-3 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{label}</span>
        <span
          data-testid={`memory-block-status-${id}`}
          className={cn(BADGE, BLOCK_STATUS_CLASS[block.status] ?? 'bg-muted text-muted-foreground')}
        >
          {t(`rightPanel.memory.blockStatus.${block.status}`)}
        </span>
        <span className="ml-auto tabular-nums text-foreground">
          {format(block.chars)} · ≈{format(block.estTokens)}
        </span>
      </div>
      <div className="text-[0.6875rem] text-muted-foreground/80">
        {t(`rightPanel.memory.block.${block.status}`)}
      </div>
    </div>
  )
}

export const MemoryTab: React.FC = () => {
  const { t, locale } = useI18n()
  const fmt = (value: number): string => value.toLocaleString(locale)

  const [data, setData] = useState<SessionMemoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Активная сессия — как в «Статистике» (активный center-tab).
  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((tab) => tab.id === activeTabId)
  const sessionId = activeTab?.data?.sessionId

  const user = useAuthStore((s) => s.user)
  const isAdmin = !!user?.roles?.some((role) => role === 'ADMIN')

  const setSettingsPage = useUIStore((s) => s.setSettingsPage)
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen)
  const setSettingsShowAdvanced = useUIStore((s) => s.setSettingsShowAdvanced)

  const load = useCallback(async () => {
    if (!sessionId) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setData(await synthApi.getSessionMemory(sessionId))
    } catch (err) {
      setData(null)
      setError(
        statusOf(err) === 503
          ? t('rightPanel.memory.unavailable')
          : t('rightPanel.memory.error', {
              error: err instanceof Error ? err.message : t('common.error'),
            }),
      )
    } finally {
      setLoading(false)
    }
  }, [sessionId, t])

  useEffect(() => {
    void load()
  }, [load])

  /** Переход в админ-раздел «Память» (раздел скрыт в режиме «Расширенные»). */
  const openSettings = useCallback(() => {
    setSettingsShowAdvanced(true)
    setSettingsPage('memory')
    setSettingsDialogOpen(true)
  }, [setSettingsDialogOpen, setSettingsPage, setSettingsShowAdvanced])

  if (!sessionId) {
    return (
      <PanelTab>
        <div className="py-2 text-center text-sm text-muted-foreground">
          {t('rightPanel.memory.noSession')}
        </div>
      </PanelTab>
    )
  }

  const lastContext = data?.lastContext ?? null
  // Нормализация: эндпоинт новый, сервер может отдать неполный срез —
  // показываем нули вместо падения вкладки.
  const readiness = data?.readiness ?? 'unavailable'
  const providerActive = data?.provider?.active === true
  const factsActive = data?.facts?.active ?? 0
  const indexes = data?.indexes ?? {
    total: 0,
    project: 0,
    instance: 0,
    ready: 0,
    building: 0,
    failed: 0,
  }

  return (
    <PanelTab
      footer={
        isAdmin ? (
          <Button
            variant="outline"
            size="sm"
            onClick={openSettings}
            data-testid="memory-open-settings"
            className="w-full"
          >
            <Icon name="settings-3" className="size-3.5" />
            {t('rightPanel.memory.openSettings')}
          </Button>
        ) : undefined
      }
    >
      {error && (
        <div
          role="alert"
          aria-live="polite"
          data-testid="memory-error"
          className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
        >
          <span className="min-w-0 break-words">{error}</span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void load()}
            data-testid="memory-retry"
          >
            <Icon name="refresh" className="size-3.5" />
            {t('rightPanel.memory.retry')}
          </Button>
        </div>
      )}

      {loading && !data && (
        <div
          role="status"
          aria-live="polite"
          data-testid="memory-loading"
          className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"
        >
          <Icon name="refresh" className="size-3.5 animate-spin" />
          {t('rightPanel.memory.loading')}
        </div>
      )}

      {data && (
        <>
          {/* 1. Статус: готовность, провайдер, проект. */}
          <Section title={t('rightPanel.memory.status')}>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="memory-badges">
              <span
                data-testid="memory-readiness-badge"
                className={cn(BADGE, READINESS_CLASS[readiness] ?? 'bg-muted text-muted-foreground')}
              >
                {t(`rightPanel.memory.readiness.${readiness}`)}
              </span>
              <span
                data-testid="memory-provider-badge"
                className={cn(
                  BADGE,
                  providerActive
                    ? 'bg-status-success/15 text-status-success'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {providerActive
                  ? t('rightPanel.memory.provider.active')
                  : t('rightPanel.memory.provider.inactive')}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs">
              <Row
                label={t('rightPanel.memory.project')}
                value={data.scope?.projectId ?? t('rightPanel.memory.noProject')}
                mono
              />
            </div>
          </Section>

          {/* 2. В контексте последнего хода: факты и recall. */}
          <Section title={t('rightPanel.memory.lastContext')}>
            {lastContext === null ? (
              <div
                data-testid="memory-no-turns"
                className="text-xs text-muted-foreground italic"
              >
                {t('rightPanel.memory.noTurns')}
              </div>
            ) : (
              <div className="space-y-2">
                <BlockRow
                  icon="brain"
                  id="facts"
                  label={t('rightPanel.memory.block.facts')}
                  block={lastContext.facts}
                  missingHint={t('rightPanel.memory.block.noFacts')}
                  format={fmt}
                />
                <BlockRow
                  icon="search"
                  id="recall"
                  label={t('rightPanel.memory.block.recall')}
                  block={lastContext.recall}
                  missingHint={t('rightPanel.memory.block.noRecall')}
                  format={fmt}
                />
              </div>
            )}
          </Section>

          {/* 3. Скоуп: факты и индексы. */}
          <Section title={t('rightPanel.memory.scope')}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <Row
                label={t('rightPanel.memory.scope.factsActive')}
                value={fmt(factsActive)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesTotal')}
                value={fmt(indexes.total)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesProject')}
                value={fmt(indexes.project)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesInstance')}
                value={fmt(indexes.instance)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesReady')}
                value={fmt(indexes.ready)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesBuilding')}
                value={fmt(indexes.building)}
              />
              <Row
                label={t('rightPanel.memory.scope.indexesFailed')}
                value={fmt(indexes.failed)}
              />
            </div>
          </Section>

          {/* 4. Подсказки: проблемы со скоупом и провайдером. */}
          {(indexes.failed > 0 || !providerActive) && (
            <Section title={t('rightPanel.memory.hints')}>
              {indexes.failed > 0 && (
                <p
                  data-testid="memory-hint-failed-indexes"
                  className="text-xs text-status-warning break-words"
                >
                  {t('rightPanel.memory.hint.failedIndexes')}
                </p>
              )}
              {!providerActive && (
                <p
                  data-testid="memory-hint-provider-inactive"
                  className="text-xs text-status-warning break-words"
                >
                  {t('rightPanel.memory.hint.providerInactive')}
                </p>
              )}
            </Section>
          )}
        </>
      )}
    </PanelTab>
  )
}
