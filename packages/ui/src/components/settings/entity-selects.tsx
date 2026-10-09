import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { AgentInfo, ProjectData, SessionData } from '@/lib/api/synthApi'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { SettingsField } from '@/components/ui/settings'
import { SessionCreateDialog } from '@/components/panels/SessionCreateDialog'
import { useI18n } from '@/lib/i18n'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAgentsStore } from '@/stores/agentsStore'

interface EntitySelectProps {
  label: string
  tooltip?: string
  value: string
  onChange: (value: string) => void
  items: ReadonlyArray<{ value: string; label: string }>
  placeholder?: string
  includeEmpty?: boolean
  emptyLabel?: string
  disabled?: boolean
  testId?: string
  /** Кнопка справа от селекта (например, «+» создание сессии). */
  action?: ReactNode
  loading?: boolean
}

/**
 * AD-089: общий селект сущности (проект/сессия/агент): значение — `id`,
 * подпись — имя, под селектом моно-строкой показан выбранный ID.
 */
export function EntitySelect({
  label,
  tooltip,
  value,
  onChange,
  items,
  placeholder,
  includeEmpty,
  emptyLabel,
  disabled,
  testId,
  action,
  loading,
}: EntitySelectProps) {
  return (
    <SettingsField label={label} tooltip={tooltip}>
      <div className="flex items-center gap-2 min-w-0">
        <Select value={value} onValueChange={onChange} items={items}>
          <SelectTrigger
            className="flex-1 min-w-0"
            aria-label={label}
            disabled={disabled}
            data-testid={testId}
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {items.find((item) => item.value === value)?.label ||
                placeholder ||
                (includeEmpty && value === '' ? emptyLabel : undefined) ||
                value}
            </span>
            <Icon name="arrow-down-s" className="size-3.5 shrink-0 opacity-50" />
          </SelectTrigger>
          <SelectContent>
            {includeEmpty && <SelectItem value="">{emptyLabel}</SelectItem>}
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
            {loading && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{'…'}</div>
            )}
          </SelectContent>
        </Select>
        {action}
      </div>
      <div
        className="font-mono text-[0.65rem] text-muted-foreground break-all"
        data-testid={testId ? `${testId}-id` : undefined}
      >
        {value || '—'}
      </div>
    </SettingsField>
  )
}

export interface ProjectSelectProps {
  label: string
  tooltip?: string
  value: string
  onChange: (value: string) => void
  includeEmpty?: boolean
  emptyLabel?: string
  disabled?: boolean
  testId?: string
}

/** Селект проекта: загружает реестр проектов из стора. */
export function ProjectSelect({
  label,
  tooltip,
  value,
  onChange,
  includeEmpty,
  emptyLabel,
  disabled,
  testId,
}: ProjectSelectProps) {
  const projects = useProjectsStore((s) => s.projects)
  const loading = useProjectsStore((s) => s.loading)

  useEffect(() => {
    void useProjectsStore.getState().loadProjects()
  }, [])

  const items = projects.map((project: ProjectData) => ({
    value: project.id,
    label: project.name,
  }))

  return (
    <EntitySelect
      label={label}
      tooltip={tooltip}
      value={value}
      onChange={onChange}
      items={items}
      includeEmpty={includeEmpty}
      emptyLabel={emptyLabel}
      disabled={disabled}
      testId={testId}
      loading={loading}
    />
  )
}

export interface AgentSelectProps {
  label: string
  tooltip?: string
  value: string
  onChange: (value: string) => void
  includeEmpty?: boolean
  emptyLabel?: string
  disabled?: boolean
  testId?: string
}

/** Селект агента: включённые агенты, подпись — display_name, значение — id. */
export function AgentSelect({
  label,
  tooltip,
  value,
  onChange,
  includeEmpty,
  emptyLabel,
  disabled,
  testId,
}: AgentSelectProps) {
  const agents = useAgentsStore((s) => s.agents)
  const loading = useAgentsStore((s) => s.loading)

  useEffect(() => {
    void useAgentsStore.getState().loadAgents()
  }, [])

  const items = agents
    .filter((agent: AgentInfo) => agent.enabled || agent.id === value)
    .map((agent: AgentInfo) => ({
      value: agent.id,
      label: agent.display_name || agent.id,
    }))

  return (
    <EntitySelect
      label={label}
      tooltip={tooltip}
      value={value}
      onChange={onChange}
      items={items}
      includeEmpty={includeEmpty}
      emptyLabel={emptyLabel}
      disabled={disabled}
      testId={testId}
      loading={loading}
    />
  )
}

export interface SessionSelectProps {
  label: string
  tooltip?: string
  value: string
  onChange: (value: string) => void
  /** Сессии только выбранного проекта (пусто — все). */
  projectId?: string | null
  includeEmpty?: boolean
  emptyLabel?: string
  disabled?: boolean
  testId?: string
  /** Справа от селекта — «+», открывающий диалог создания сессии. */
  allowCreate?: boolean
}

/** Селект сессии: сессии проекта (или все), подпись — имя, значение — id. */
export function SessionSelect({
  label,
  tooltip,
  value,
  onChange,
  projectId,
  includeEmpty,
  emptyLabel,
  disabled,
  testId,
  allowCreate,
}: SessionSelectProps) {
  const { t } = useI18n()
  const [sessions, setSessions] = useState<SessionData[]>([])
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const list = await synthApi.getSessions(projectId || undefined)
        // Серверный фильтр по `project_id` не гарантирован (core отдаёт весь
        // список) — отбираем сессии проекта на клиенте.
        const scoped = projectId ? list.filter((session) => session.project_id === projectId) : list
        if (!cancelled) setSessions(scoped)
      } catch {
        if (!cancelled) setSessions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, reloadToken])

  const items = sessions.map((session) => ({
    value: session.id,
    label: session.name || session.id,
  }))

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  return (
    <>
      <EntitySelect
        label={label}
        tooltip={tooltip}
        value={value}
        onChange={onChange}
        items={items}
        includeEmpty={includeEmpty}
        emptyLabel={emptyLabel}
        disabled={disabled}
        testId={testId}
        loading={loading}
        action={
          allowCreate ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setCreateOpen(true)}
              title={t('leftPanel.newSession')}
              aria-label={t('leftPanel.newSession')}
              data-testid={testId ? `${testId}-create` : undefined}
            >
              <Icon name="add" className="size-3.5" />
            </Button>
          ) : undefined
        }
      />
      {allowCreate && (
        <SessionCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialProjectId={projectId ?? null}
          onCreated={(session) => {
            reload()
            onChange(session.id)
          }}
        />
      )}
    </>
  )
}
