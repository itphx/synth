import { useEffect, useState } from 'react'
import { SYNTH_VERSION } from '@itphx/synth-shared/version'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { SettingsPanel, SettingsSection } from '../ui/settings'

interface Stats {
  totalSessions: number
  totalProjects: number
  totalUsers: number
}

export const DashboardPanel = () => {
  const { t } = useI18n()
  const [stats, setStats] = useState<Stats>({ totalSessions: 0, totalProjects: 0, totalUsers: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const [sessions, projects, users] = await Promise.all([
          synthApi.getSessions().catch(() => []),
          synthApi.getProjects().catch(() => []),
          synthApi.getUsers().then((d) => d.users || []).catch(() => []),
        ])
        setStats({
          totalSessions: sessions.length,
          totalProjects: projects.length,
          totalUsers: users.length,
        })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const cards = [
    { label: t('admin.dashboard.totalSessions'), value: stats.totalSessions, icon: 'chat-new', color: 'text-status-info' },
    { label: t('admin.dashboard.projects'), value: stats.totalProjects, icon: 'briefcase', color: 'text-status-success' },
    { label: t('admin.dashboard.users'), value: stats.totalUsers, icon: 'user-smile', color: 'text-primary' },
    { label: t('admin.dashboard.version'), value: SYNTH_VERSION, icon: 'rocket', color: 'text-status-warning' },
  ]

  return (
    <SettingsPanel title={t('admin.dashboard.title')} description={t('admin.dashboard.subtitle')}>
      <SettingsSection>
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {cards.map((c) => (
              <div key={c.label} className="min-w-0 bg-surface-inset rounded-xl border p-5 animate-pulse">
                <div className="h-4 bg-muted rounded w-24 mb-3" />
                <div className="h-8 bg-muted rounded w-16" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {cards.map((c) => (
              <div key={c.label} className="min-w-0 bg-surface-inset rounded-xl border p-5">
                <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2 min-w-0">
                  <Icon name={c.icon} className={cn('size-4 shrink-0', c.color)} />
                  <span className="min-w-0 break-words">{c.label}</span>
                </div>
                <div className={cn('text-2xl font-bold min-w-0 break-words', c.color)}>
                  {typeof c.value === 'number' ? c.value.toLocaleString() : c.value}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}
