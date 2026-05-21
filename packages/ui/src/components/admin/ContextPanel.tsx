import { useEffect, useState } from 'react'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

interface ContextFileItem {
  name: string
  category: string
  enabled: boolean
  size: number
}

const CATEGORIES = [
  { id: 'user', label: 'Пользовательские' },
  { id: 'role', label: 'Роли' },
  { id: 'system', label: 'Системные' },
  { id: 'tsm', label: 'TSM' },
] as const

export const ContextPanel = () => {
  const [files, setFiles] = useState<ContextFileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('user')
  const [editFile, setEditFile] = useState<{ name: string; content: string } | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newFile, setNewFile] = useState({ name: '', content: '', category: 'user' })

  const load = async () => {
    setLoading(true)
    try {
      const data = await synthApi.fetchJSON<{ files: ContextFileItem[] }>(
        `/api/v2/context/files?category=${activeTab}`,
      )
      setFiles(data.files || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [activeTab])

  const handleToggle = async (name: string) => {
    try {
      await synthApi.fetchJSON(`/api/v2/context/files/${encodeURIComponent(name)}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'toggle', category: activeTab }),
      })
      await load()
    } catch { /* ignore */ }
  }

  const handleEdit = async (name: string) => {
    try {
      const data = await synthApi.fetchJSON<{ name: string; content: string }>(
        `/api/v2/context/files/${encodeURIComponent(name)}`,
      )
      setEditFile(data)
    } catch { /* ignore */ }
  }

  const handleSave = async () => {
    if (!editFile) return
    try {
      await synthApi.fetchJSON(`/api/v2/context/files/${encodeURIComponent(editFile.name)}`, {
        method: 'POST',
        body: JSON.stringify({ content: editFile.content, category: activeTab }),
      })
      setEditFile(null)
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
      await load()
    } catch { /* ignore */ }
  }

  const handleDelete = async (name: string) => {
    if (!confirm(`Удалить файл «${name}»?`)) return
    try {
      await synthApi.fetchJSON(`/api/v2/context/files/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await load()
    } catch { /* ignore */ }
  }

  const filtered = files.filter(f => f.category === activeTab || !activeTab)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Контекст</h3>
          <p className="text-muted-foreground text-sm">{filtered.length} файлов</p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">
          <Icon name="add" className="size-3.5" />Добавить
        </button>
      </div>

      <div className="flex gap-1 bg-muted rounded-lg p-1">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setActiveTab(cat.id)}
            className={cn(
              "flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              activeTab === cat.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {showCreate && (
        <div className="bg-background rounded-lg border p-4 space-y-3">
          <h4 className="font-medium text-sm">Новый файл</h4>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Имя файла</label>
              <input type="text" value={newFile.name} onChange={e => setNewFile({ ...newFile, name: e.target.value })}
                placeholder="ABOUT.md"
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Категория</label>
              <select value={newFile.category} onChange={e => setNewFile({ ...newFile, category: e.target.value })}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Содержимое</label>
            <textarea value={newFile.content} onChange={e => setNewFile({ ...newFile, content: e.target.value })}
              rows={4}
              className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">Создать</button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover">Отмена</button>
          </div>
        </div>
      )}

      {editFile && (
        <div className="bg-background rounded-lg border p-4 space-y-3">
          <h4 className="font-medium text-sm">Редактирование: {editFile.name}</h4>
          <textarea value={editFile.content} onChange={e => setEditFile({ ...editFile, content: e.target.value })}
            rows={8}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
          <div className="flex gap-2">
            <button onClick={handleSave} className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700">Сохранить</button>
            <button onClick={() => setEditFile(null)} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover">Отмена</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="bg-background rounded-lg border p-3 animate-pulse"><div className="h-4 bg-muted rounded w-48" /></div>)}</div>
      ) : filtered.length === 0 ? (
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground">
          Нет файлов в категории «{CATEGORIES.find(c => c.id === activeTab)?.label}». Добавьте новый файл.
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((f) => (
            <div key={f.name} className="flex items-center justify-between bg-background rounded-lg border px-4 py-2.5">
              <div className="flex items-center gap-3">
                <input type="checkbox" checked={f.enabled} onChange={() => handleToggle(f.name)}
                  className="size-4 rounded accent-blue-600" />
                <Icon name="file-text" className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{f.name}</span>
                <span className="text-xs text-muted-foreground">{f.size} B</span>
              </div>
              <div className="flex gap-1">
                <button onClick={() => handleEdit(f.name)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-interactive-hover">Изменить</button>
                <button onClick={() => handleDelete(f.name)} className="p-1 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950">
                  <Icon name="delete-bin" className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
