import { useEffect, useState } from 'react'
import { synthApi } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Button } from '../ui/button'
import { useI18n } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import {
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  Tabs,
  TextArea,
  TextField,
} from '../ui/settings'

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
] as const

const CATEGORY_LABEL_KEYS: Record<string, string> = {
  user: 'admin.context.userFiles',
  role: 'admin.context.rolesFiles',
  system: 'admin.context.systemFiles',
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
    if (!(await confirm({ title: t('admin.context.confirmDelete', { name }), variant: 'danger' }))) return
    try {
      await synthApi.fetchJSON(
        `/api/v2/context/files/${encodeURIComponent(name)}?category=${encodeURIComponent(category)}`,
        { method: 'DELETE' },
      )
      await load()
    } catch { /* ignore */ }
  }

  const handleRestore = async (name: string, category: string) => {
    if (!(await confirm({ title: t('admin.context.confirmReset', { name }), variant: 'danger' }))) return
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

  const countText = t('admin.context.count', { count: filtered.length, status: '' })
  const meta = status ? `${countText} — ${status}` : countText

  return (
    <SettingsPanel
      title={t('admin.context.title')}
      meta={meta}
      actions={
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Icon name="add" className="size-3.5" />{t('admin.context.add')}
        </Button>
      }
    >
      <SettingsSection>
        <Tabs
          items={CATEGORIES.map((cat) => ({
            value: cat.id,
            label: t(CATEGORY_LABEL_KEYS[cat.id]),
          }))}
          value={activeTab}
          onChange={switchTab}
          ariaLabel={t('admin.context.title')}
        />
      </SettingsSection>

      {showCreate && (
        <SettingsSection title={t('admin.context.newFile')}>
          <TextField
            label={t('admin.context.fileName')}
            value={newFile.name}
            onChange={e => setNewFile({ ...newFile, name: e.target.value })}
            placeholder="ABOUT.md"
          />
          <TextArea
            label={t('admin.context.content')}
            value={newFile.content}
            onChange={e => setNewFile({ ...newFile, content: e.target.value })}
            rows={4}
            mono
          />
          <SettingsActions
            onSave={handleCreate}
            onCancel={() => setShowCreate(false)}
            saveLabel={t('admin.context.create')}
            cancelLabel={t('admin.context.cancel')}
            saveTestId="context-create-save"
            cancelTestId="context-create-cancel"
          />
        </SettingsSection>
      )}

      {editFile && (
        <SettingsSection title={t('admin.context.editing', { name: editFile.name })}>
          <p className="text-xs text-muted-foreground min-w-0 break-words">
            {t(CATEGORY_LABEL_KEYS[editFile.category] || editFile.category)}
          </p>
          <TextArea
            value={editFile.content}
            onChange={e => setEditFile({ ...editFile, content: e.target.value })}
            rows={8}
            mono
            aria-label={t('admin.context.editing', { name: editFile.name })}
          />
          <SettingsActions
            onSave={handleSave}
            onCancel={() => setEditFile(null)}
            saveLabel={t('admin.context.save')}
            cancelLabel={t('admin.context.cancel')}
            saveTestId="context-edit-save"
            cancelTestId="context-edit-cancel"
          />
        </SettingsSection>
      )}

      {loading ? (
        <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="bg-background rounded-lg border p-3 animate-pulse"><div className="h-4 bg-muted rounded w-48" /></div>)}</div>
      ) : filtered.length === 0 ? (
        <SettingsSection>
          <p className="py-4 text-center text-muted-foreground">
            {t('admin.context.empty', { category: t(CATEGORY_LABEL_KEYS[activeTab] || activeTab) })}
          </p>
        </SettingsSection>
      ) : (
        <div className="space-y-1">
          {filtered.map((f) => (
            <SettingsSection key={f.name} className="p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {f.category === 'user' ? (
                    <input type="checkbox" checked={f.enabled} onChange={() => handleToggle(f.name)}
                      className="size-4 rounded accent-primary shrink-0" />
                  ) : (
                    <div className="size-4 shrink-0" />
                  )}
                  <Icon name="file-text" className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium min-w-0 break-all">{f.name}</span>
                  {f.is_overridden && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-status-warning/15 text-status-warning shrink-0">
                      {t('admin.context.modified')}
                    </span>
                  )}
                  {f.is_system && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground shrink-0">
                      {t('admin.context.system')}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground shrink-0">{f.size} B</span>
                </div>
                <div className="flex flex-wrap gap-1 shrink-0">
                  <Button variant="ghost" onClick={() => handleEdit(f.name, f.category)}>{t('admin.context.edit')}</Button>
                  {f.is_overridden && (
                    <Button
                      variant="ghost"
                      onClick={() => handleRestore(f.name, f.category)}
                      className="text-status-warning hover:bg-status-warning/10"
                    >
                      {t('admin.context.reset')}
                    </Button>
                  )}
                  {f.category === 'user' && (
                    <Button
                      variant="ghost"
                      onClick={() => handleDelete(f.name, f.category)}
                      className="p-1 hover:bg-status-error/10 hover:text-status-error"
                      aria-label={t('common.delete')}
                    >
                      <Icon name="delete-bin" className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </SettingsSection>
          ))}
        </div>
      )}
    </SettingsPanel>
  )
}
