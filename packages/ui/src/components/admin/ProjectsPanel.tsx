import { useEffect, useState } from 'react'
import { synthApi, type ProjectData } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Button } from '../ui/button'
import { useI18n } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import { useNotification } from '@/hooks/useNotification'
import {
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  TextField,
} from '../ui/settings'
import { WorkspacePolicySection } from './WorkspacePolicySection'

export const ProjectsPanel = () => {
  const { t } = useI18n()
  const { notify } = useNotification()
  const [projects, setProjects] = useState<ProjectData[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  // Рабочий каталог по умолчанию
  const [workspace, setWorkspace] = useState('')
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const [workspaceSaving, setWorkspaceSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await synthApi.getProjects()
      setProjects(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    synthApi
      .getWorkspaceSetting()
      .then((r) => {
        setWorkspace(r.workspace)
        setWorkspaceDraft(r.workspace)
      })
      .catch(() => {})
  }, [])

  const handleSaveWorkspace = async () => {
    const path = workspaceDraft.trim()
    if (!path) {
      setError(t('admin.projects.workspace.pathRequired'))
      return
    }
    setWorkspaceSaving(true)
    try {
      const r = await synthApi.setWorkspaceSetting(path)
      setWorkspace(r.workspace)
      setWorkspaceDraft(r.workspace)
      setError('')
      notify({ text: t('admin.projects.workspace.saved'), type: 'success', category: 'system' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('admin.projects.workspace.error')
      notify({ text: `${t('admin.projects.workspace.error')} ${msg}`, type: 'error', category: 'error' })
    } finally {
      setWorkspaceSaving(false)
    }
  }

  const handleCreate = async () => {
    if (!name.trim()) {
      setError(t('admin.projects.nameRequired'))
      return
    }
    try {
      await synthApi.createProject({ name: name.trim() })
      setName('')
      setShowCreate(false)
      setError('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.projects.createError'))
    }
  }

  const handleDelete = async (id: string, projectName: string) => {
    if (!(await confirm({ title: t('admin.projects.confirmDelete', { name: projectName }), variant: 'danger' }))) return
    try {
      await synthApi.deleteProject(id)
      await load()
    } catch {
      // ignore
    }
  }

  return (
    <SettingsPanel
      title={t('admin.projects.title')}
      meta={t('admin.projects.count', { count: projects.length })}
      actions={
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Icon name="add" className="size-3.5" />
          {t('admin.projects.create')}
        </Button>
      }
    >
      <SettingsSection title={t('admin.projects.workspace.title')}>
        <div className="flex flex-wrap gap-2 min-w-0">
          <div className="flex-1 min-w-0">
            <TextField
              value={workspaceDraft}
              onChange={(e) => { setWorkspaceDraft(e.target.value); setError('') }}
              placeholder={t('admin.projects.workspace.placeholder')}
              mono
              aria-label={t('admin.projects.workspace.title')}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveWorkspace()}
            />
          </div>
          <Button
            size="sm"
            className="shrink-0"
            onClick={handleSaveWorkspace}
            disabled={workspaceSaving}
          >
            {workspaceSaving ? t('admin.projects.workspace.saving') : t('admin.projects.workspace.save')}
          </Button>
        </div>
        {workspace && (
          <p className="text-xs text-muted-foreground min-w-0 break-words">
            {t('admin.projects.workspace.current', { path: workspace })}
          </p>
        )}
        <p className="text-xs text-muted-foreground/70 min-w-0 break-words">
          {t('admin.projects.workspace.hint')}
        </p>
        {error && <p className="text-xs text-status-error min-w-0 break-words">{error}</p>}
      </SettingsSection>

      <WorkspacePolicySection />

      {showCreate && (
        <SettingsSection title={t('admin.projects.new')}>
          <TextField
            value={name}
            onChange={(e) => { setName(e.target.value); setError('') }}
            placeholder={t('admin.projects.namePlaceholder')}
            aria-label={t('admin.projects.new')}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          {error && <p className="text-xs text-status-error min-w-0 break-words">{error}</p>}
          <SettingsActions
            onSave={handleCreate}
            onCancel={() => { setShowCreate(false); setName(''); setError('') }}
            saveLabel={t('admin.projects.create')}
            cancelLabel={t('admin.projects.cancel')}
            saveTestId="project-create-save"
            cancelTestId="project-create-cancel"
          />
        </SettingsSection>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="bg-background rounded-lg border p-4 animate-pulse">
              <div className="h-4 bg-muted rounded w-32 mb-2" />
              <div className="h-3 bg-muted rounded w-48" />
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <SettingsSection>
          <p className="py-4 text-center text-muted-foreground">{t('admin.projects.empty')}</p>
        </SettingsSection>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <SettingsSection key={p.id}>
              <div className="flex items-start justify-between gap-3 min-w-0">
                <div className="min-w-0">
                  <h4 className="font-medium text-sm truncate">{p.name}</h4>
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground mt-1 min-w-0">
                    <code className="font-mono">{p.id.slice(0, 12)}...</code>
                    <span>{t('admin.projects.memberCount', { count: Object.keys(p.members || {}).length })}</span>
                    <span>{t('admin.projects.statusCount', { count: p.status_messages?.length || 0 })}</span>
                  </div>
                  {p.description && (
                    <p className="text-xs text-muted-foreground mt-1 min-w-0 break-words">{p.description}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  onClick={() => handleDelete(p.id, p.name)}
                  className="shrink-0 p-1 hover:bg-status-error/10 hover:text-status-error"
                  aria-label={t('common.delete')}
                >
                  <Icon name="delete-bin" className="size-4" />
                </Button>
              </div>
            </SettingsSection>
          ))}
        </div>
      )}
    </SettingsPanel>
  )
}
