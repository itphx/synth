import { useEffect, useState } from 'react'
import { synthApi, type ProjectData } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'

export const ProjectsPanel = () => {
  const { t } = useI18n()
  const [projects, setProjects] = useState<ProjectData[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')

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
    if (!confirm(t('admin.projects.confirmDelete', { name: projectName }))) return
    try {
      await synthApi.deleteProject(id)
      await load()
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t('admin.projects.title')}</h3>
          <p className="text-muted-foreground text-sm">{t('admin.projects.count', { count: projects.length })}</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700"
        >
          <Icon name="add" className="size-3.5" />
          {t('admin.projects.create')}
        </button>
      </div>

      {showCreate && (
        <div className="bg-background rounded-lg border p-4 space-y-3">
          <h4 className="font-medium text-sm">{t('admin.projects.new')}</h4>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError('') }}
            placeholder={t('admin.projects.namePlaceholder')}
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700"
            >
              {t('admin.projects.create')}
            </button>
            <button
              onClick={() => { setShowCreate(false); setName(''); setError('') }}
              className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover"
            >
              {t('admin.projects.cancel')}
            </button>
          </div>
        </div>
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
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground">
          {t('admin.projects.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <div key={p.id} className="bg-background rounded-lg border p-4">
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <h4 className="font-medium text-sm truncate">{p.name}</h4>
                  <div className="flex gap-3 text-xs text-muted-foreground mt-1">
                    <code className="font-mono">{p.id.slice(0, 12)}...</code>
                    <span>{t('admin.projects.memberCount', { count: Object.keys(p.members || {}).length })}</span>
                    <span>{t('admin.projects.statusCount', { count: p.status_messages?.length || 0 })}</span>
                  </div>
                  {p.description && (
                    <p className="text-xs text-muted-foreground mt-1">{p.description}</p>
                  )}
                </div>
                <button
                  onClick={() => handleDelete(p.id, p.name)}
                  className="p-1 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                >
                  <Icon name="delete-bin" className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
