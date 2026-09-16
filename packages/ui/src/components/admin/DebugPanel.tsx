import { useEffect, useState } from 'react'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface DebugConfig {
  groups: Record<string, string>
  available_levels: string[]
}

const LEVEL_COLORS: Record<string, string> = {
  NONE: 'bg-secondary text-muted-foreground',
  DEBUG: 'bg-status-info/10 text-status-info',
  INFO: 'bg-status-success/10 text-status-success',
  WARNING: 'bg-status-warning/15 text-status-warning',
  ERROR: 'bg-status-error/10 text-status-error',
}

export const DebugPanel = () => {
  const { t } = useI18n()
  const [config, setConfig] = useState<DebugConfig | null>(null)
  const [levels, setLevels] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    const load = async () => {
      try {
        const data = await synthApi.fetchJSON<DebugConfig>('/api/v2/admin/debug/config')
        setConfig(data)
        setLevels({ ...data.groups })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const handleLevelChange = (group: string, level: string) => {
    setLevels((prev) => ({ ...prev, [group]: level }))
  }

  const handleSave = async () => {
    setSaving(true)
    setStatus('')
    try {
      await synthApi.fetchJSON('/api/v2/admin/debug/config', {
        method: 'POST',
        body: JSON.stringify({ groups: levels }),
      })
      setStatus(t('admin.debug.saved'))
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t('admin.debug.saveError'))
    } finally {
      setSaving(false)
    }
  }

  const grouped = config?.groups
    ? Object.entries(config.groups).reduce(
        (acc, [key, value]) => {
          const category = key === 'DEBUG' || key === 'ROUTES' || key === 'STORAGE' || key === 'WEBSOCKET' ? t('admin.debug.service') : t('admin.debug.ai')
          if (!acc[category]) acc[category] = []
          acc[category].push({ group: key, level: value })
          return acc
        },
        {} as Record<string, Array<{ group: string; level: string }>>
      )
    : {}

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h3 className="text-lg font-semibold">{t('admin.debug.title')}</h3>
        <p className="text-muted-foreground text-sm mt-1">
          {t('admin.debug.description')}
        </p>
      </div>

      {loading ? (
        <div className="bg-background rounded-xl border p-5 animate-pulse space-y-3">
          <div className="h-4 bg-muted rounded w-48" />
          <div className="h-4 bg-muted rounded w-32" />
        </div>
      ) : (
        <>
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category} className="bg-background rounded-xl border p-5 space-y-4">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{category}</h4>

              {items.map(({ group, level: defaultLevel }) => (
                <div key={group} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium">{group}</span>
                    <span className={cn('px-2 py-0.5 rounded text-[0.6875rem] font-medium', LEVEL_COLORS[levels[group] ?? defaultLevel] || 'bg-secondary text-muted-foreground')}>
                      {levels[group] ?? defaultLevel}
                    </span>
                  </div>
                  <Select value={levels[group] ?? defaultLevel} onValueChange={(value) => handleLevelChange(group, value)}>
                    <SelectTrigger aria-label={group}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(config?.available_levels || ['NONE', 'DEBUG', 'INFO', 'WARNING', 'ERROR']).map((lvl) => (
                        <SelectItem key={lvl} value={lvl}>{lvl}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          ))}

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? (
                <>
                  <Icon name="refresh-cw" className="w-4 h-4 animate-spin" /> {t('admin.debug.saving')}
                </>
              ) : (
                <>
                  <Icon name="save" className="w-4 h-4" /> {t('admin.debug.save')}
                </>
              )}
            </button>
            {status && (
              <span className={cn('text-sm', status === t('admin.debug.saved') ? 'text-status-success' : 'text-status-error')}>
                {status}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
