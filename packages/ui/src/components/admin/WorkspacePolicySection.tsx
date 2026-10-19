import { useEffect, useState } from 'react'
import { synthApi, type WorkspacePolicyInfo } from '@/lib/api/synthApi'
import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import {
  DefaultsBadge,
  SegmentedControl,
  SettingsActions,
  SettingsSection,
  useSettingsDraft,
} from '@/components/ui/settings'
import type { WorkspaceOutsideRootPolicy } from '@itphx/synth-shared/types'

/**
 * ADR-075: политика для абсолютного `project.workspace` вне `workspacesRoot`
 * (`confirm` — подтверждение, `deny` — запрет). Runtime-override поверх config/env,
 * сброс — `DELETE /settings/workspace-policy`.
 *
 * В managed-развёртывании ФС принадлежит backend, политика эффективно всегда
 * `deny` (enforcement на сервере) — контрол read-only.
 */
export function WorkspacePolicySection() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const deployment = useAuthStore((s) => s.deployment)

  const [info, setInfo] = useState<WorkspacePolicyInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    let cancelled = false
    synthApi
      .getWorkspacePolicy()
      .then((data) => {
        if (!cancelled) setInfo(data)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const draft = useSettingsDraft<WorkspaceOutsideRootPolicy>({
    value: info?.outsideRoot ?? null,
    defaultValue: info?.defaults ?? null,
    onSave: async (next) => {
      await synthApi.setWorkspacePolicy({ outsideRoot: next })
      const fresh = await synthApi.getWorkspacePolicy()
      setInfo(fresh)
      return fresh.outsideRoot
    },
  })

  const isDefault = info ? !info.isOverridden : true
  const value: WorkspaceOutsideRootPolicy = draft.draft ?? info?.outsideRoot ?? 'confirm'

  const handleSave = async () => {
    if (!draft.dirty) return
    const ok = await draft.save()
    notify(
      ok
        ? { text: t('common.saved'), type: 'success', category: 'system' }
        : { text: t('common.saveError'), type: 'error', category: 'error' },
    )
  }

  const handleReset = async () => {
    setResetting(true)
    try {
      const fresh = await synthApi.clearWorkspacePolicy()
      setInfo(fresh)
      draft.setDraft(fresh.outsideRoot)
      notify({ text: t('common.saved'), type: 'success', category: 'system' })
    } catch (e) {
      notify({
        text: `${t('common.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        type: 'error',
        category: 'error',
      })
    } finally {
      setResetting(false)
    }
  }

  if (deployment === 'managed') {
    return (
      <SettingsSection
        id="projects-workspace-policy"
        title={t('workspace.policy.title')}
        description={t('workspace.policy.description')}
        tooltip={t('settings.help.projects.section.projects-workspace-policy')}
      >
        <div className="text-sm text-foreground" data-testid="workspace-policy-managed">
          {t('workspace.policy.deny')}
        </div>
        <p className="text-xs text-muted-foreground min-w-0 break-words">
          {t('workspace.managedReadOnly')}
        </p>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      id="projects-workspace-policy"
      title={t('workspace.policy.title')}
      description={t('workspace.policy.description')}
      tooltip={t('settings.help.projects.section.projects-workspace-policy')}
      actions={isDefault ? <DefaultsBadge /> : undefined}
    >
      {loading ? (
        <div className="text-center text-muted-foreground py-4 text-sm">{t('common.loading')}</div>
      ) : (
        <>
          <SegmentedControl<WorkspaceOutsideRootPolicy>
            value={value}
            onChange={(next) => draft.setDraft(next)}
            ariaLabel={t('workspace.policy.title')}
            options={[
              { value: 'confirm', label: t('workspace.policy.confirm') },
              { value: 'deny', label: t('workspace.policy.deny') },
            ]}
          />
          <p className="text-xs text-muted-foreground min-w-0 break-words" data-testid="workspace-policy-status">
            {info?.isOverridden
              ? t('workspace.policy.overridden')
              : `${t('workspace.policy.default')}: ${t(`workspace.policy.${info?.defaults ?? 'confirm'}`)}`}
          </p>
          <SettingsActions
            onSave={handleSave}
            onReset={handleReset}
            saving={draft.saving}
            saveDisabled={!draft.dirty || loading}
            resetDisabled={resetting || loading || isDefault}
            isDefault={isDefault}
            saveTestId="workspace-policy-save"
            resetTestId="workspace-policy-reset"
          />
        </>
      )}
    </SettingsSection>
  )
}
