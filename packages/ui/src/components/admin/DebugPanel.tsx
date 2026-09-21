import { useEffect, useState } from 'react'
import { synthApi } from '@/lib/api/synthApi'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsActions, SettingsPanel, SettingsSection } from '../ui/settings'

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
    <SettingsPanel title={t('admin.debug.title')} description={t('admin.debug.description')}>
      {loading ? (
        <div className="bg-background rounded-xl border p-5 animate-pulse space-y-3">
          <div className="h-4 bg-muted rounded w-48" />
          <div className="h-4 bg-muted rounded w-32" />
        </div>
      ) : (
        <>
          {Object.entries(grouped).map(([category, items]) => (
            <SettingsSection key={category} title={category}>
              {items.map(({ group, level: defaultLevel }) => (
                <div key={group} className="flex flex-wrap items-center justify-between gap-3 min-w-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-medium min-w-0 break-words">{group}</span>
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
            </SettingsSection>
          ))}

          <SettingsActions onSave={handleSave} saving={saving} saveTestId="debug-save" />
          {status && (
            <span className={cn('text-sm', status === t('admin.debug.saved') ? 'text-status-success' : 'text-status-error')}>
              {status}
            </span>
          )}
        </>
      )}
    </SettingsPanel>
  )
}
