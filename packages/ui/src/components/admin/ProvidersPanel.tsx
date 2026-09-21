import { useEffect, useState } from 'react'
import { synthApi, type ProviderInfo } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import { SelectContent, SelectItem } from '@/components/ui/select'
import { Button } from '../ui/button'
import {
  SettingsActions,
  SettingsField,
  SettingsPanel,
  SettingsSection,
  SelectField,
  TextField,
  ToggleField,
} from '../ui/settings'
import { ProviderIcon, PROVIDER_RI_ICONS, PROVIDER_BRAND_NAMES } from './ProviderIcon'

interface FetchIconResult {
  icon?: string | null
  error?: string
  source?: string
}

const IconPickerSection = ({ title, children }: { title: string; children: React.ReactNode }) => {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3" />
        {title}
      </button>
      {open && <div className="mt-1.5 min-w-0">{children}</div>}
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
    if (!(await confirm({ title: t('admin.providers.confirmDelete', { name }), variant: 'danger' }))) return
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
    <SettingsPanel
      title={t('admin.providers.title')}
      description={t('admin.providers.count', { count: providers.length })}
      actions={
        <Button onClick={handleCreate}>
          <Icon name="add" className="size-3.5" />{t('admin.providers.add')}
        </Button>
      }
    >
      {showForm && (
        <SettingsSection title={editName ? t('admin.providers.edit') : t('admin.providers.new')}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TextField
              label={t('admin.providers.name')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              disabled={!!editName}
            />
            <SelectField
              label={t('admin.providers.type')}
              value={form.type}
              onValueChange={(value) => setForm({ ...form, type: value })}
              ariaLabel={t('admin.providers.type')}
            >
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="ollama">Ollama</SelectItem>
              </SelectContent>
            </SelectField>
            <div className="sm:col-span-2">
              <TextField
                label={t('admin.providers.url')}
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <TextField
              id="admin-provider-api-key"
              name="providerApiKey"
              label={t('admin.providers.apiKey')}
              type="password"
              value={form.api_key}
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
            />
            <TextField
              label={t('admin.providers.defaultModel')}
              value={form.default_model}
              onChange={(e) => setForm({ ...form, default_model: e.target.value })}
            />
          </div>

          <ToggleField
            label={t('admin.providers.enabled')}
            enabled={form.enabled}
            onToggle={() => setForm({ ...form, enabled: !form.enabled })}
          />

          {/* Иконка */}
          <SettingsField label={t('admin.providers.icon')}>
            <div className="border-t border-border pt-3 space-y-2 min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <ProviderIcon icon={form.icon} baseUrl={form.base_url} size={20} />
                  <span className="text-xs text-muted-foreground min-w-0 break-all">{form.icon || t('admin.providers.notSelected')}</span>
                </div>
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

              <IconPickerSection title={t('admin.providers.autoDetectFavicon')}>
                <div className="flex flex-wrap items-center gap-2 min-w-0">
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
                    <span className="text-xs text-status-error min-w-0 break-words">{fetchedIcon.error}</span>
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
          </SettingsField>

          {error && <p className="text-xs text-status-error min-w-0 break-words">{error}</p>}
          <SettingsActions
            onSave={handleSave}
            onCancel={() => setShowForm(false)}
            saveLabel={t('admin.providers.save')}
            cancelLabel={t('admin.providers.cancel')}
            saveTestId="provider-save"
            cancelTestId="provider-cancel"
          />
        </SettingsSection>
      )}

      {testResult && (
        <div className={cn(
          'rounded-lg border p-4 text-sm min-w-0 break-words',
          testResult.status === 'testing' ? 'bg-status-info/10 border-status-info/30 text-status-info' :
          testResult.status === 'ok' ? 'bg-status-success/10 border-status-success/30 text-status-success' :
          testResult.status === 'disabled' ? 'bg-muted border-border text-muted-foreground' :
          'bg-status-error/10 border-status-error/30 text-status-error'
        )}>
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="font-medium min-w-0 break-words">{testResult.id}</span>
            <button onClick={() => setTestResult(null)} className="shrink-0 text-current opacity-50 hover:opacity-100" aria-label={t('common.close')}><Icon name="close" className="size-4" /></button>
          </div>
          {testResult.status === 'testing' && <p className="mt-1">{t('admin.providers.testing')}</p>}
          {testResult.status === 'ok' && (
            <div className="mt-1">
              <p>{t('admin.providers.connectedSuccess')}</p>
              {testResult.models && (() => {
                const modelsPart = testResult.models.slice(0, 10).join(', ') + (testResult.models.length > 10 ? t('admin.providers.moreModels', { count: testResult.models.length - 10 }) : '')
                return <p className="text-xs mt-1 min-w-0 break-words">{t('admin.providers.modelsList', { list: modelsPart })}</p>
              })()}
            </div>
          )}
          {testResult.status === 'disabled' && <p className="mt-1">{t('admin.providers.providerDisabled')}</p>}
          {testResult.status === 'error' && <p className="mt-1 min-w-0 break-words">{testResult.error}</p>}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">{[1,2].map(i => <div key={i} className="bg-background rounded-lg border p-4 animate-pulse"><div className="h-4 bg-muted rounded w-48" /></div>)}</div>
      ) : providers.length === 0 ? (
        <SettingsSection>
          <p className="py-4 text-center text-muted-foreground">{t('admin.providers.noProviders')}</p>
        </SettingsSection>
      ) : (
        <div className="space-y-2">
          {providers.map((p) => (
            <SettingsSection key={p.name} className={cn(p.enabled === false && 'opacity-50')}>
              <div className="flex flex-wrap items-center justify-between gap-3 min-w-0">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <ProviderIcon icon={p.icon} baseUrl={p.url} size={22} title={p.name} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="font-medium text-sm min-w-0 break-words">{p.name}</span>
                      <span className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-secondary text-secondary-foreground">{p.type}</span>
                      {p.is_default && <span className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-status-success/10 text-status-success">{t('admin.providers.default_2')}</span>}
                      {p.enabled === false && (
                        <span className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-secondary text-muted-foreground">{t('admin.providers.off')}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 truncate max-w-md">{p.url}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1 shrink-0">
                  <Button variant="ghost" onClick={() => handleTest(p.name)}>{t('admin.providers.test')}</Button>
                  <Button variant="ghost" onClick={() => handleEdit(p)} className="p-1" aria-label={t('admin.providers.edit')}><Icon name="edit-2" className="size-3.5" /></Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleDelete(p.name)}
                    className="p-1 hover:bg-status-error/10 hover:text-status-error"
                    aria-label={t('common.delete')}
                  >
                    <Icon name="delete-bin" className="size-3.5" />
                  </Button>
                </div>
              </div>
            </SettingsSection>
          ))}
        </div>
      )}
    </SettingsPanel>
  )
}
