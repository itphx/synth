import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { InfoField, SettingsPanel, SettingsSection } from '../ui/settings'
import { synthApi, type PackInstallation } from '@/lib/api/synthApi'
import { parsePackAuthority, type PackAuthorityContentView } from './authority-view'

/**
 * ADR-106 §11 / ADR-072: раздел «Полномочия» — **read-only** просмотр
 * Authority-слоя.
 *
 * Что показывает раздел:
 * - режим слоя и три возможных статуса (`принуждение` / `только журнал` /
 *   `выключен`) — значения конфига в API не отдаются, поэтому показан разбор
 *   режимов и честная пометка, что текущий режим читается из конфига;
 * - роли → гранты («действие × цель» + эффект) с источником гранта (пакет);
 * - привязки агентов к ролям и потолку агента.
 *
 * Правда чтения: реестр пакетов в core — `requireAuth`, в managed — ADMIN.
 * Для не-ADMIN раздел остаётся видимым и read-only: при 403 показывается
 * понятное сообщение, кнопок мутаций нет (политика слоя меняется конфигом и
 * одобрением пакета, а не из UI).
 */

/** Статус HTTP-ошибки (403 — нет прав администратора). */
const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/** Класс бейджа эффекта гранта. */
const EFFECT_CLASS: Record<string, string> = {
  allow: 'bg-status-success/15 text-status-success',
  ask: 'bg-status-warning/15 text-status-warning',
  deny: 'bg-destructive/15 text-destructive',
}

/** Класс бейджа статуса установки пакета — источника гранта. */
const PACK_STATUS_CLASS: Record<string, string> = {
  active: 'bg-status-success/15 text-status-success',
  pending_approval: 'bg-status-warning/15 text-status-warning',
  disabled: 'bg-muted text-muted-foreground',
}

/** Контент полномочий одного пакета (роли/действия/цели/агенты). */
interface AuthorityEntry {
  pack: PackInstallation
  content: PackAuthorityContentView | null
}

export function AuthoritySettings() {
  const { t } = useI18n()

  const [entries, setEntries] = useState<AuthorityEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const packs = await synthApi.getPacks()
      // Подробный состав ролей и грантов лежит в сыром манифесте пакета
      // (`GET /packs/:name`); список `GET /packs` отдаёт только сводку.
      const details = await Promise.all(
        packs
          .filter((pack) => pack.authority)
          .map(async (pack): Promise<AuthorityEntry> => {
            try {
              const detail = await synthApi.getPack(pack.name)
              return { pack, content: parsePackAuthority(detail.manifest) }
            } catch {
              // Детали недоступны (например, 403 в managed) — сводка списка
              // остаётся: роль и число грантов видны, состав — нет.
              return { pack, content: null }
            }
          }),
      )
      setEntries(details)
    } catch (err) {
      setError(
        statusOf(err) === 403
          ? t('authority.forbidden')
          : t('authority.loadError', {
              error: err instanceof Error ? err.message : t('common.error'),
            }),
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  /** Пакеты, приносящие контент полномочий. */
  const authorityPacks = useMemo(
    () => (entries ?? []).filter((entry) => entry.pack.authority),
    [entries],
  )

  /** Сводка по инстансу: роли/действия/цели/агенты, принесённые пакетами. */
  const totals = useMemo(() => {
    let roles = 0
    let actions = 0
    let targets = 0
    let agents = 0
    let grants = 0
    for (const entry of authorityPacks) {
      const summary = entry.pack.authority
      if (!summary) continue
      roles += summary.totals.roles
      actions += summary.totals.actions
      targets += summary.totals.targets
      agents += summary.totals.agents
      grants += summary.totals.grants
    }
    return { roles, actions, targets, agents, grants }
  }, [authorityPacks])

  return (
    <SettingsPanel title={t('authority.title')} description={t('authority.description')}>
      {/* 1. Режим слоя: значения конфига в API не отдаются — показываем разбор. */}
      <SettingsSection
        id="authority-mode"
        title={t('authority.mode.title')}
        description={t('authority.mode.description')}
      >
        <div className="space-y-2" data-testid="authority-mode">
          <InfoField label={t('authority.mode.current')} value={t('authority.mode.unknown')} />
          <div className="space-y-1.5 pt-1">
            <div className="text-xs text-muted-foreground">{t('authority.mode.states')}</div>
            <div className="space-y-1.5" data-testid="authority-mode-states">
              <InfoField
                label={t('authority.mode.state.enforced')}
                value={t('authority.mode.state.enforcedHint')}
              />
              <InfoField
                label={t('authority.mode.state.shadow')}
                value={t('authority.mode.state.shadowHint')}
              />
              <InfoField
                label={t('authority.mode.state.disabled')}
                value={t('authority.mode.state.disabledHint')}
              />
            </div>
            <div className="text-[0.6875rem] text-muted-foreground break-words">
              {t('authority.mode.configHint')}
            </div>
          </div>
        </div>
      </SettingsSection>

      {/* 2. Политика инстанса: сама политика в API не отдаётся — честная заглушка. */}
      <SettingsSection
        id="authority-policy"
        title={t('authority.policy.title')}
        description={t('authority.policy.description')}
      >
        <div
          className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground break-words"
          data-testid="authority-policy-stub"
        >
          {t('authority.policy.stub')}
        </div>

        {authorityPacks.length > 0 && (
          <div className="space-y-1.5" data-testid="authority-policy-totals">
            <InfoField label={t('authority.policy.roles')} value={String(totals.roles)} mono />
            <InfoField label={t('authority.policy.actions')} value={String(totals.actions)} mono />
            <InfoField label={t('authority.policy.targets')} value={String(totals.targets)} mono />
            <InfoField label={t('authority.policy.agents')} value={String(totals.agents)} mono />
            <InfoField label={t('authority.policy.grants')} value={String(totals.grants)} mono />
          </div>
        )}

        {/* Объявленные пакетом доменные действия и виды целей — из сводки пакета. */}
        <ul className="space-y-2 min-w-0" data-testid="authority-policy-contents">
          {authorityPacks.map((entry) => {
            const summary = entry.pack.authority
            if (!summary) return null
            return (
              <li
                key={entry.pack.name}
                data-testid={`authority-policy-content-${entry.pack.name}`}
                className="space-y-1.5 rounded-md border border-border/60 p-2 min-w-0"
              >
                <div className="text-xs font-medium text-foreground break-words">{entry.pack.name}</div>
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="text-[0.6875rem] text-muted-foreground shrink-0">
                    {t('authority.policy.actions')}
                  </span>
                  {summary.actions.map((action) => (
                    <span
                      key={action.id}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] text-foreground break-all"
                    >
                      {action.id}
                      {action.mutating && ` (${t('authority.policy.mutating')})`}
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="text-[0.6875rem] text-muted-foreground shrink-0">
                    {t('authority.policy.targets')}
                  </span>
                  {summary.targets.map((target) => (
                    <span
                      key={target.kind}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] text-foreground break-all"
                    >
                      {target.kind}
                    </span>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      </SettingsSection>

      {error && (
        <div
          role="alert"
          data-testid="authority-error"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive break-words"
        >
          {error}
        </div>
      )}

      {loading && !entries && (
        <div className="py-3 text-center text-xs text-muted-foreground">{t('common.loading')}</div>
      )}

      {/* 3. Роли и гранты — из контента пакетов (источник гранта). */}
      <SettingsSection
        id="authority-roles"
        title={t('authority.roles.title')}
        description={t('authority.roles.description')}
      >
        {!loading && authorityPacks.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="authority-roles-empty"
          >
            <Icon name="shield-check" className="size-6 opacity-40" />
            <p className="text-xs">{t('authority.roles.empty')}</p>
          </div>
        )}

        <ul className="space-y-2 min-w-0" data-testid="authority-roles-list">
          {authorityPacks.map((entry) => {
            const summary = entry.pack.authority
            const roles = entry.content?.roles ?? []
            const fallbackRoles = summary?.roles ?? []
            const source = entry.pack.name
            const status = entry.pack.status
            return (
              <li
                key={entry.pack.name}
                data-testid={`authority-role-pack-${entry.pack.name}`}
                className="space-y-2 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0"
              >
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="text-sm font-medium text-foreground break-words min-w-0">
                    {source}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
                      PACK_STATUS_CLASS[status] ?? 'bg-muted text-muted-foreground',
                    )}
                    data-testid={`authority-role-source-${entry.pack.name}`}
                  >
                    {t(`authority.pack.status.${status}`)}
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {t('authority.roles.sourcePack')}
                  </span>
                </div>

                {roles.length === 0 &&
                  fallbackRoles.map((role) => (
                    <div
                      key={role.id}
                      className="space-y-1 rounded-md border border-border/60 p-2 min-w-0"
                      data-testid={`authority-role-${role.id}`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                        <span className="text-xs font-medium text-foreground break-words">
                          {role.displayName || role.id}
                        </span>
                        {role.domain && (
                          <span className="text-[0.6875rem] text-muted-foreground break-words">
                            {t('authority.roles.domain')}: {role.domain}
                          </span>
                        )}
                      </div>
                      <div className="text-[0.6875rem] text-muted-foreground">
                        {t('authority.roles.grantsCount', { count: role.grants })}
                      </div>
                    </div>
                  ))}

                {roles.map((role) => (
                  <div
                    key={role.id}
                    className="space-y-1.5 rounded-md border border-border/60 p-2 min-w-0"
                    data-testid={`authority-role-${role.id}`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <span className="text-xs font-medium text-foreground break-words">
                        {role.displayName || role.id}
                      </span>
                      {role.displayName && (
                        <span className="font-mono text-[0.6875rem] text-muted-foreground break-all">
                          {role.id}
                        </span>
                      )}
                      {role.domain && (
                        <span className="text-[0.6875rem] text-muted-foreground break-words">
                          {t('authority.roles.domain')}: {role.domain}
                        </span>
                      )}
                    </div>
                    {role.grants.length === 0 ? (
                      <div className="text-[0.6875rem] text-muted-foreground">
                        {t('authority.roles.noGrants')}
                      </div>
                    ) : (
                      <ul className="space-y-1" data-testid={`authority-grants-${role.id}`}>
                        {role.grants.map((grant, index) => (
                          <li
                            key={`${grant.action}-${grant.targetPattern}-${index}`}
                            className="flex flex-wrap items-center gap-1.5 min-w-0"
                          >
                            <span className="font-mono text-[0.6875rem] text-foreground break-all">
                              {grant.action}
                            </span>
                            <span className="text-[0.6875rem] text-muted-foreground">×</span>
                            <span className="font-mono text-[0.6875rem] text-muted-foreground break-all">
                              {grant.targetPattern}
                            </span>
                            <span
                              className={cn(
                                'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium',
                                EFFECT_CLASS[grant.effect] ?? 'bg-muted text-muted-foreground',
                              )}
                              data-testid={`authority-grant-effect-${role.id}-${index}`}
                            >
                              {t(`authority.effect.${grant.effect}`)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </li>
            )
          })}
        </ul>
      </SettingsSection>

      {/* 4. Привязки агентов к ролям. */}
      <SettingsSection
        id="authority-agents"
        title={t('authority.agents.title')}
        description={t('authority.agents.description')}
      >
        {!loading && authorityPacks.every((entry) => (entry.content?.agents.length ?? 0) === 0) && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="authority-agents-empty"
          >
            <Icon name="robot-2" className="size-6 opacity-40" />
            <p className="text-xs">{t('authority.agents.empty')}</p>
          </div>
        )}

        <ul className="space-y-2 min-w-0" data-testid="authority-agents-list">
          {authorityPacks.map((entry) =>
            (entry.content?.agents ?? []).map((agent) => (
              <li
                key={`${entry.pack.name}-${agent.id}`}
                data-testid={`authority-agent-${agent.id}`}
                className="space-y-1.5 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0"
              >
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="text-sm font-medium text-foreground break-words">{agent.id}</span>
                  <span className="text-[0.6875rem] text-muted-foreground break-words">
                    {t('authority.agents.source')}: {entry.pack.name}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="text-[0.6875rem] text-muted-foreground shrink-0">
                    {t('authority.agents.roles')}
                  </span>
                  {agent.roles.length === 0 ? (
                    <span className="text-[0.6875rem] text-muted-foreground">—</span>
                  ) : (
                    agent.roles.map((role) => (
                      <span
                        key={role}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] text-foreground break-all"
                      >
                        {role}
                      </span>
                    ))
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="text-[0.6875rem] text-muted-foreground shrink-0">
                    {t('authority.agents.ceiling')}
                  </span>
                  {agent.ceiling.length === 0 ? (
                    <span className="text-[0.6875rem] text-muted-foreground">—</span>
                  ) : (
                    agent.ceiling.map((action) => (
                      <span
                        key={action}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] text-foreground break-all"
                      >
                        {action}
                      </span>
                    ))
                  )}
                </div>
              </li>
            )),
          )}
        </ul>
      </SettingsSection>
    </SettingsPanel>
  )
}
