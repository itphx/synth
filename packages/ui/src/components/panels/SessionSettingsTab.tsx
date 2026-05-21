import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useNotification } from '@/hooks/useNotification'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'

export function SessionSettingsTab() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const { sessions } = useSessionsStore()
  const {
    providers,
    models,
    selectedProviderName,
    selectedModelName,
    setSelectedProvider,
    setSelectedModel,
    loadProviders,
    loadModels,
  } = useProvidersStore()

  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [debugEnabled, setDebugEnabled] = useState(false)
  const [saving, setSaving] = useState(false)

  const activeTabId = useUIStore((s) => s.activeCenterTabId)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const activeTab = centerTabs.find((t) => t.id === activeTabId)
  const sessionId = activeTab?.data?.sessionId

  const session = sessions.find((s) => s.id === sessionId)

  useEffect(() => {
    loadProviders()
    loadModels()
  }, [])

  useEffect(() => {
    if (sessionId) {
      synthApi.getAgents(sessionId).then((r) => setAgents(r.agents)).catch(() => {})
    }
  }, [sessionId])

  useEffect(() => {
    if (session && !selectedProviderName && session.settings) {
      const sp = session.settings.provider as string | undefined
      const sm = session.settings.model as string | undefined
      if (sp) setSelectedProvider(sp)
      if (sm) setSelectedModel(sm)
    }
  }, [session])

  const handleSave = async () => {
    if (!sessionId) return
    if (session?.settings?.debug !== undefined) {
      setSaving(true)
      try {
        await synthApi.updateSession(sessionId, {
          settings: {
            ...(session.settings as Record<string, unknown>),
            provider: selectedProviderName,
            model: selectedModelName,
            debug: debugEnabled,
          },
        })
        notify({ text: t('sessionSettings.saved'), type: 'success', category: 'system', sessionId: sessionId || undefined })
      } catch {
        notify({ text: t('sessionSettings.saveError'), type: 'error', category: 'error', sessionId: sessionId || undefined })
      } finally {
        setSaving(false)
      }
    } else {
      notify({ text: 'Сессия не загружена', type: 'warning', category: 'error', sessionId: sessionId || undefined })
    }
  }

  if (!session) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('rightPanel.params.noSessions')}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <Section title={t('rightPanel.params.session')}>
          <Field label="ID" value={session.id.slice(0, 12) + '...'} mono />
          <Field label={t('rightPanel.params.project')} value={session.project_id || t('rightPanel.params.none')} />
          <Field label={t('rightPanel.params.engine')} value={session.engine} />
        </Section>

        <Section title={t('sessionSettings.provider')}>
          <select
            value={selectedProviderName || ''}
              onChange={(e) => {
                const name = e.target.value
                setSelectedProvider(name || null)
                if (name) {
                  const provider = providers.find((p) => p.name === name)
                  setSelectedModel(provider?.model || null)
                } else {
                  setSelectedModel(null)
                }
              }}
            className="w-full rounded border border-border bg-input px-2 py-1.5 text-xs text-foreground"
          >
            {providers.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </Section>

        <Section title={t('sessionSettings.model')}>
          <select
            value={selectedModelName || ''}
            onChange={(e) => setSelectedModel(e.target.value || null)}
            className="w-full rounded border border-border bg-input px-2 py-1.5 text-xs text-foreground"
          >
            <option value="">—</option>
            {models
              .filter((m) => (!selectedProviderName || m.provider === selectedProviderName) && m.enabled)
              .map((m) => (
                <option key={`${m.provider}:${m.name}`} value={m.name}>{m.name}</option>
              ))}
          </select>
        </Section>

        <Section title={t('sessionSettings.debug')}>
          <label className="flex items-center gap-3 cursor-pointer">
            <button
              role="switch"
              aria-checked={debugEnabled}
              onClick={() => setDebugEnabled(!debugEnabled)}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                debugEnabled ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  debugEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
            <span className="text-xs text-foreground">{debugEnabled ? t('sessionSettings.debugOn') : t('sessionSettings.debugOff')}</span>
          </label>
        </Section>

        {agents.length > 0 && (
          <Section title={t('rightPanel.params.agents')}>
            <div className="flex flex-col gap-1">
              {agents.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                  {a.display_name}
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? t('sessionSettings.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide mb-2">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-[11px]' : ''}>{value}</span>
    </div>
  )
}
