import { useI18n } from '@/lib/i18n'
import { Button } from '../ui/button'
import { Icon } from '../icon/Icon'
import { TextArea, TextField } from '../ui/settings'

export interface SkillFileDraft {
  path: string
  content: string
}

export interface SkillEditorErrors {
  name?: string
  description?: string
}

export interface SkillEditorFormProps {
  mode: 'create' | 'edit'
  name: string
  onNameChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  body: string
  onBodyChange: (value: string) => void
  files: SkillFileDraft[]
  onFilesChange: (files: SkillFileDraft[]) => void
  saving?: boolean
  errors?: SkillEditorErrors
  onSave: () => void
  onCancel: () => void
}

/**
 * ADR-046 §9.1/§9.2 / ADR-072: форма `SKILL.md` — name/description/body и
 * supporting-файлы. Используется админ-категорией `skillsAdmin` (создание и
 * правка instance-скиллов).
 */
export function SkillEditorForm({
  mode,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  body,
  onBodyChange,
  files,
  onFilesChange,
  saving = false,
  errors,
  onSave,
  onCancel,
}: SkillEditorFormProps) {
  const { t } = useI18n()

  const updateFile = (index: number, patch: Partial<SkillFileDraft>) => {
    onFilesChange(files.map((file, i) => (i === index ? { ...file, ...patch } : file)))
  }

  const addFile = () => onFilesChange([...files, { path: '', content: '' }])
  const removeFile = (index: number) => onFilesChange(files.filter((_, i) => i !== index))

  return (
    <div
      className="w-full min-w-0 rounded-xl border border-border/60 bg-card p-4 space-y-3"
      data-testid="skill-editor-form"
    >
      <h3 className="text-sm font-medium text-foreground break-words">
        {mode === 'create' ? t('skillsAdmin.newSkill') : t('skillsAdmin.editSkill')}
      </h3>

      <TextField
        label={t('skillsAdmin.form.name')}
        description={t('skillsAdmin.form.nameHint')}
        tooltip={t('settings.help.skillsAdmin.name')}
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        disabled={mode === 'edit'}
        error={errors?.name}
        mono
        id="skill-form-name"
        data-testid="skill-form-name"
      />

      <TextArea
        label={t('skillsAdmin.form.description')}
        tooltip={t('settings.help.skillsAdmin.description')}
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        error={errors?.description}
        rows={2}
        id="skill-form-description"
        data-testid="skill-form-description"
      />

      <TextArea
        label={t('skillsAdmin.form.body')}
        description={t('skillsAdmin.form.bodyHint')}
        tooltip={t('settings.help.skillsAdmin.body')}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        mono
        rows={10}
        id="skill-form-body"
        data-testid="skill-form-body"
      />

      <div className="space-y-2 min-w-0" data-testid="skill-form-files">
        <div className="text-sm font-medium text-foreground">{t('skillsAdmin.form.files')}</div>
        {files.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('skillsAdmin.form.noFiles')}</p>
        )}
        {files.map((file, index) => (
          <div
            key={`${index}-${file.path}`}
            className="space-y-2 rounded-lg border border-border/60 bg-surface-inset p-3 min-w-0"
            data-testid={`skill-file-row-${index}`}
          >
            <div className="flex flex-wrap items-start gap-2 min-w-0">
              <div className="flex-1 min-w-0">
                <TextField
                  label={t('skillsAdmin.form.filePath')}
                  tooltip={t('settings.help.skillsAdmin.filePath')}
                  value={file.path}
                  onChange={(e) => updateFile(index, { path: e.target.value })}
                  mono
                  placeholder="references/checklist.md"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 mt-6 hover:text-destructive"
                onClick={() => removeFile(index)}
                aria-label={t('skillsAdmin.form.removeFile')}
              >
                <Icon name="delete-bin" className="size-4" />
              </Button>
            </div>
            <TextArea
              label={t('skillsAdmin.form.fileContent')}
              tooltip={t('settings.help.skillsAdmin.fileContent')}
              value={file.content}
              onChange={(e) => updateFile(index, { content: e.target.value })}
              mono
              rows={4}
            />
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={addFile} data-testid="skill-form-add-file">
          <Icon name="add" className="size-3.5" />
          {t('skillsAdmin.form.addFile')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 justify-end">
        <Button variant="primary" onClick={onSave} disabled={saving} data-testid="skill-form-save">
          {saving ? t('common.saving') : t('common.save')}
        </Button>
        <Button variant="outline-muted" onClick={onCancel} data-testid="skill-form-cancel">
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
