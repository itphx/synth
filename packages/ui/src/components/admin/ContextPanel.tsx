import { useEffect, useState } from 'react'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

interface ContextFileItem {
  name: string
  category: string
  is_system: boolean
  is_overridden: boolean
  enabled: boolean
  size: number
}

interface EditFileState {
  name: string
  content: string
  category: string
}

const CATEGORIES = [
  { id: 'user' },
  { id: 'role' },
  { id: 'system' },
  { id: 'tsm' },
] as const

const CATEGORY_LABEL_KEYS: Record<string, string> = {
  user: 'admin.context.userFiles',
  role: 'admin.context.rolesFiles',
  system: 'admin.context.systemFiles',
  tsm: 'admin.context.tsmFiles',
}

export const ContextPanel = () => {
  const { t } = useI18n()
  const [files, setFiles] = useState<ContextFileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('user')
  const [editFile, setEditFile] = useState<EditFileState | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newFile, setNewFile] = useState({ name: '', content: '', category: 'user' })
  const [status, setStatus] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const data = await synthApi.fetchJSON<{ files: ContextFileItem[] }>(
        `/api/v2/context/files?category=${activeTab}`,
      )
      setFiles(data.files || [])
    } catch { setFiles([]) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [activeTab])

  const switchTab = (tab: string) => {
    if (tab === activeTab) return
    setLoading(true)
    setActiveTab(tab)
  }

  const handleToggle = async (name: string) => {
    try {
      const result = await synthApi.fetchJSON<{ name: string; enabled: boolean }>(
        `/api/v2/context/files/${encodeURIComponent(name)}`,
        {
          method: 'POST',
          body: JSON.stringify({ action: 'toggle' }),
        },
      )
      setFiles(prev => prev.map(f =>
        f.name === name && f.category === 'user' ? { ...f, enabled: result.enabled } : f,
      ))
    } catch { /* ignore */ }
  }

  const handleEdit = async (name: string, category: string) => {
    try {
      const data = await synthApi.fetchJSON<{ name: string; content: string }>(
        `/api/v2/context/files/${encodeURIComponent(name)}?category=${encodeURIComponent(category)}`,
      )
      setEditFile({ name: data.name, content: data.content, category })
    } catch { /* ignore */ }
  }

  const handleSave = async () => {
    if (!editFile) return
    try {
      await synthApi.fetchJSON(`/api/v2/context/files/${encodeURIComponent(editFile.name)}`, {
        method: 'POST',
        body: JSON.stringify({ content: editFile.content, category: editFile.category }),
      })
      setEditFile(null)
      setStatus(t('admin.context.saved'))
      setTimeout(() => setStatus(null), 1500)
      await load()
    } catch { /* ignore */ }
  }

  const handleCreate = async () => {
    if (!newFile.name.trim()) return
    try {
      await synthApi.fetchJSON(`/api/v2/context/files/${encodeURIComponent(newFile.name)}`, {
        method: 'POST',
        body: JSON.stringify({ content: newFile.content, category: newFile.category }),
      })
      setShowCreate(false)
      setNewFile({ name: '', content: '', category: 'user' })
      if (newFile.category === activeTab) await load()
      setStatus(t('admin.context.fileCreated'))
      setTimeout(() => setStatus(null), 1500)
    } catch { /* ignore */ }
  }

  const handleDelete = async (name: string, category: string) => {
    if (!confirm(t('admin.context.confirmDelete', { name }))) return
    try {
      await synthApi.fetchJSON(
        `/api/v2/context/files/${encodeURIComponent(name)}?category=${encodeURIComponent(category)}`,
        { method: 'DELETE' },
      )
      await load()
    } catch { /* ignore */ }
  }

  const handleRestore = async (name: string, category: string) => {
    if (!confirm(t('admin.context.confirmReset', { name }))) return
    try {
      await synthApi.fetchJSON(
        `/api/v2/context/files/${encodeURIComponent(name)}/restore_to_default?category=${encodeURIComponent(category)}`,
        { method: 'POST' },
      )
      await load()
      setStatus(t('admin.context.restoredSystem'))
      setTimeout(() => setStatus(null), 1500)
    } catch { /* ignore */ }
  }

  const filtered = files.filter(f => f.category === activeTab || !activeTab)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t('admin.context.title')}</h3>
          <p className="text-muted-foreground text-sm">
            {t('admin.context.count', { count: filtered.length, status: '' })}
            {status && <span className="ml-2 text-blue-600">— {status}</span>}
          </p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">
          <Icon name="add" className="size-3.5" />{t('admin.context.add')}
        </button>
      </div>

      <div className="flex gap-1 bg-muted rounded-lg p-1">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => switchTab(cat.id)}
            className={cn(
              "flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              activeTab === cat.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t(CATEGORY_LABEL_KEYS[cat.id])}
          </button>
        ))}
      </div>

      {showCreate && (
        <div className="bg-background rounded-lg border p-4 space-y-3">
          <h4 className="font-medium text-sm">{t('admin.context.newFile')}</h4>
          <div>
            <label className="text-xs text-muted-foreground">{t('admin.context.fileName')}</label>
            <input type="text" value={newFile.name} onChange={e => setNewFile({ ...newFile, name: e.target.value })}
              placeholder="ABOUT.md"
              className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t('admin.context.content')}</label>
            <textarea value={newFile.content} onChange={e => setNewFile({ ...newFile, content: e.target.value })}
              rows={4}
              className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">{t('admin.context.create')}</button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover">{t('admin.context.cancel')}</button>
          </div>
        </div>
      )}

      {editFile && (
        <div className="bg-background rounded-lg border p-4 space-y-3">
          <h4 className="font-medium text-sm">{t('admin.context.editing', { name: editFile.name })} <span className="text-xs text-muted-foreground">({t(CATEGORY_LABEL_KEYS[editFile.category] || editFile.category)})</span></h4>
          <textarea value={editFile.content} onChange={e => setEditFile({ ...editFile, content: e.target.value })}
            rows={8}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
          <div className="flex gap-2">
            <button onClick={handleSave} className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">{t('admin.context.save')}</button>
            <button onClick={() => setEditFile(null)} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover">{t('admin.context.cancel')}</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="bg-background rounded-lg border p-3 animate-pulse"><div className="h-4 bg-muted rounded w-48" /></div>)}</div>
      ) : filtered.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground">
          {t('admin.context.empty', { category: t(CATEGORY_LABEL_KEYS[activeTab] || activeTab) })}
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((f) => (
            <div key={f.name} className="flex items-center justify-between bg-background rounded-lg border px-4 py-2.5">
              <div className="flex items-center gap-3">
                {f.category === 'user' ? (
                  <input type="checkbox" checked={f.enabled} onChange={() => handleToggle(f.name)}
                    className="size-4 rounded accent-blue-600" />
                ) : (
                  <div className="size-4" />
                )}
                <Icon name="file-text" className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{f.name}</span>
                {f.is_overridden && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                    {t('admin.context.modified')}
                  </span>
                )}
                {f.is_system && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                    {t('admin.context.system')}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">{f.size} B</span>
              </div>
              <div className="flex gap-1">
                <button onClick={() => handleEdit(f.name, f.category)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-interactive-hover">{t('admin.context.edit')}</button>
                {f.is_overridden && (
                  <button onClick={() => handleRestore(f.name, f.category)} className="px-2 py-1 rounded text-xs text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950">
                    {t('admin.context.reset')}
                  </button>
                )}
                {f.category === 'user' && (
                  <button onClick={() => handleDelete(f.name, f.category)} className="p-1 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950">
                    <Icon name="delete-bin" className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
