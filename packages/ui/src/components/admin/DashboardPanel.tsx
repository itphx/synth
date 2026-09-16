import { useEffect, useState } from 'react'
import { SYNTH_VERSION } from '@itphx/synth-shared/version'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

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
    <div className="space-y-6">
      <h3 className="text-lg font-semibold">{t('admin.dashboard.title')}</h3>
      <p className="text-muted-foreground text-sm">{t('admin.dashboard.subtitle')}</p>

      {loading ? (
        <div className="grid grid-cols-2 gap-4">
          {cards.map((c) => (
            <div key={c.label} className="bg-background rounded-xl border p-5 animate-pulse">
              <div className="h-4 bg-muted rounded w-24 mb-3" />
              <div className="h-8 bg-muted rounded w-16" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {cards.map((c) => (
            <div key={c.label} className="bg-background rounded-xl border p-5">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
                <Icon name={c.icon} className={cn("size-4", c.color)} />
                {c.label}
              </div>
              <div className={cn("text-2xl font-bold", c.color)}>
                {typeof c.value === 'number' ? c.value.toLocaleString() : c.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
