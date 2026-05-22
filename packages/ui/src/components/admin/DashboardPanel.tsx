import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { synthApi } from '@/lib/api/synthApi'
import { api } from '@/lib/api/client'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

interface Stats {
  totalSessions: number
  totalProjects: number
  totalUsers: number
  version: string
}

export const DashboardPanel = () => {
  const { t } = useI18n()
  const [stats, setStats] = useState<Stats>({ totalSessions: 0, totalProjects: 0, totalUsers: 0, version: '0.1.0' })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const [sessions, projects, users] = await Promise.all([
          synthApi.getSessions().catch(() => []),
          synthApi.getProjects().catch(() => []),
          api.getUsers().then((d) => d.users || []).catch(() => []),
        ])
        setStats({
          totalSessions: sessions.length,
          totalProjects: projects.length,
          totalUsers: users.length,
          version: '0.1.0',
        })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const cards = [
    { label: t('admin.dashboard.totalSessions'), value: stats.totalSessions, icon: 'chat-new', color: 'text-blue-600 dark:text-blue-400' },
    { label: t('admin.dashboard.projects'), value: stats.totalProjects, icon: 'briefcase', color: 'text-emerald-600 dark:text-emerald-400' },
    { label: t('admin.dashboard.users'), value: stats.totalUsers, icon: 'user-smile', color: 'text-purple-600 dark:text-purple-400' },
    { label: t('admin.dashboard.version'), value: stats.version, icon: 'rocket', color: 'text-amber-600 dark:text-amber-400' },
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
