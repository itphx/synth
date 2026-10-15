import { useMemo } from 'react'

import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { Icon } from '@/components/icon/Icon'
import { EntityIconPicker } from '@/components/ui/EntityIconPicker'
import {
  SettingsActions,
  SettingsSection,
  TextArea,
  TextField,
  useSettingsDraft,
} from '@/components/ui/settings'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { synthApi } from '@/lib/api/synthApi'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useEntityEditStore, type EntityEditTarget } from '@/stores/entityEditStore'

/** Черновик формы: набор полей, общий для проекта и сессии. */
interface EntityEditDraft {
  name: string
  description: string
  icon: string | null
  color: string | null
}

function draftFromTarget(target: EntityEditTarget): EntityEditDraft {
  return {
    name: target.name,
    description: target.description ?? '',
    icon: target.icon ?? null,
    color: target.color ?? null,
  }
}

function EntityEditForm({ target, onClose }: { target: EntityEditTarget; onClose: () => void }) {
  const { t } = useI18n()
  const { notify } = useNotification()

  // Снимок — стабильная ссылка на время жизни формы (target в сторе не меняется,
  // пока диалог открыт), чтобы `useSettingsDraft` не перетирал черновик.
  const initial = useMemo(() => draftFromTarget(target), [target])

  const draft = useSettingsDraft<EntityEditDraft>({
    value: initial,
    onSave: async (next) => {
      const name = next.name.trim()
      try {
        if (target.kind === 'project') {
          const updated = await synthApi.updateProject(target.id, {
            name,
            description: next.description,
            icon: next.icon,
            color: next.color,
          })
          useProjectsStore.getState().updateProjectInList(updated)
          notify({ text: t('panel.saved'), type: 'success', category: 'system' })
          return {
            name: updated.name,
            description: updated.description ?? '',
            icon: updated.icon ?? null,
            color: updated.color ?? null,
          }
        }
        const updated = await synthApi.updateSession(target.id, {
          name,
          icon: next.icon,
          color: next.color,
        })
        useSessionsStore.getState().upsertSession(updated)
        const updatedName = updated.name ?? name
        useUIStore.getState().updateTabTitle(`chat-${target.id}`, updatedName)
        notify({ text: t('panel.saved'), type: 'success', category: 'system' })
        return {
          name: updatedName,
          description: '',
          icon: updated.icon ?? null,
          color: updated.color ?? null,
        }
      } catch (error) {
        notify({ text: t('panel.saveError'), type: 'error', category: 'error' })
        throw error
      }
    },
  })

  const values = draft.draft
  if (!values) return null

  const isProject = target.kind === 'project'

  const handleSave = async () => {
    const ok = await draft.save()
    if (ok) onClose()
  }

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Icon name={isProject ? 'folder-3' : 'chat-new'} className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">
          {isProject ? t('leftPanel.editProject.title') : t('leftPanel.editSession.title')}
        </span>
        <div className="ml-auto">
          <DialogClose
            className="rounded-lg p-1.5 text-muted-foreground opacity-70 transition-opacity hover:bg-interactive-hover hover:text-foreground hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label={t('common.close')}
            data-testid="entity-edit-close"
          >
            <Icon name="close" className="size-4" />
          </DialogClose>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <SettingsSection title={t('leftPanel.editProject.general')}>
          <TextField
            label={t('project.name')}
            value={values.name}
            onChange={(e) => draft.update({ name: e.target.value })}
            autoFocus
            data-testid="entity-edit-name"
          />
          {isProject && (
            <TextArea
              label={t('project.description')}
              value={values.description}
              onChange={(e) => draft.update({ description: e.target.value })}
              data-testid="entity-edit-description"
            />
          )}
        </SettingsSection>

        <SettingsSection title={t('leftPanel.editProject.appearance')}>
          <EntityIconPicker
            icon={values.icon}
            color={values.color}
            onIconChange={(icon) => draft.update({ icon })}
            onColorChange={(color) => draft.update({ color })}
          />
        </SettingsSection>

        <SettingsActions
          onSave={() => void handleSave()}
          onCancel={onClose}
          saving={draft.saving}
          saveDisabled={!draft.dirty}
          saveTestId="entity-edit-save"
          cancelTestId="entity-edit-cancel"
        />
      </div>
    </>
  )
}

/**
 * Единое центральное окно редактирования параметров проекта/сессии: имя
 * (у проекта — ещё описание) и внешний вид (иконка + цвет). Один экземпляр
 * рендерится в `App.tsx`; открытие — через `useEntityEditStore`.
 *
 * Сохранение — по кнопке (черновик, ADR-072), с тостами `panel.saved`/
 * `panel.saveError`. Широкий на десктопе (`sm:max-w-2xl`), на мобильном —
 * обычная центрированная модалка с внутренним скроллом.
 */
export function EntityEditDialog() {
  const target = useEntityEditStore((s) => s.target)
  const closeEntityEdit = useEntityEditStore((s) => s.closeEntityEdit)

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) closeEntityEdit() }}>
      <DialogContent
        className="sm:max-w-2xl max-h-[90vh] gap-0 overflow-hidden p-0"
        showCloseButton={false}
        data-testid="entity-edit-dialog"
      >
        {target && (
          <EntityEditForm
            key={`${target.kind}:${target.id}`}
            target={target}
            onClose={closeEntityEdit}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
