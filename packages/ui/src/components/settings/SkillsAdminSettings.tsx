import { useEffect, useMemo, useState } from 'react'
import type { SkillSummary, SkillsDisabledRequest } from '@itphx/synth-shared'
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX, SKILL_NAME_REGEX } from '@itphx/synth-shared/schemas'
import { useI18n } from '@/lib/i18n'
import { useSkillsStore, EMPTY_SKILLS_DISABLED, EMPTY_SKILLS_DISABLED_FOR_NEW_PROJECTS, DEFAULT_SKILLS_POLICY } from '@/stores/skillsStore'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { SettingsActions, SettingsPanel, SettingsSection, useSettingsDraft } from '../ui/settings'
import type { ToolsPolicy } from '@/lib/api/synthApi'
import { PolicySettingsCard } from './PolicySettingsCard'
import { SkillEditorForm, type SkillEditorErrors, type SkillFileDraft } from './SkillEditorForm'

type EditingMode = 'create' | 'edit'

interface EditorState {
  mode: EditingMode
  name: string
  description: string
  body: string
  files: SkillFileDraft[]
}

const EMPTY_EDITOR: EditorState = { mode: 'create', name: '', description: '', body: '', files: [] }

/**
 * Две оси системных гейтов скиллов (ADR-046 §4.5):
 * - `disabled` — мастер: выключенный скилл недоступен нигде;
 * - `disabledForNewProjects` — сид новых проектов: что не включать по умолчанию.
 */
interface SkillsGates {
  disabled: SkillsDisabledRequest
  disabledForNewProjects: SkillsDisabledRequest
}

const EMPTY_SKILLS_GATES: SkillsGates = {
  disabled: EMPTY_SKILLS_DISABLED,
  disabledForNewProjects: EMPTY_SKILLS_DISABLED_FOR_NEW_PROJECTS,
}

/**
 * ADR-046 §4.5/§9.2 / ADR-072: админ-категория «Скиллы» — instance-реестр с CRUD
 * (`SKILL.md` + supporting-файлы), system-level enable/disable группами
 * (categories/groups) и точечно (name), политика включения.
 */
export function SkillsAdminSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const skills = useSkillsStore((s) => s.skills)
  const diagnostics = useSkillsStore((s) => s.skillsDiagnostics)
  const skillsLoading = useSkillsStore((s) => s.skillsLoading)
  const skillsError = useSkillsStore((s) => s.skillsError)
  const fetchSkills = useSkillsStore((s) => s.fetchSkills)
  const selectSkill = useSkillsStore((s) => s.selectSkill)
  const createSkill = useSkillsStore((s) => s.createSkill)
  const updateSkill = useSkillsStore((s) => s.updateSkill)
  const deleteSkill = useSkillsStore((s) => s.deleteSkill)
  const putSkillFile = useSkillsStore((s) => s.putSkillFile)
  const deleteSkillFile = useSkillsStore((s) => s.deleteSkillFile)

  const settingsDisabled = useSkillsStore((s) => s.settingsDisabled)
  const settingsDisabledForNewProjects = useSkillsStore((s) => s.settingsDisabledForNewProjects)
  const settingsPolicy = useSkillsStore((s) => s.settingsPolicy)
  const settingsLoading = useSkillsStore((s) => s.settingsLoading)
  const settingsError = useSkillsStore((s) => s.settingsError)
  const fetchSkillsSettings = useSkillsStore((s) => s.fetchSkillsSettings)
  const saveSkillsSettings = useSkillsStore((s) => s.saveSkillsSettings)
  const resetSkillsSettings = useSkillsStore((s) => s.resetSkillsSettings)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editingOriginalFiles, setEditingOriginalFiles] = useState<string[]>([])
  const [formErrors, setFormErrors] = useState<SkillEditorErrors>({})
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SkillSummary | null>(null)

  const [policy, setPolicy] = useState<ToolsPolicy>(DEFAULT_SKILLS_POLICY)
  const [savedPolicy, setSavedPolicy] = useState<ToolsPolicy>(DEFAULT_SKILLS_POLICY)
  const [policySaving, setPolicySaving] = useState(false)
  const [policyError, setPolicyError] = useState<string | null>(null)

  // Обе оси гейтов сохраняются одним PUT: стабильная ссылка нужна для эффекта синхронизации.
  const settingsGates = useMemo<SkillsGates | null>(
    () =>
      settingsDisabled
        ? {
            disabled: settingsDisabled,
            disabledForNewProjects: settingsDisabledForNewProjects
              ?? EMPTY_SKILLS_DISABLED_FOR_NEW_PROJECTS,
          }
        : null,
    [settingsDisabled, settingsDisabledForNewProjects],
  )

  const draft = useSettingsDraft<SkillsGates>({
    value: settingsGates,
    defaultValue: EMPTY_SKILLS_GATES,
    onSave: async (next) => {
      await saveSkillsSettings({
        disabled: next.disabled,
        disabledForNewProjects: next.disabledForNewProjects,
      })
    },
  })

  useEffect(() => {
    void fetchSkills({ diagnostics: true })
    void fetchSkillsSettings()
  }, [fetchSkills, fetchSkillsSettings])

  useEffect(() => {
    setPolicy(settingsPolicy)
    setSavedPolicy(settingsPolicy)
  }, [settingsPolicy])

  const categories = useMemo(() => uniqueValues(skills, (s) => s.category), [skills])
  const groups = useMemo(() => uniqueValues(skills, (s) => s.groups), [skills])

  const draftDisabled = draft.draft ?? EMPTY_SKILLS_GATES

  const toggleDisabled = (
    dimension: 'disabled' | 'disabledForNewProjects',
    kind: 'categories' | 'groups' | 'skills',
    value: string,
  ) => {
    draft.setDraft((prev) => {
      const base = prev ?? EMPTY_SKILLS_GATES
      const list = base[dimension][kind]
      const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
      return { ...base, [dimension]: { ...base[dimension], [kind]: next } }
    })
  }

  const openCreate = () => {
    setFormErrors({})
    setEditingOriginalFiles([])
    setEditor({ ...EMPTY_EDITOR })
  }

  const openEdit = async (skill: SkillSummary) => {
    setFormErrors({})
    await selectSkill(skill.name)
    const detail = useSkillsStore.getState().selectedSkill
    if (!detail) {
      notify({ text: t('skillsAdmin.form.loadError'), type: 'error', category: 'error' })
      return
    }
    setEditingOriginalFiles(detail.files)
    setEditor({
      mode: 'edit',
      name: detail.name,
      description: detail.description,
      body: detail.body,
      files: detail.files.map((path) => ({ path, content: '' })),
    })
  }

  const closeEditor = () => {
    setEditor(null)
    setEditingOriginalFiles([])
    setFormErrors({})
  }

  const validate = (state: EditorState): SkillEditorErrors => {
    const errors: SkillEditorErrors = {}
    if (!state.name.trim()) errors.name = t('skillsAdmin.form.error.nameRequired')
    else if (state.name.length > SKILL_NAME_MAX || !SKILL_NAME_REGEX.test(state.name)) {
      errors.name = t('skillsAdmin.form.error.nameInvalid')
    }
    if (!state.description.trim()) errors.description = t('skillsAdmin.form.error.descriptionRequired')
    else if (state.description.length > SKILL_DESCRIPTION_MAX) {
      errors.description = t('skillsAdmin.form.error.descriptionMax', { max: SKILL_DESCRIPTION_MAX })
    }
    return errors
  }

  const handleSaveEditor = async () => {
    if (!editor) return
    const errors = validate(editor)
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSaving(true)
    try {
      if (editor.mode === 'create') {
        const files: Record<string, string> = {}
        for (const file of editor.files) {
          if (file.path.trim()) files[file.path.trim()] = file.content
        }
        await createSkill({
          name: editor.name,
          description: editor.description,
          body: editor.body,
          files: Object.keys(files).length > 0 ? files : undefined,
        })
      } else {
        await updateSkill(editor.name, { description: editor.description, body: editor.body })
        // Supporting-файлы: пишем добавленные/изменённые, удаляем убранные.
        const keep = new Set(editor.files.map((f) => f.path.trim()).filter(Boolean))
        for (const file of editor.files) {
          const path = file.path.trim()
          if (!path) continue
          if (editingOriginalFiles.includes(path) && !file.content) continue
          await putSkillFile(editor.name, path, file.content)
        }
        for (const original of editingOriginalFiles) {
          if (!keep.has(original)) await deleteSkillFile(editor.name, original)
        }
      }
      await fetchSkills({ diagnostics: true })
      closeEditor()
      notify({ text: t('skillsAdmin.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('skillsAdmin.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      await deleteSkill(deleteTarget.name)
      notify({ text: t('skillsAdmin.deleted'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('skillsAdmin.deleteError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setDeleteTarget(null)
    }
  }

  const handleSaveDisabled = async () => {
    const ok = await draft.save()
    if (ok) {
      notify({ text: t('skillsAdmin.disabled.saved'), type: 'success', category: 'system' })
    }
  }

  const handleResetDisabled = async () => {
    try {
      await resetSkillsSettings()
      draft.setDraft({ ...EMPTY_SKILLS_GATES })
      notify({ text: t('skillsAdmin.disabled.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('skillsAdmin.disabled.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    }
  }

  const handleSavePolicy = async () => {
    setPolicySaving(true)
    setPolicyError(null)
    try {
      const state = useSkillsStore.getState()
      await saveSkillsSettings({
        disabled: state.settingsDisabled ?? EMPTY_SKILLS_DISABLED,
        disabledForNewProjects:
          state.settingsDisabledForNewProjects ?? EMPTY_SKILLS_DISABLED_FOR_NEW_PROJECTS,
        policy,
      })
      setSavedPolicy(policy)
      notify({ text: t('skillsPolicy.saved'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'HTTP'
      setPolicyError(message)
      notify({ text: t('skillsPolicy.saveError', { error: message }), type: 'error', category: 'error' })
    } finally {
      setPolicySaving(false)
    }
  }

  const handleResetPolicy = async () => {
    setPolicySaving(true)
    setPolicyError(null)
    try {
      await resetSkillsSettings()
      setPolicy(DEFAULT_SKILLS_POLICY)
      setSavedPolicy(DEFAULT_SKILLS_POLICY)
      draft.setDraft({ ...EMPTY_SKILLS_GATES })
      notify({ text: t('skillsPolicy.saved'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'HTTP'
      setPolicyError(message)
      notify({ text: t('skillsPolicy.saveError', { error: message }), type: 'error', category: 'error' })
    } finally {
      setPolicySaving(false)
    }
  }

  return (
    <SettingsPanel
      title={t('skillsAdmin.title')}
      description={t('skillsAdmin.description')}
      meta={skills ? t('skills.count', { count: skills.length }) : undefined}
      actions={
        <Button data-testid="skills-admin-add" onClick={openCreate}>
          <Icon name="add" className="size-3.5" />
          {t('common.add')}
        </Button>
      }
    >
      {skillsError && (
        <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {skillsError}
        </div>
      )}

      {editor && (
        <SkillEditorForm
          mode={editor.mode}
          name={editor.name}
          onNameChange={(name) => setEditor((prev) => (prev ? { ...prev, name } : prev))}
          description={editor.description}
          onDescriptionChange={(description) =>
            setEditor((prev) => (prev ? { ...prev, description } : prev))
          }
          body={editor.body}
          onBodyChange={(body) => setEditor((prev) => (prev ? { ...prev, body } : prev))}
          files={editor.files}
          onFilesChange={(files) => setEditor((prev) => (prev ? { ...prev, files } : prev))}
          saving={saving}
          errors={formErrors}
          onSave={() => void handleSaveEditor()}
          onCancel={closeEditor}
        />
      )}

      <SettingsSection
        id="skills-admin-list"
      >
        {skillsLoading && skills === null && (
          <div className="text-center text-muted-foreground py-8">{t('common.loading')}</div>
        )}

        {skills && skills.length === 0 && !editor && (
          <div className="text-center text-muted-foreground py-8">
            <Icon name="book-open" className="size-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">{t('skills.empty')}</p>
          </div>
        )}

        {skills && skills.length > 0 && (
          <div className="space-y-2 min-w-0" data-testid="skills-admin-list">
            {skills.map((skill) => (
              <SkillAdminRow
                key={skill.name}
                skill={skill}
                onEdit={() => void openEdit(skill)}
                onDelete={() => setDeleteTarget(skill)}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {/* Системные гейты, ось 1: мастер «выключить везде» */}
      <SettingsSection
        id="skills-admin-master"
        title={t('skillsAdmin.gates.master')}
        description={t('skillsAdmin.gates.masterHint')}
        tooltip={t('settings.help.skillsAdmin.section.skills-admin-master')}
      >
        {settingsError && !settingsGates && (
          <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {settingsError}
          </div>
        )}
        {settingsLoading && !settingsGates && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        <DisabledGroupDimension
          testIdPrefix="skills-disabled"
          categories={categories}
          groups={groups}
          skills={(skills ?? []).map((s) => s.name)}
          disabledValues={draftDisabled.disabled}
          onToggle={(kind, value) => toggleDisabled('disabled', kind, value)}
        />
      </SettingsSection>

      {/* Системные гейты, ось 2: сид новых проектов */}
      <SettingsSection
        id="skills-admin-new-projects"
        title={t('skillsAdmin.gates.newProjects')}
        description={t('skillsAdmin.gates.newProjectsHint')}
        tooltip={t('settings.help.skillsAdmin.section.skills-admin-new-projects')}
      >
        <DisabledGroupDimension
          testIdPrefix="skills-new-projects"
          categories={categories}
          groups={groups}
          skills={(skills ?? []).map((s) => s.name)}
          disabledValues={draftDisabled.disabledForNewProjects}
          onToggle={(kind, value) => toggleDisabled('disabledForNewProjects', kind, value)}
        />

        <SettingsActions
          onSave={() => void handleSaveDisabled()}
          onCancel={() => draft.revert()}
          onReset={() => void handleResetDisabled()}
          saveDisabled={settingsLoading || !draft.dirty}
          cancelDisabled={!draft.dirty}
          resetDisabled={settingsLoading}
          isDefault={draft.isDefault}
          saving={draft.saving}
          saveTestId="skills-disabled-save"
          cancelTestId="skills-disabled-cancel"
          resetTestId="skills-disabled-reset"
        />
      </SettingsSection>

      <PolicySettingsCard
        scope="skills"
        id="skills-admin-policy"
        tooltip={t('settings.help.skillsAdmin.section.policy')}
        fieldTooltip={t('settings.help.skillsAdmin.policy')}
        value={policy}
        savedValue={savedPolicy}
        loading={settingsLoading && !settingsGates}
        saving={policySaving}
        error={policyError}
        onChange={setPolicy}
        onSave={() => void handleSavePolicy()}
        onReset={() => void handleResetPolicy()}
        isDefault={policy === DEFAULT_SKILLS_POLICY}
        advanced
      />

      {/* Диагностика discovery/валидации */}
      {diagnostics.length > 0 && (
        <SettingsSection
          id="skills-admin-diagnostics"
          title={t('skillsAdmin.diagnostics.title')}
          description={t('skillsAdmin.diagnostics.description')}
          tooltip={t('settings.help.skillsAdmin.section.skills-admin-diagnostics')}
          advanced
        >
          <ul className="space-y-1 min-w-0" data-testid="skills-admin-diagnostics">
            {diagnostics.map((d, i) => (
              <li key={`${d.code}-${d.skill ?? d.path ?? i}`} className="text-xs break-words">
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

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={() => setDeleteTarget(null)}
        title={t('skillsAdmin.deleteConfirm')}
        message={deleteTarget ? t('skillsAdmin.deleteConfirmMessage', { name: deleteTarget.name }) : ''}
        confirmLabel={t('common.delete')}
        variant="danger"
        icon="delete-bin"
        onConfirm={() => void handleDeleteConfirm()}
      />
    </SettingsPanel>
  )
}

function SkillAdminRow({
  skill,
  onEdit,
  onDelete,
}: {
  skill: SkillSummary
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  const isInstance = skill.scope === 'instance'
  return (
    <div
      data-testid={`skills-admin-${skill.name}`}
      className={cn(
        'flex flex-wrap items-start gap-3 p-3 rounded-lg border border-border bg-surface-inset hover:border-primary/50 transition-colors min-w-0',
        !skill.available && 'opacity-60',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <span className="text-sm font-medium break-words">{skill.name}</span>
          <span className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-muted text-muted-foreground">
            {t(`skills.scope.${skill.scope}`)}
          </span>
          {!skill.trusted && (
            <span className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-destructive/15 text-destructive">
              {t('skills.untrusted')}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground break-words">{skill.description}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 min-h-[var(--control-height)] min-w-[var(--control-height)]"
          onClick={onEdit}
          disabled={!isInstance}
          title={!isInstance ? t('skillsAdmin.instanceOnly') : undefined}
          aria-label={t('common.edit')}
          data-testid={`skills-admin-edit-${skill.name}`}
        >
          <Icon name="edit-2" className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 min-h-[var(--control-height)] min-w-[var(--control-height)] hover:text-destructive"
          onClick={onDelete}
          disabled={!isInstance}
          title={!isInstance ? t('skillsAdmin.instanceOnly') : undefined}
          aria-label={t('common.delete')}
          data-testid={`skills-admin-delete-${skill.name}`}
        >
          <Icon name="delete-bin" className="size-4" />
        </Button>
      </div>
    </div>
  )
}

/**
 * ADR-046 §4.5: одно измерение системных гейтов (мастер или сид проектов) —
 * три группы (категории/группы/отдельные скиллы). Заголовок оси даёт
 * родительская `SettingsSection` (ADR-072: секции не вкладывать).
 */
function DisabledGroupDimension({
  testIdPrefix,
  categories,
  groups,
  skills,
  disabledValues,
  onToggle,
}: {
  testIdPrefix: string
  categories: string[]
  groups: string[]
  skills: string[]
  disabledValues: SkillsDisabledRequest
  onToggle: (kind: 'categories' | 'groups' | 'skills', value: string) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <DisabledGroup
        label={t('skillsAdmin.disabled.categories')}
        testIdPrefix={`${testIdPrefix}-category`}
        values={categories}
        disabledValues={disabledValues.categories}
        emptyText={t('skillsAdmin.disabled.noCategories')}
        onToggle={(value) => onToggle('categories', value)}
      />
      <DisabledGroup
        label={t('skillsAdmin.disabled.groups')}
        testIdPrefix={`${testIdPrefix}-group`}
        values={groups}
        disabledValues={disabledValues.groups}
        emptyText={t('skillsAdmin.disabled.noGroups')}
        onToggle={(value) => onToggle('groups', value)}
      />
      <DisabledGroup
        label={t('skillsAdmin.disabled.skills')}
        testIdPrefix={`${testIdPrefix}-skill`}
        values={skills}
        disabledValues={disabledValues.skills}
        emptyText={t('skillsAdmin.disabled.noSkills')}
        onToggle={(value) => onToggle('skills', value)}
      />
    </>
  )
}

function DisabledGroup({
  label,
  testIdPrefix,
  values,
  disabledValues,
  emptyText,
  onToggle,
}: {
  label: string
  testIdPrefix: string
  values: string[]
  disabledValues: string[]
  emptyText: string
  onToggle: (value: string) => void
}) {
  return (
    <div className="space-y-1.5 min-w-0">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</div>
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">{emptyText}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {values.map((value) => {
            const enabled = !disabledValues.includes(value)
            return (
              <label
                key={value}
                className={cn(
                  'flex min-h-[var(--control-height)] items-center gap-2 rounded-lg border border-border/60 bg-surface-inset px-2.5 py-1.5 cursor-pointer min-w-0',
                  'transition-colors duration-150 ease-out hover:bg-interactive-hover',
                  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                  !enabled && 'bg-interactive-selection',
                )}
              >
                <input
                  type="checkbox"
                  data-testid={`${testIdPrefix}-${value}`}
                  checked={enabled}
                  onChange={() => onToggle(value)}
                  className="size-4 shrink-0 accent-primary focus-visible:outline-none"
                  aria-label={`${label}: ${value}`}
                />
                <span className={cn('text-xs min-w-0 break-words', enabled ? 'text-foreground' : 'text-muted-foreground')}>
                  {value}
                </span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

function uniqueValues<T>(items: T[] | null, select: (item: T) => string | string[] | undefined): string[] {
  const set = new Set<string>()
  for (const item of items ?? []) {
    const value = select(item)
    if (Array.isArray(value)) value.forEach((v) => set.add(v))
    else if (value) set.add(value)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}
