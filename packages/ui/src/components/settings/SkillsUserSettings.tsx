import { useEffect } from 'react'
import type { SkillSummary } from '@itphx/synth-shared'
import { useI18n } from '@/lib/i18n'
import { useSkillsStore } from '@/stores/skillsStore'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { SettingsPanel, SettingsSection } from '../ui/settings'

/** Цвета бейджей уровня/scope/trust/доступности (только токены темы). */
const SCOPE_BADGE: Record<string, string> = {
  instance: 'bg-primary/15 text-primary',
  project: 'bg-status-warning/15 text-status-warning',
}

const LEVEL_BADGE: Record<string, string> = {
  system: 'bg-status-success/15 text-status-success',
  project: 'bg-primary/15 text-primary',
  session: 'bg-muted text-muted-foreground',
}

/**
 * ADR-046 §9.3 / ADR-072: пользовательский раздел «Скиллы» — просмотр реестра
 * доступных скиллов и деталей (тело `SKILL.md` + supporting-файлы). Пользователь
 * свои скиллы не создаёт: CRUD — в админ-категории `skillsAdmin`.
 */
export function SkillsUserSettings() {
  const { t } = useI18n()
  const skills = useSkillsStore((s) => s.skills)
  const loading = useSkillsStore((s) => s.skillsLoading)
  const error = useSkillsStore((s) => s.skillsError)
  const fetchSkills = useSkillsStore((s) => s.fetchSkills)
  const reloadSkills = useSkillsStore((s) => s.reloadSkills)
  const selectedSkill = useSkillsStore((s) => s.selectedSkill)
  const selectedLoading = useSkillsStore((s) => s.selectedLoading)
  const selectSkill = useSkillsStore((s) => s.selectSkill)
  const clearSelectedSkill = useSkillsStore((s) => s.clearSelectedSkill)

  useEffect(() => {
    void fetchSkills()
  }, [fetchSkills])

  const handleReload = () => {
    void reloadSkills().catch(() => undefined)
  }

  return (
    <SettingsPanel
      title={t('skills.title')}
      description={t('skills.description')}
      meta={skills ? t('skills.count', { count: skills.length }) : undefined}
      actions={
        <Button
          variant="outline"
          data-testid="skills-reload"
          onClick={handleReload}
          disabled={loading}
        >
          <Icon name="refresh" className="size-3.5" />
          {t('skills.reload')}
        </Button>
      }
    >
      {error && (
        <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {t('skills.error.load')}
        </div>
      )}

      {loading && skills === null && (
        <div className="text-center text-muted-foreground py-8">{t('common.loading')}</div>
      )}

      <SettingsSection>
        {skills && skills.length === 0 && (
          <div className="text-center text-muted-foreground py-8">
            <Icon name="book-open" className="size-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">{t('skills.empty')}</p>
          </div>
        )}

        {skills && skills.length > 0 && (
          <div className="space-y-2 min-w-0" data-testid="skills-user-list">
            {skills.map((skill) => (
              <SkillListItem
                key={skill.name}
                skill={skill}
                active={selectedSkill?.name === skill.name}
                onSelect={() =>
                  selectedSkill?.name === skill.name
                    ? clearSelectedSkill()
                    : void selectSkill(skill.name)
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {selectedLoading && (
        <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
      )}

      {selectedSkill && !selectedLoading && (
        <SettingsSection title={t('skills.detail.title')}>
          <div className="space-y-2 min-w-0" data-testid="skills-user-detail">
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <span className="text-sm font-medium break-words">{selectedSkill.name}</span>
              <ScopeBadges skill={selectedSkill} />
            </div>
            <p className="text-xs text-muted-foreground break-words">{selectedSkill.description}</p>

            {!selectedSkill.trusted ? (
              <div
                className="p-2 rounded-lg bg-status-warning/10 text-status-warning text-xs"
                data-testid="skills-untrusted-hint"
              >
                {t('skills.untrustedHint')}
              </div>
            ) : (
              <>
                <div className="space-y-1 min-w-0">
                  <div className="text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide">
                    {t('skills.detail.body')}
                  </div>
                  <pre
                    data-testid="skills-user-detail-body"
                    className="max-h-64 overflow-auto rounded-lg border border-border/60 bg-surface-inset p-3 text-xs whitespace-pre-wrap break-words"
                  >
                    {selectedSkill.body || t('skills.detail.noBody')}
                  </pre>
                </div>

                <div className="space-y-1 min-w-0">
                  <div className="text-[0.625rem] text-muted-foreground/60 uppercase tracking-wide">
                    {t('skills.detail.files', { count: selectedSkill.files.length })}
                  </div>
                  {selectedSkill.files.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('skills.detail.noFiles')}</p>
                  ) : (
                    <ul className="space-y-1 min-w-0" data-testid="skills-user-files">
                      {selectedSkill.files.map((file) => (
                        <li key={file} className="text-xs font-mono break-words text-muted-foreground">
                          {file}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        </SettingsSection>
      )}

      {selectedSkill && (
        <div className="flex justify-end">
          <Button variant="outline-muted" data-testid="skills-close-detail" onClick={clearSelectedSkill}>
            {t('skills.detail.close')}
          </Button>
        </div>
      )}
    </SettingsPanel>
  )
}

function SkillListItem({
  skill,
  active,
  onSelect,
}: {
  skill: SkillSummary
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-testid={`skills-user-${skill.name}`}
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'w-full text-left flex flex-wrap items-start gap-2 p-3 rounded-lg border bg-surface-inset transition-colors min-w-0',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'border-primary/60 bg-primary/5' : 'border-border hover:border-primary/50',
        !skill.available && 'opacity-70',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <span className="text-sm font-medium break-words">{skill.name}</span>
          <ScopeBadges skill={skill} />
        </div>
        <div className="text-xs text-muted-foreground break-words" title={skill.description}>
          {skill.description}
        </div>
        {(skill.category || skill.tags.length > 0) && (
          <div className="text-[0.625rem] text-muted-foreground/70 break-words">
            {[skill.category, ...skill.tags].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      <Icon name="arrow-right-s" className="size-4 shrink-0 self-center text-muted-foreground" />
    </button>
  )
}

function ScopeBadges({ skill }: { skill: Pick<SkillSummary, 'scope' | 'level' | 'trusted' | 'available'> }) {
  const { t } = useI18n()
  return (
    <>
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
          SCOPE_BADGE[skill.scope] ?? 'bg-muted text-muted-foreground',
        )}
      >
        {t(`skills.scope.${skill.scope}`)}
      </span>
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
          LEVEL_BADGE[skill.level] ?? 'bg-muted text-muted-foreground',
        )}
      >
        {t(`skills.level.${skill.level}`)}
      </span>
      {!skill.trusted && (
        <span
          data-testid="skills-badge-untrusted"
          className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-destructive/15 text-destructive"
        >
          {t('skills.untrusted')}
        </span>
      )}
      {!skill.available && (
        <span
          data-testid="skills-badge-unavailable"
          className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-muted text-muted-foreground"
        >
          {t('skills.unavailable')}
        </span>
      )}
    </>
  )
}
