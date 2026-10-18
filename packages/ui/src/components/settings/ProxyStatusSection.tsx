import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  synthApi,
  type ProxyPasswordStatus,
  type ProxySettingsResponse,
  type ProxyStatusInfo,
} from '@/lib/api/synthApi';
import { useI18n } from '@/lib/i18n';
import { useNotification } from '@/hooks/useNotification';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { Icon } from '../icon/Icon';
import { Button } from '../ui/button';
import {
  ListField,
  NumberField,
  SelectField,
  SettingsActions,
  SettingsRow,
  SettingsSection,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings';
import { SelectContent, SelectItem } from '../ui/select';
import { ProxyProfilesSection } from './ProxyProfilesSection';
import { ProxyRouteCheck } from './ProxyRouteCheck';
import { ProxyRulesSection } from './ProxyRulesSection';
import {
  pendingProfilePasswords,
  proxyDraftToInput,
  statusToDraft,
  validateProxyDraft,
  type ProxyDraft,
  type ProxyDraftIssue,
} from './proxy-draft';

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium';

const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined;

/** Сохраняет пароли профилей из прежнего saved-статуса (PUT их не возвращает). */
function mergeProfilePasswords(
  previous: ProxyStatusInfo | undefined,
  next: ProxyStatusInfo,
): ProxyStatusInfo {
  const profiles: ProxyStatusInfo['profiles'] = {};
  for (const [name, profile] of Object.entries(next.profiles ?? {})) {
    const password = profile.password ?? previous?.profiles?.[name]?.password;
    profiles[name] = password ? { ...profile, password } : profile;
  }
  return { ...next, profiles };
}

function StatusSummary({ status, testId }: { status: ProxyStatusInfo; testId: string }) {
  const { t } = useI18n();
  const mode = status.mode ?? 'all';
  const profileCount = Object.keys(status.profiles ?? {}).length;
  return (
    <div className="space-y-2 min-w-0" data-testid={testId}>
      <SettingsRow
        label={t('proxy.enabled')}
        control={
          <span
            data-testid={`${testId}-enabled`}
            className={cn(
              BADGE,
              status.enabled
                ? 'bg-status-success/15 text-status-success'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {status.enabled ? t('proxy.enabled') : t('proxy.disabled')}
          </span>
        }
      />
      <SettingsRow
        label={t('proxy.source')}
        control={
          <span data-testid={`${testId}-source`} className="text-sm text-foreground">
            {t(`proxy.source.${status.source}`)}
          </span>
        }
      />
      <SettingsRow
        label={t('proxy.status.mode')}
        control={
          <span data-testid={`${testId}-mode`} className="text-sm text-foreground">
            {t(`proxy.mode.${mode}`)}
          </span>
        }
      />
      <SettingsRow
        label={t('proxy.status.profiles')}
        control={
          <span data-testid={`${testId}-profiles`} className="text-sm text-foreground">
            {profileCount}
          </span>
        }
      />
      {status.defaultProfile && (
        <SettingsRow
          label={t('proxy.status.defaultProfile')}
          control={
            <span
              data-testid={`${testId}-default-profile`}
              className="font-mono text-sm text-foreground"
            >
              {status.defaultProfile}
            </span>
          }
        />
      )}
      {(status.url || status.httpProxy || status.httpsProxy || status.allProxy) && (
        <SettingsRow
          label={t('proxy.url')}
          control={
            <span
              data-testid={`${testId}-url`}
              className="max-w-full break-all font-mono text-xs text-foreground"
            >
              {status.url ?? status.httpsProxy ?? status.httpProxy ?? status.allProxy}
            </span>
          }
        />
      )}
    </div>
  );
}

/**
 * ADR-099 / ADR-072: редактор egress-прокси (админ-категория «Сеть»).
 *
 * Профили + маршрутизация вместо legacy-формы:
 * - режим `all`/`selected`, default-профиль, правила (порядок = приоритет);
 * - пароль и TLS/mTLS к прокси — write-only endpoint'ами, значения не видны;
 *   пароль нового профиля применяется сразу после `PUT /settings/proxy`;
 * - legacy-плоская конфигурация синтезируется в профиль `default`;
 * - сохранение отправляет `profiles`/`rules`/`mode`/`defaultProfile`
 *   (top-level `url`/`auth`/`tls` запрещены сервером в этом режиме);
 * - проверка target URL — по saved-конфигурации (`POST /settings/proxy/test`).
 */
export function ProxyStatusSection() {
  const { t } = useI18n();
  const { notify } = useNotification();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);

  const [info, setInfo] = useState<ProxySettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setInfo(await synthApi.getProxy());
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : 'HTTP';
      setLoadError(t('proxy.error', { error: message }));
      notify({
        text: t('proxy.error', { error: message }),
        type: 'error',
        category: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [notify, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Мемоизируем: `useSettingsDraft` сравнивает value по идентичности в эффекте.
  const savedDraft = useMemo(() => (info ? statusToDraft(info.saved) : null), [info]);
  const defaultsDraft = useMemo(() => (info ? statusToDraft(info.defaults) : null), [info]);

  const draft = useSettingsDraft<ProxyDraft>({
    value: savedDraft,
    defaultValue: defaultsDraft,
  });
  const current = draft.draft;
  const issues = useMemo(() => (current ? validateProxyDraft(current) : []), [current]);

  const issueText = (issue: ProxyDraftIssue): string => {
    switch (issue.kind) {
      case 'timeout':
        return t('proxy.form.connectTimeoutInvalid');
      case 'noProfiles':
        return t('proxy.form.noProfiles');
      case 'profileName':
        return t('proxy.profiles.nameInvalidFor', { name: issue.name });
      case 'profileUrl':
        return t('proxy.profiles.urlRequiredFor', { name: issue.name });
      case 'defaultProfile':
        return t('proxy.form.defaultProfileRequired');
      case 'selectedNoRules':
        return t('proxy.mode.selectedNoRules');
      case 'ruleHosts':
        return t('proxy.rules.hostsRequiredFor', { index: issue.index + 1 });
      case 'ruleProfile':
        return t('proxy.rules.profileRequiredFor', { index: issue.index + 1 });
    }
  };

  const handleSave = async () => {
    if (!current) return;
    setSaving(true);
    try {
      const input = proxyDraftToInput(current);
      const resp = await synthApi.saveProxy(input);
      let saved = mergeProfilePasswords(info?.saved, resp.saved);

      // Пароли новых профилей: write-only endpoint принимает их только после
      // того, как профиль появился в saved-конфиге. Ошибка одного профиля не
      // отменяет сохранение остальных настроек и не блокирует другие пароли.
      const passwordErrors: string[] = [];
      for (const { name, password } of pendingProfilePasswords(current)) {
        try {
          const status = await synthApi.setProfilePassword(name, password);
          const profile = saved.profiles?.[name];
          if (profile) {
            saved = {
              ...saved,
              profiles: { ...saved.profiles, [name]: { ...profile, password: status } },
            };
          }
        } catch (e) {
          const status = statusOf(e);
          const message =
            status === 409
              ? t('proxy.password.envConflictGeneric')
              : status === 404
                ? t('proxy.profiles.notFound')
                : e instanceof Error && e.message
                  ? e.message
                  : 'HTTP';
          passwordErrors.push(t('proxy.password.pendingError', { name, error: message }));
        }
      }

      draft.setDraft(statusToDraft(saved));
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              ...saved,
              saved,
              running: resp.running,
              restartRequired: resp.restartRequired,
              isOverridden: true,
              password: saved.profiles.default?.password ?? prev.password,
            }
          : prev,
      );
      if (passwordErrors.length > 0) {
        for (const text of passwordErrors) {
          notify({ text, type: 'error', category: 'error' });
        }
      } else {
        notify({ text: t('proxy.savedToast'), type: 'success', category: 'system' });
      }
    } catch (e) {
      notify({
        text: t('proxy.saveError', { error: e instanceof Error && e.message ? e.message : 'HTTP' }),
        type: 'error',
        category: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      const resp = await synthApi.resetProxy();
      const saved = mergeProfilePasswords(info?.saved, resp.saved);
      const defaults = mergeProfilePasswords(info?.defaults, resp.defaults);
      draft.setDraft(statusToDraft(saved));
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              ...saved,
              saved,
              defaults,
              running: resp.running,
              restartRequired: resp.restartRequired,
              isOverridden: false,
              password: saved.profiles.default?.password ?? prev.password,
            }
          : prev,
      );
      notify({ text: t('proxy.resetToast'), type: 'success', category: 'system' });
    } catch (e) {
      notify({
        text: t('proxy.resetError', {
          error: e instanceof Error && e.message ? e.message : 'HTTP',
        }),
        type: 'error',
        category: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordChanged = (name: string, password: ProxyPasswordStatus) => {
    setInfo((prev) => {
      if (!prev) return prev;
      const profile = prev.saved.profiles?.[name];
      if (!profile) return prev;
      const profiles = { ...prev.saved.profiles, [name]: { ...profile, password } };
      const saved = { ...prev.saved, profiles };
      return {
        ...prev,
        ...saved,
        saved,
        profiles,
        password: name === 'default' ? password : prev.password,
      };
    });
  };

  const handleTlsChanged = (name: string, status: ProxyStatusInfo, restartRequired: boolean) => {
    const saved = mergeProfilePasswords(info?.saved, status);
    const profile = saved.profiles?.[name];
    if (profile) {
      draft.setDraft((prev) => {
        if (!prev) return prev;
        const currentProfile = prev.profiles[name];
        if (!currentProfile) return prev;
        return {
          ...prev,
          profiles: {
            ...prev.profiles,
            [name]: {
              ...currentProfile,
              tlsCaFile: profile.tls?.caFile ?? '',
              tlsCertFile: profile.tls?.certFile ?? '',
              tlsKeyFile: profile.tls?.keyFile ?? '',
              rejectUnauthorized: profile.tls?.rejectUnauthorized ?? true,
            },
          },
        };
      });
    }
    setInfo((prev) =>
      prev
        ? {
            ...prev,
            ...saved,
            saved,
            profiles: saved.profiles,
            restartRequired,
            isOverridden: true,
          }
        : prev,
    );
  };

  const profileNames = current ? Object.keys(current.profiles) : [];
  const profileItems = profileNames.map((name) => ({ value: name, label: name }));

  return (
    <SettingsSection title={t('proxy.title')} description={t('proxy.description')}>
      <div className="space-y-3 min-w-0" data-testid="proxy-status-section">
        {loading && !info && (
          <div className="text-center text-muted-foreground py-4 text-sm">
            {t('common.loading')}
          </div>
        )}

        {loadError && (
          <div
            role="alert"
            data-testid="proxy-status-error"
            className="p-2 rounded-lg bg-destructive/10 text-destructive text-sm"
          >
            {loadError}
          </div>
        )}

        {info && (
          <>
            {/* Статус: running vs saved */}
            <div className="space-y-2 min-w-0 rounded-lg border border-border/60 bg-surface-inset p-3">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('proxy.status.running')}
                </span>
              </div>
              <StatusSummary status={info.running} testId="proxy-status-running" />

              <div className="flex items-center justify-between gap-2 min-w-0 border-t border-border/60 pt-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('proxy.status.saved')}
                </span>
                <span
                  data-testid="proxy-status-overridden"
                  className={cn(
                    BADGE,
                    info.isOverridden
                      ? 'bg-status-info/15 text-status-info'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {info.isOverridden ? t('proxy.status.overridden') : t('proxy.status.default')}
                </span>
              </div>
              <StatusSummary status={info.saved} testId="proxy-status-saved" />
            </div>

            {info.restartRequired && (
              <div
                data-testid="proxy-status-restart"
                className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-status-warning/10 p-2 text-xs text-status-warning"
              >
                <span className="flex min-w-0 items-start gap-2">
                  <Icon name="refresh" className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{t('proxy.restartRequired')}</span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setSettingsPage('maintenance')}
                  data-testid="proxy-restart-goto"
                >
                  {t('proxy.restart.action')}
                </Button>
              </div>
            )}

            {/* Форма runtime-override: профили + маршрутизация */}
            {current && (
              <div className="space-y-3 min-w-0 rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="text-sm font-medium text-foreground">{t('proxy.form.title')}</div>
                  {draft.dirty && (
                    <span className="text-xs text-status-warning">{t('proxy.form.unsaved')}</span>
                  )}
                </div>

                <ToggleField
                  label={t('proxy.form.enabled')}
                  description={t('proxy.form.enabledHint')}
                  enabled={current.enabled}
                  onToggle={() =>
                    draft.setDraft((prev) => (prev ? { ...prev, enabled: !prev.enabled } : prev))
                  }
                />

                <SelectField
                  label={t('proxy.mode.title')}
                  description={t(`proxy.mode.${current.mode}Hint`)}
                  value={current.mode}
                  onValueChange={(value) =>
                    draft.setDraft((prev) =>
                      prev ? { ...prev, mode: value === 'selected' ? 'selected' : 'all' } : prev,
                    )
                  }
                  items={[
                    { value: 'all', label: t('proxy.mode.all') },
                    { value: 'selected', label: t('proxy.mode.selected') },
                  ]}
                  triggerTestId="proxy-mode-select"
                >
                  <SelectContent>
                    <SelectItem value="all">{t('proxy.mode.all')}</SelectItem>
                    <SelectItem value="selected">{t('proxy.mode.selected')}</SelectItem>
                  </SelectContent>
                </SelectField>

                {current.mode === 'selected' && current.rules.length === 0 && (
                  <div
                    role="alert"
                    data-testid="proxy-mode-selected-warning"
                    className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-2 text-xs text-status-warning"
                  >
                    <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{t('proxy.mode.selectedNoRules')}</span>
                  </div>
                )}

                <SelectField
                  label={t('proxy.defaultProfile')}
                  description={t('proxy.defaultProfileHelp')}
                  value={current.profiles[current.defaultProfile] ? current.defaultProfile : ''}
                  onValueChange={(value) =>
                    draft.setDraft((prev) => (prev ? { ...prev, defaultProfile: value } : prev))
                  }
                  items={profileItems}
                  disabled={profileNames.length === 0}
                  triggerTestId="proxy-default-profile"
                >
                  <SelectContent>
                    {profileItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectField>

                <ProxyProfilesSection
                  draft={current}
                  setDraft={draft.setDraft}
                  status={info.saved}
                  onPasswordChanged={handlePasswordChanged}
                  onTlsChanged={handleTlsChanged}
                />

                <ProxyRulesSection draft={current} setDraft={draft.setDraft} />

                <ListField
                  label={t('proxy.form.noProxy')}
                  description={t('proxy.form.noProxyHelp')}
                  values={current.noProxy}
                  onChange={(noProxy) =>
                    draft.setDraft((prev) => (prev ? { ...prev, noProxy } : prev))
                  }
                  placeholder="10.0.0.0/8"
                  variant="chips"
                />

                <ToggleField
                  label={t('proxy.form.fromEnv')}
                  description={t('proxy.form.fromEnvHelp')}
                  enabled={current.fromEnv}
                  onToggle={() =>
                    draft.setDraft((prev) => (prev ? { ...prev, fromEnv: !prev.fromEnv } : prev))
                  }
                />

                <ToggleField
                  label={t('proxy.fallbackDirect')}
                  description={t('proxy.fallbackDirectHint')}
                  enabled={current.fallbackDirect}
                  onToggle={() =>
                    draft.setDraft((prev) =>
                      prev ? { ...prev, fallbackDirect: !prev.fallbackDirect } : prev,
                    )
                  }
                />

                {current.fallbackDirect && (
                  <div
                    role="alert"
                    data-testid="proxy-form-fallback-warning"
                    className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-2 text-xs text-status-warning"
                  >
                    <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{t('proxy.fallbackDirectHint')}</span>
                  </div>
                )}

                <NumberField
                  label={t('proxy.form.connectTimeout')}
                  value={Number.isFinite(current.connectTimeoutMs) ? current.connectTimeoutMs : 0}
                  min={1}
                  suffix="ms"
                  onChange={(e) =>
                    draft.setDraft((prev) =>
                      prev
                        ? {
                            ...prev,
                            connectTimeoutMs: Number.isFinite(e.target.valueAsNumber)
                              ? e.target.valueAsNumber
                              : 0,
                          }
                        : prev,
                    )
                  }
                  data-testid="proxy-form-timeout"
                />

                {issues.length > 0 && (
                  <div
                    role="alert"
                    data-testid="proxy-form-errors"
                    className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
                  >
                    <ul className="list-disc space-y-0.5 pl-4">
                      {issues.map((issue, index) => (
                        <li key={`${issue.kind}-${index}`} className="min-w-0 break-words">
                          {issueText(issue)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <SettingsActions
                  onSave={() => void handleSave()}
                  onCancel={() => draft.revert()}
                  onReset={() => void handleReset()}
                  saveDisabled={loading || !draft.dirty || issues.length > 0}
                  cancelDisabled={!draft.dirty}
                  resetDisabled={loading}
                  isDefault={draft.isDefault}
                  saving={saving}
                  saveTestId="proxy-save"
                  cancelTestId="proxy-cancel"
                  resetTestId="proxy-reset"
                />
              </div>
            )}

            <ProxyRouteCheck disabled={loading} />
          </>
        )}
      </div>
    </SettingsSection>
  );
}
