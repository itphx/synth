import { useEffect, useState } from 'react'
import { synthApi, type ProviderInfo } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '../ui/button'
import { ProviderIcon, PROVIDER_RI_ICONS, PROVIDER_BRAND_NAMES } from './ProviderIcon'

interface FetchIconResult {
  icon?: string | null
  error?: string
  source?: string
}

const IconPickerSection = ({ title, children }: { title: string; children: React.ReactNode }) => {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3" />
        {title}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  )
}

export const ProvidersPanel = () => {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editName, setEditName] = useState('')
  const [form, setForm] = useState({
    name: '', type: 'generic', base_url: '', api_key: '', default_model: '', timeout: 120,
    enabled: true, icon: '',
  })
  const [error, setError] = useState('')
  const [fetchingIcon, setFetchingIcon] = useState(false)
  const [fetchedIcon, setFetchedIcon] = useState<FetchIconResult | null>(null)
  const [testResult, setTestResult] = useState<{ id?: string; status?: string; error?: string; models?: string[] } | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const data = await synthApi.getProviders()
      setProviders(data.providers || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const resetForm = (p?: ProviderInfo) => {
    if (p) {
      setEditName(p.name)
      setForm({ name: p.name, type: p.type, base_url: p.url, api_key: '', default_model: p.model, timeout: 120, enabled: p.enabled !== false, icon: p.icon || '' })
    } else {
      setEditName('')
      setForm({ name: '', type: 'openai', base_url: '', api_key: '', default_model: '', timeout: 120, enabled: true, icon: '' })
    }
    setShowForm(true)
    setError('')
    setFetchedIcon(null)
  }

  const handleCreate = () => resetForm()
  const handleEdit = (p: ProviderInfo) => resetForm(p)

  const handleSave = async () => {
    if (!form.name.trim()) { setError(t('common.nameRequired')); return }
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        type: form.type,
        base_url: form.base_url,
        api_key: form.api_key || undefined,
        default_model: form.default_model,
        timeout: form.timeout,
        enabled: form.enabled,
        icon: form.icon,
      }
      await synthApi.fetchJSON('/api/v2/providers', { method: 'POST', body: JSON.stringify(body) })
      setShowForm(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.saveError'))
    }
  }

  const handleDelete = async (name: string) => {
    if (!confirm(t('admin.providers.confirmDelete', { name }))) return
    try {
      await synthApi.fetchJSON(`/api/v2/providers/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await load()
    } catch {
      // ignore
    }
  }

  const handleTest = async (name: string) => {
    setTestResult({ id: name, status: 'testing' })
    try {
      const data = await synthApi.fetchJSON<{ status: string; error?: string; models?: string[]; message?: string }>(
        `/api/v2/providers/${encodeURIComponent(name)}/test`,
        { method: 'POST' },
      )
      setTestResult(data)
    } catch (err) {
      setTestResult({ status: 'error', error: err instanceof Error ? err.message : 'Ошибка' })
    }
  }

  const handleFetchIcon = async () => {
    if (!form.base_url) return
    setFetchingIcon(true)
    setFetchedIcon(null)
    try {
      const data = await synthApi.fetchJSON<FetchIconResult>('/api/v2/providers/fetch-icon', {
        method: 'POST',
        body: JSON.stringify({ url: form.base_url }),
      })
      setFetchedIcon(data)
    } catch (err) {
      setFetchedIcon({ error: err instanceof Error ? err.message : 'Ошибка' })
    } finally {
      setFetchingIcon(false)
    }
  }

  const applyFetchedIcon = () => {
    if (fetchedIcon?.icon) {
      setForm({ ...form, icon: fetchedIcon.icon })
      setFetchedIcon(null)
    }
  }

  const resetIcon = () => {
    setForm({ ...form, icon: '' })
    setFetchedIcon(null)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t('admin.providers.title')}</h3>
          <p className="text-muted-foreground text-sm">{t('admin.providers.count', { count: providers.length })}</p>
        </div>
        <Button onClick={handleCreate}>
          <Icon name="add" className="size-3.5" />{t('admin.providers.add')}
        </Button>
      </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 overscroll-behavior-contain mt-4">
      {showForm && (
        <div className="bg-background rounded-lg border p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-sm">{editName ? t('admin.providers.edit') : t('admin.providers.new')}</h4>
            <div className="flex gap-2">
              <Button onClick={handleSave}>{t('admin.providers.save')}</Button>
              <Button variant="ghost" onClick={() => setShowForm(false)}>{t('admin.providers.cancel')}</Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">{t('admin.providers.name')}</label>
              <input
                type="text" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                disabled={!!editName}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{t('admin.providers.type')}</label>
              <Select value={form.type} onValueChange={(value) => setForm({ ...form, type: value })}>
                <SelectTrigger className="w-full" aria-label={t('admin.providers.type')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="ollama">Ollama</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground">{t('admin.providers.url')}</label>
              <input
                type="text" value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label htmlFor="admin-provider-api-key" className="text-xs text-muted-foreground">{t('admin.providers.apiKey')}</label>
              <input
                id="admin-provider-api-key"
                name="providerApiKey"
                type="password" value={form.api_key}
                onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                placeholder={editName ? t('admin.providers.notChange') : 'sk-...'}
                autoComplete="off"
                data-1p-ignore=""
                data-lpignore="true"
                data-bwignore=""
                data-form-type="other"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{t('admin.providers.defaultModel')}</label>
              <input
                type="text" value={form.default_model}
                onChange={(e) => setForm({ ...form, default_model: e.target.value })}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox" checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="rounded"
            />
            <span className="text-sm">{t('admin.providers.enabled')}</span>
          </label>

          {/* Иконка */}
          <div className="border-t border-border pt-3">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-muted-foreground">{t('admin.providers.icon')}</label>
              <div className="flex items-center gap-2">
                <ProviderIcon icon={form.icon} baseUrl={form.base_url} size={20} />
                {form.icon && (
                    <Button
                      variant="ghost"
                      onClick={resetIcon}
                      className="text-muted-foreground hover:bg-status-error/10 hover:text-status-error"
                    >
                      {t('admin.providers.reset')}
                    </Button>
                )}
              </div>
            </div>

            <IconPickerSection title={t('admin.providers.autoDetectFavicon')}>
              <div className="flex items-center gap-2">
                <Button
                  onClick={handleFetchIcon}
                  disabled={fetchingIcon || !form.base_url}
                >
                  {fetchingIcon ? t('admin.providers.searchIcon') : t('admin.providers.detect')}
                </Button>
                {fetchedIcon?.icon && (
                  <>
                    <img src={fetchedIcon.icon} width={20} height={20} className="rounded" alt="" />
                    <span className="text-xs text-status-success">{t('admin.providers.found')}</span>
                    <button onClick={applyFetchedIcon} className="px-2 py-0.5 rounded text-xs bg-status-success/10 text-status-success hover:bg-status-success/20">
                      {t('admin.providers.use')}
                    </button>
                  </>
                )}
                {fetchedIcon?.error && (
                  <span className="text-xs text-status-error">{fetchedIcon.error}</span>
                )}
              </div>
            </IconPickerSection>

            <IconPickerSection title="Remixicon">
              <div className="flex flex-wrap gap-1">
                {PROVIDER_RI_ICONS.map((riName) => (
                  <button
                    key={riName}
                    onClick={() => setForm({ ...form, icon: `ri:${riName}` })}
                    title={riName}
                    className={cn(
                      'p-1.5 rounded-md border',
                      form.icon === `ri:${riName}`
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:bg-interactive-hover',
                    )}
                  >
                    <Icon name={riName} className="size-4" />
                  </button>
                ))}
              </div>
            </IconPickerSection>

            <IconPickerSection title={t('admin.providers.brand')}>
              <div className="flex flex-wrap gap-1">
                {PROVIDER_BRAND_NAMES.map((brand) => (
                  <button
                    key={brand}
                    onClick={() => setForm({ ...form, icon: `brand:${brand}` })}
                    title={brand}
                    className={cn(
                      'p-1.5 rounded-md border',
                      form.icon === `brand:${brand}`
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:bg-interactive-hover',
                    )}
                  >
                    <img src={`/assets/providers/${brand}.svg`} width={16} height={16} alt={brand} />
                  </button>
                ))}
              </div>
            </IconPickerSection>
          </div>

          {error && <p className="text-xs text-status-error">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={handleSave}>{t('admin.providers.save')}</Button>
            <Button variant="ghost" onClick={() => setShowForm(false)}>{t('admin.providers.cancel')}</Button>
          </div>
        </div>
      )}

      {testResult && (
        <div className={cn(
          "rounded-lg border p-4 text-sm",
          testResult.status === 'testing' ? 'bg-status-info/10 border-status-info/30 text-status-info' :
          testResult.status === 'ok' ? 'bg-status-success/10 border-status-success/30 text-status-success' :
          testResult.status === 'disabled' ? 'bg-muted border-border text-muted-foreground' :
          'bg-status-error/10 border-status-error/30 text-status-error'
        )}>
          <div className="flex items-center justify-between">
            <span className="font-medium">{testResult.id}</span>
            <button onClick={() => setTestResult(null)} className="text-current opacity-50 hover:opacity-100"><Icon name="close" className="size-4" /></button>
          </div>
          {testResult.status === 'testing' && <p className="mt-1">{t('admin.providers.testing')}</p>}
          {testResult.status === 'ok' && (
            <div className="mt-1">
              <p>{t('admin.providers.connectedSuccess')}</p>
              {testResult.models && (() => {
                const modelsPart = testResult.models.slice(0, 10).join(', ') + (testResult.models.length > 10 ? t('admin.providers.moreModels', { count: testResult.models.length - 10 }) : '')
                return <p className="text-xs mt-1">{t('admin.providers.modelsList', { list: modelsPart })}</p>
              })()}
            </div>
          )}
          {testResult.status === 'disabled' && <p className="mt-1">{t('admin.providers.providerDisabled')}</p>}
          {testResult.status === 'error' && <p className="mt-1">{testResult.error}</p>}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">{[1,2].map(i => <div key={i} className="bg-background rounded-lg border p-4 animate-pulse"><div className="h-4 bg-muted rounded w-48" /></div>)}</div>
      ) : providers.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground">{t('admin.providers.noProviders')}</div>
      ) : (
        <div className="space-y-2">
          {providers.map((p) => (
            <div key={p.name} className={cn('bg-background rounded-lg border p-4', p.enabled === false && 'opacity-50')}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <ProviderIcon icon={p.icon} baseUrl={p.url} size={22} title={p.name} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{p.name}</span>
                      <span className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-secondary text-secondary-foreground">{p.type}</span>
                      {p.is_default && <span className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-status-success/10 text-status-success">{t('admin.providers.default_2')}</span>}
                      {p.enabled === false && (
                        <span className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-secondary text-muted-foreground">{t('admin.providers.off')}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 truncate max-w-md">{p.url}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" onClick={() => handleTest(p.name)}>{t('admin.providers.test')}</Button>
                  <Button variant="ghost" onClick={() => handleEdit(p)} className="p-1"><Icon name="edit-2" className="size-3.5" /></Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleDelete(p.name)}
                    className="p-1 hover:bg-status-error/10 hover:text-status-error"
                  >
                    <Icon name="delete-bin" className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  )
}
