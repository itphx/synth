import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { snippetsApi, type Snippet, type SnippetScope } from '@/lib/api/snippets'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { TextArea, TextField } from '../ui/settings'

/**
 * ADR-141 §4: редактор сниппетов одного уровня.
 *
 * Используется тремя точками:
 * - Настройки → «Сниппеты» — `scope:'user'`;
 * - Настройки → админ-раздел «Сниппеты» — `scope:'instance'`;
 * - правая панель → «Проект» — `scope:'project'` (+ `projectId`).
 *
 * `canEdit=false` — только просмотр (VIEWER проекта / не-админ).
 */
export function SnippetScopeEditor({
  scope,
  projectId,
  canEdit,
}: {
  scope: SnippetScope
  projectId?: string
  canEdit: boolean
}) {
  const { t } = useI18n()
  const [items, setItems] = useState<Snippet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await snippetsApi.listSnippets({
        scope,
        ...(scope === 'project' && projectId ? { projectId } : {}),
      })
      setItems(response.snippets ?? [])
    } catch {
      setError(t('snippets.error'))
    } finally {
      setLoading(false)
    }
  }, [projectId, scope, t])

  useEffect(() => {
    void load()
  }, [load])

  const resetForm = () => {
    setSelected(null)
    setName('')
    setDescription('')
    setBody('')
  }

  const select = (snippet: Snippet) => {
    if (!canEdit) return
    setSelected(snippet.name)
    setName(snippet.name)
    setDescription(snippet.description ?? '')
    setBody(snippet.body)
  }

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed || !canEdit) return
    if (scope === 'project' && !projectId) {
      setError(t('snippets.projectRequired'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const project = scope === 'project' && projectId ? { projectId } : {}
      if (selected) {
        await snippetsApi.updateSnippet(selected, {
          name: trimmed,
          body,
          description: description.trim() || null,
          scope,
          ...project,
        })
      } else {
        await snippetsApi.createSnippet({
          name: trimmed,
          body,
          description: description.trim() || undefined,
          scope,
          ...project,
        })
      }
      resetForm()
      await load()
    } catch {
      setError(t('snippets.saveError'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (snippetName: string) => {
    if (!canEdit) return
    if (scope === 'project' && !projectId) return
    setSaving(true)
    setError(null)
    try {
      await snippetsApi.deleteSnippet(
        snippetName,
        scope === 'project' && projectId ? { projectId } : undefined,
      )
      if (selected === snippetName) resetForm()
      await load()
    } catch {
      setError(t('snippets.deleteError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 min-w-0">
      {error && (
        <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {canEdit && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <TextField
              label={t('snippets.name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="signoff"
              disabled={saving}
            />
            <TextField
              label={t('snippets.descriptionField')}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={saving}
            />
          </div>
          <TextArea
            label={t('snippets.body')}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={6}
            disabled={saving}
          />
          <div className="flex items-center gap-2">
            <Button onClick={() => void save()} disabled={saving || !name.trim()}>
              {selected ? t('snippets.save') : t('snippets.create')}
            </Button>
            {selected && (
              <>
                <Button variant="outline" onClick={resetForm} disabled={saving}>
                  {t('snippets.cancel')}
                </Button>
                <Button variant="outline" onClick={() => void remove(selected)} disabled={saving}>
                  {t('snippets.delete')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {!canEdit && <p className="text-xs text-muted-foreground">{t('snippets.readOnly')}</p>}

      {loading && <div className="text-sm text-muted-foreground">{t('common.loading')}</div>}
      {!loading && items.length === 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-inset px-3 py-2 text-xs text-muted-foreground">
          <Icon name="file-text" className="size-4 opacity-50" />
          {t('snippets.empty')}
        </div>
      )}
      {!loading && items.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="snippet-list">
          {items.map((item) => (
            <button
              key={`${item.scope}:${item.name}`}
              type="button"
              className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-interactive-hover"
              onClick={() => select(item)}
              data-testid={`snippet-${item.name}`}
            >
              <span className="text-sm font-medium">#{item.name}</span>
              {item.description && (
                <span className="ml-2 text-xs text-muted-foreground">{item.description}</span>
              )}
              {!item.trusted && (
                <span className="ml-2 text-xs text-status-warning">{t('snippets.untrusted')}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {!loading && items.some((item) => !item.trusted) && (
        <p className="text-[0.625rem] text-status-warning/80">{t('snippets.untrustedHint')}</p>
      )}
    </div>
  )
}
