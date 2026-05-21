import { useEffect, useState } from 'react'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

const CAPABILITY_LABELS: Record<string, string> = {
  file_read: 'чтение', file_write: 'запись', file_search: 'поиск',
  git_read: 'git:чтение', git_write: 'git:запись',
  code_review: 'ревью', development: 'разработка', testing: 'тесты',
  deployment: 'деплой', infrastructure: 'инфра', monitoring: 'мониторинг',
  architecture: 'архитектура', mentoring: 'менторство',
  research: 'анализ', documentation: 'документы', planning: 'планирование',
  security_analysis: 'безопасность', shell_exec: 'shell',
}

export const AgentsPanel = () => {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState('')
  const [form, setForm] = useState({
    id: '', display_name: '', provider: '', model: '',
    temperature: 0.7, capabilities: [] as string[], mode: 'simple' as 'simple' | 'orchestrator',
  })
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const data = await synthApi.getAgents()
      setAgents(data.agents || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleCreate = () => {
    setEditId('')
    setForm({ id: '', display_name: '', provider: '', model: '', temperature: 0.7, capabilities: [], mode: 'simple' })
    setShowForm(true)
    setError('')
  }

  const handleEdit = async (a: AgentInfo) => {
    try {
      const detail = await synthApi.fetchJSON<Record<string, unknown>>(`/api/v2/agents/${encodeURIComponent(a.id)}`)
      setEditId(a.id)
      setForm({
        id: (detail.id as string) || a.id,
        display_name: (detail.displayName as string) || a.display_name,
        provider: (detail.provider as string) || '',
        model: (detail.model as string) || '',
        temperature: (detail.temperature as number) ?? 0.7,
        capabilities: (detail.capabilities as string[]) || a.capabilities,
        mode: ((detail.mode as string) || 'simple') as 'simple' | 'orchestrator',
      })
    } catch {
      setEditId(a.id)
      setForm({
        id: a.id, display_name: a.display_name || a.id, provider: '', model: '',
        temperature: 0.7, capabilities: a.capabilities, mode: 'simple',
      })
    }
    setShowForm(true)
    setError('')
  }

  const handleSave = async () => {
    if (!form.id.trim()) { setError('ID обязателен'); return }
    try {
      await synthApi.fetchJSON('/api/v2/agents', {
        method: 'POST',
        body: JSON.stringify({
          id: form.id.trim(),
          display_name: form.display_name,
          provider: form.provider || undefined,
          model: form.model || undefined,
          temperature: form.temperature,
          capabilities: form.capabilities,
          mode: form.mode,
        }),
      })
      setShowForm(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    }
  }

  const handleToggle = async (a: AgentInfo) => {
    try {
      await synthApi.fetchJSON(`/api/v2/agents/${encodeURIComponent(a.id)}/enabled`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !a.enabled }),
      })
      await load()
    } catch { /* ignore */ }
  }

  const handleDelete = async (id: string) => {
    if (!confirm(`Сбросить агента «${id}» к настройкам по умолчанию?`)) return
    try {
      await synthApi.fetchJSON(`/api/v2/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await load()
    } catch { /* ignore */ }
  }

  const toggleCap = (cap: string) => {
    setForm(f => ({
      ...f,
      capabilities: f.capabilities.includes(cap)
        ? f.capabilities.filter(c => c !== cap)
        : [...f.capabilities, cap],
    }))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Агенты</h3>
          <p className="text-muted-foreground text-sm">{agents.length} агентов</p>
        </div>
        <button onClick={handleCreate} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">
          <Icon name="add" className="size-3.5" />Добавить
        </button>
      </div>

      {showForm && (
        <div className="bg-background rounded-lg border p-4 space-y-3 max-w-lg">
          <h4 className="font-medium text-sm">{editId ? `Изменить: ${editId}` : 'Новый агент'}</h4>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-muted-foreground">ID</label>
              <input type="text" value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} disabled={!!editId}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Отображаемое имя</label>
              <input type="text" value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground">Провайдер</label>
                <input type="text" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}
                  className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Модель</label>
                <input type="text" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}
                  className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Режим</label>
              <select value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value as 'simple' | 'orchestrator' })}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                <option value="simple">Simple</option>
                <option value="orchestrator">Orchestrator</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Возможности</label>
              <div className="flex flex-wrap gap-1">
                {Object.entries(CAPABILITY_LABELS).map(([k, v]) => (
                  <button key={k} onClick={() => toggleCap(k)} className={cn(
                    "px-2 py-0.5 rounded text-[11px] transition-colors",
                    form.capabilities.includes(k)
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                      : "bg-muted text-muted-foreground hover:bg-interactive-hover"
                  )}>{v}</button>
                ))}
              </div>
            </div>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button onClick={handleSave} className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">Сохранить</button>
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover">Отмена</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-2 gap-3">{[1,2,3,4].map(i => <div key={i} className="bg-background rounded-lg border p-4 animate-pulse"><div className="h-4 bg-muted rounded w-24" /></div>)}</div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {agents.map((a) => (
            <div key={a.id} className="bg-background rounded-lg border p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Icon name={a.icon || 'robot-2'} className="size-4 text-muted-foreground" />
                  <span className="font-medium text-sm">{a.display_name}</span>
                  <code className="text-[10px] text-muted-foreground">{a.id}</code>
                </div>
                <button onClick={() => handleToggle(a)} className={cn(
                  "relative w-9 h-5 rounded-full transition-colors",
                  a.enabled ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600'
                )}>
                  <span className={cn(
                    "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
                    a.enabled ? 'translate-x-4' : 'translate-x-0.5'
                  )} />
                </button>
              </div>
              <div className="flex flex-wrap gap-1 mb-2">
                {a.capabilities.slice(0, 6).map(c => (
                  <span key={c} className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                    {CAPABILITY_LABELS[c] || c}
                  </span>
                ))}
                {a.capabilities.length > 6 && (
                  <span className="text-[10px] text-muted-foreground">+{a.capabilities.length - 6}</span>
                )}
              </div>
              <div className="flex gap-1">
                <button onClick={() => handleEdit(a)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-interactive-hover">Изменить</button>
                <button onClick={() => handleDelete(a.id)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950">Сбросить</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
