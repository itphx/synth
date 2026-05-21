import { useEffect, useState } from 'react'
import { synthApi, type ProviderInfo } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
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
    if (!form.name.trim()) { setError('Название обязательно'); return }
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
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    }
  }

  const handleDelete = async (name: string) => {
    if (!confirm(`Удалить провайдера «${name}»?`)) return
    try {
      await synthApi.fetchJSON(`/api/v2/providers/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await load()
    } catch {
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Провайдеры</h3>
          <p className="text-muted-foreground text-sm">{providers.length} провайдеров</p>
        </div>
        <button onClick={handleCreate} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">
          <Icon name="add" className="size-3.5" />Добавить
        </button>
      </div>

      {showForm && (
        <div className="bg-background rounded-lg border p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-sm">{editName ? 'Изменить' : 'Новый'} провайдер</h4>
            <div className="flex gap-2">
              <button onClick={handleSave} className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">Сохранить</button>
              <button onClick={() => setShowForm(false)} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover">Отмена</button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Название</label>
              <input
                type="text" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                disabled={!!editName}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Тип API</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground">URL</label>
              <input
                type="text" value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">API Key</label>
              <input
                type="password" value={form.api_key}
                onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                placeholder={editName ? '(не изменять)' : 'sk-...'}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Модель по умолчанию</label>
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
            <span className="text-sm">Провайдер включён</span>
          </label>

          {/* Иконка */}
          <div className="border-t border-border pt-3">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-muted-foreground">Иконка</label>
              <div className="flex items-center gap-2">
                <ProviderIcon icon={form.icon} baseUrl={form.base_url} size={20} />
                {form.icon && (
                  <button onClick={resetIcon} className="text-[11px] text-muted-foreground hover:text-red-500">
                    Сбросить
                  </button>
                )}
              </div>
            </div>

            <IconPickerSection title="Авто-определение (favicon)">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleFetchIcon}
                  disabled={fetchingIcon || !form.base_url}
                  className="px-3 py-1 rounded-md text-xs bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {fetchingIcon ? 'Поиск...' : 'Определить'}
                </button>
                {fetchedIcon?.icon && (
                  <>
                    <img src={fetchedIcon.icon} width={20} height={20} className="rounded" alt="" />
                    <span className="text-xs text-emerald-600 dark:text-emerald-400">Найден</span>
                    <button onClick={applyFetchedIcon} className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 hover:bg-emerald-200">
                      Использовать
                    </button>
                  </>
                )}
                {fetchedIcon?.error && (
                  <span className="text-xs text-red-500">{fetchedIcon.error}</span>
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
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                        : 'border-border hover:bg-interactive-hover',
                    )}
                  >
                    <Icon name={riName} className="size-4" />
                  </button>
                ))}
              </div>
            </IconPickerSection>

            <IconPickerSection title="Брендовые">
              <div className="flex flex-wrap gap-1">
                {PROVIDER_BRAND_NAMES.map((brand) => (
                  <button
                    key={brand}
                    onClick={() => setForm({ ...form, icon: `brand:${brand}` })}
                    title={brand}
                    className={cn(
                      'p-1.5 rounded-md border',
                      form.icon === `brand:${brand}`
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                        : 'border-border hover:bg-interactive-hover',
                    )}
                  >
                    <img src={`/assets/providers/${brand}.svg`} width={16} height={16} alt={brand} />
                  </button>
                ))}
              </div>
            </IconPickerSection>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button onClick={handleSave} className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">Сохранить</button>
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover">Отмена</button>
          </div>
        </div>
      )}

      {testResult && (
        <div className={cn(
          "rounded-lg border p-4 text-sm",
          testResult.status === 'testing' ? 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-950 dark:border-blue-800 dark:text-blue-300' :
          testResult.status === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-300' :
          testResult.status === 'disabled' ? 'bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-950 dark:border-slate-800 dark:text-slate-400' :
          'bg-red-50 border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300'
        )}>
          <div className="flex items-center justify-between">
            <span className="font-medium">{testResult.id}</span>
            <button onClick={() => setTestResult(null)} className="text-current opacity-50 hover:opacity-100"><Icon name="close" className="size-4" /></button>
          </div>
          {testResult.status === 'testing' && <p className="mt-1">Тестирование...</p>}
          {testResult.status === 'ok' && (
            <div className="mt-1">
              <p>Подключение успешно</p>
              {testResult.models && <p className="text-xs mt-1">Модели: {testResult.models.slice(0, 10).join(', ')}{testResult.models.length > 10 ? ` + ещё ${testResult.models.length - 10}` : ''}</p>}
            </div>
          )}
          {testResult.status === 'disabled' && <p className="mt-1">Провайдер отключён</p>}
          {testResult.status === 'error' && <p className="mt-1">{testResult.error}</p>}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">{[1,2].map(i => <div key={i} className="bg-background rounded-lg border p-4 animate-pulse"><div className="h-4 bg-muted rounded w-48" /></div>)}</div>
      ) : providers.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground">Нет провайдеров</div>
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
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">{p.type}</span>
                      {p.is_default && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">default</span>}
                      {p.enabled === false && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">выкл</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 truncate max-w-md">{p.url}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => handleTest(p.name)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-interactive-hover">Тест</button>
                  <button onClick={() => handleEdit(p)} className="p-1 rounded text-muted-foreground hover:bg-interactive-hover"><Icon name="edit-2" className="size-3.5" /></button>
                  <button onClick={() => handleDelete(p.name)} className="p-1 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"><Icon name="delete-bin" className="size-3.5" /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
