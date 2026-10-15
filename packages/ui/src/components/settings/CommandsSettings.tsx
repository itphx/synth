import { useEffect, useState } from 'react'
import type { CommandSummary, SkillBundle } from '@itphx/synth-shared'
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX, SKILL_NAME_REGEX } from '@itphx/synth-shared/schemas'
import { useI18n } from '@/lib/i18n'
import { useSkillsStore } from '@/stores/skillsStore'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { ListField, SettingsPanel, SettingsSection, TextArea, TextField } from '../ui/settings'

interface BundleEditorState {
  mode: 'create' | 'edit'
  name: string
  description: string
  skills: string[]
  instruction: string
}

interface BundleErrors {
  name?: string
  description?: string
  skills?: string
}

const EMPTY_BUNDLE: BundleEditorState = {
  mode: 'create',
  name: '',
  description: '',
  skills: [],
  instruction: '',
}

const KIND_BADGE: Record<string, string> = {
  builtin: 'bg-status-success/15 text-status-success',
  template: 'bg-primary/15 text-primary',
  skill: 'bg-status-warning/15 text-status-warning',
  bundle: 'bg-muted text-muted-foreground',
}

/**
 * ADR-046 §7/§9.2 / ADR-072: админ-категория «Команды» — список `/`-команд
 * (kind/source/availability + диагностика shadowed/collision) и CRUD bundles.
 */
export function CommandsSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const commands = useSkillsStore((s) => s.commands)
  const diagnostics = useSkillsStore((s) => s.commandDiagnostics)
  const commandsLoading = useSkillsStore((s) => s.commandsLoading)
  const commandsError = useSkillsStore((s) => s.commandsError)
  const fetchCommands = useSkillsStore((s) => s.fetchCommands)

  const bundles = useSkillsStore((s) => s.bundles)
  const bundlesLoading = useSkillsStore((s) => s.bundlesLoading)
  const bundlesError = useSkillsStore((s) => s.bundlesError)
  const fetchBundles = useSkillsStore((s) => s.fetchBundles)
  const createBundle = useSkillsStore((s) => s.createBundle)
  const updateBundle = useSkillsStore((s) => s.updateBundle)
  const deleteBundle = useSkillsStore((s) => s.deleteBundle)

  const [editor, setEditor] = useState<BundleEditorState | null>(null)
  const [errors, setErrors] = useState<BundleErrors>({})
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SkillBundle | null>(null)

  useEffect(() => {
    void fetchCommands({ diagnostics: true })
    void fetchBundles()
  }, [fetchCommands, fetchBundles])

  const openCreate = () => {
    setErrors({})
    setEditor({ ...EMPTY_BUNDLE, skills: [] })
  }

  const openEdit = (bundle: SkillBundle) => {
    setErrors({})
    setEditor({
      mode: 'edit',
      name: bundle.name,
      description: bundle.description,
      skills: [...bundle.skills],
      instruction: bundle.instruction ?? '',
    })
  }

  const validate = (state: BundleEditorState): BundleErrors => {
    const next: BundleErrors = {}
    if (!state.name.trim()) next.name = t('skillBundles.error.nameRequired')
    else if (state.name.length > SKILL_NAME_MAX || !SKILL_NAME_REGEX.test(state.name)) {
      next.name = t('skillBundles.error.nameInvalid')
    }
    if (!state.description.trim()) next.description = t('skillBundles.error.descriptionRequired')
    else if (state.description.length > SKILL_DESCRIPTION_MAX) {
      next.description = t('skillBundles.error.descriptionMax', { max: SKILL_DESCRIPTION_MAX })
    }
    if (state.skills.length === 0) next.skills = t('skillBundles.error.skillsRequired')
    return next
  }

  const handleSave = async () => {
    if (!editor) return
    const next = validate(editor)
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setSaving(true)
    try {
      const payload = {
        description: editor.description,
        skills: editor.skills,
        instruction: editor.instruction.trim() || undefined,
      }
      if (editor.mode === 'create') {
        await createBundle({ name: editor.name, ...payload })
      } else {
        await updateBundle(editor.name, payload)
      }
      setEditor(null)
      notify({ text: t('skillBundles.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('skillBundles.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteBundle(deleteTarget.name)
      notify({ text: t('skillBundles.deleted'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('skillBundles.deleteError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <SettingsPanel
      title={t('commands.title')}
      description={t('commands.description')}
      meta={commands ? t('commands.count', { count: commands.length }) : undefined}
    >
      {commandsError && (
        <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {commandsError}
        </div>
      )}

      <SettingsSection>
        {commandsLoading && commands === null && (
          <div className="text-center text-muted-foreground py-8">{t('common.loading')}</div>
        )}
        {commands && commands.length === 0 && (
          <div className="text-center text-muted-foreground py-8 text-sm">{t('commands.empty')}</div>
        )}
        {commands && commands.length > 0 && (
          <div className="space-y-2 min-w-0" data-testid="commands-list">
            {commands.map((command) => (
              <CommandRow key={`${command.kind}-${command.name}`} command={command} />
            ))}
          </div>
        )}
      </SettingsSection>

      {diagnostics.length > 0 && (
        <SettingsSection
          title={t('commands.diagnostics.title')}
          description={t('commands.diagnostics.description')}
        >
          <ul className="space-y-1 min-w-0" data-testid="commands-diagnostics">
            {diagnostics.map((d, i) => (
              <li key={`${d.code}-${d.command ?? d.path ?? i}`} className="text-xs break-words">
                <span className={cn('font-medium', d.level === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                  {d.code}
                </span>
                {' — '}
                <span className="text-muted-foreground">{d.message}</span>
              </li>
            ))}
          </ul>
        </SettingsSection>
      )}

      <SettingsSection
        title={t('commands.bundles.title')}
        description={t('commands.bundles.description')}
        actions={
          <Button data-testid="bundles-add" onClick={openCreate}>
            <Icon name="add" className="size-3.5" />
            {t('common.add')}
          </Button>
        }
      >
        {bundlesError && (
          <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {bundlesError}
          </div>
        )}

        {editor && (
          <div
            className="space-y-3 rounded-lg border border-border/60 bg-card p-3 min-w-0"
            data-testid="bundle-form"
          >
            <h4 className="text-sm font-medium text-foreground">
              {editor.mode === 'create' ? t('commands.bundles.new') : t('commands.bundles.edit')}
            </h4>
            <TextField
              label={t('skillBundles.name')}
              value={editor.name}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              disabled={editor.mode === 'edit'}
              error={errors.name}
              mono
              data-testid="bundle-form-name"
            />
            <TextArea
              label={t('skillBundles.description')}
              value={editor.description}
              onChange={(e) =>
                setEditor((prev) => (prev ? { ...prev, description: e.target.value } : prev))
              }
              error={errors.description}
              rows={2}
              data-testid="bundle-form-description"
            />
            <ListField
              label={t('skillBundles.skills')}
              description={t('skillBundles.skillsHint')}
              values={editor.skills}
              onChange={(skills) => setEditor((prev) => (prev ? { ...prev, skills } : prev))}
              variant="chips"
              placeholder="github-code-review"
              emptyText={t('skillBundles.noSkills')}
            />
            {errors.skills && <p className="text-xs text-destructive">{errors.skills}</p>}
            <TextArea
              label={t('skillBundles.instruction')}
              value={editor.instruction}
              onChange={(e) =>
                setEditor((prev) => (prev ? { ...prev, instruction: e.target.value } : prev))
              }
              rows={3}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="primary" onClick={() => void handleSave()} disabled={saving} data-testid="bundle-form-save">
                {saving ? t('common.saving') : t('common.save')}
              </Button>
              <Button variant="outline-muted" onClick={() => setEditor(null)} data-testid="bundle-form-cancel">
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}

        {bundlesLoading && bundles === null && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        {bundles && bundles.length === 0 && !editor && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('commands.bundles.empty')}</div>
        )}

        {bundles && bundles.length > 0 && (
          <div className="space-y-2 min-w-0" data-testid="bundles-list">
            {bundles.map((bundle) => (
              <div
                key={bundle.name}
                data-testid={`bundle-${bundle.name}`}
                className="flex flex-wrap items-start gap-3 p-3 rounded-lg border border-border bg-surface-inset hover:border-primary/50 transition-colors min-w-0"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium break-words">{bundle.name}</div>
                  <div className="text-xs text-muted-foreground break-words">{bundle.description}</div>
                  <div className="text-xs text-muted-foreground break-words font-mono">
                    {bundle.skills.join(', ')}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => openEdit(bundle)}
                    aria-label={t('common.edit')}
                    data-testid={`bundles-edit-${bundle.name}`}
                  >
                    <Icon name="edit-2" className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 hover:text-destructive"
                    onClick={() => setDeleteTarget(bundle)}
                    aria-label={t('common.delete')}
                    data-testid={`bundles-delete-${bundle.name}`}
                  >
                    <Icon name="delete-bin" className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={() => setDeleteTarget(null)}
        title={t('commands.bundles.deleteConfirm')}
        message={deleteTarget ? t('commands.bundles.deleteConfirmMessage', { name: deleteTarget.name }) : ''}
        confirmLabel={t('common.delete')}
        variant="danger"
        icon="delete-bin"
        onConfirm={() => void handleDelete()}
      />
    </SettingsPanel>
  )
}

function CommandRow({ command }: { command: CommandSummary }) {
  const { t } = useI18n()
  return (
    <div
      data-testid={`command-${command.name}`}
      className={cn(
        'flex flex-wrap items-start gap-2 p-3 rounded-lg border border-border bg-surface-inset min-w-0',
        !command.available && 'opacity-60',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <span className="text-sm font-medium break-words font-mono">/{command.name}</span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
              KIND_BADGE[command.kind] ?? 'bg-muted text-muted-foreground',
            )}
          >
            {t(`commands.kind.${command.kind}`)}
          </span>
          {command.scope && (
            <span className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-muted text-muted-foreground">
              {t(`skills.scope.${command.scope}`)}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground break-words">{command.description}</div>
        {command.argumentHint && (
          <div className="text-[0.625rem] text-muted-foreground/70 font-mono">{command.argumentHint}</div>
        )}
      </div>
      {!command.available && (
        <span data-testid={`command-unavailable-${command.name}`} className="shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-muted text-muted-foreground">
          {command.unavailableReason === 'denied' ? t('commands.unavailable.denied') : t('commands.unavailable')}
        </span>
      )}
    </div>
  )
}
