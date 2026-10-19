import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';

import {
  synthApi,
  type ProxyPasswordStatus,
  type ProxyStatusInfo,
  type ProxyTlsMutationResponse,
  type TlsValidateResult,
} from '@/lib/api/synthApi';
import { useI18n } from '@/lib/i18n';
import { useNotification } from '@/hooks/useNotification';
import { confirm } from '@/lib/confirm';
import { cn } from '@/lib/utils';
import { Icon } from '../icon/Icon';
import { Button } from '../ui/button';
import { FieldTooltip, TextArea, TextField, ToggleField } from '../ui/settings';
import {
  displayProfileUrl,
  emptyProfileDraft,
  isValidProfileName,
  profileUsage,
  type ProxyDraft,
  type ProxyProfileDraft,
} from './proxy-draft';

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium';
const FILE_INPUT =
  'block w-full min-w-0 text-xs text-muted-foreground file:mr-2 file:cursor-pointer file:rounded-lg file:border file:border-border file:bg-interactive-hover file:px-2 file:py-1 file:text-xs file:text-foreground';

interface ProfileFormState {
  name: string;
  label: string;
  url: string;
  username: string;
  tlsCaFile: string;
  tlsCertFile: string;
  tlsKeyFile: string;
  rejectUnauthorized: boolean;
}

function formFromDraft(name: string, profile: ProxyProfileDraft | undefined): ProfileFormState {
  return {
    name,
    label: profile?.label ?? '',
    url: displayProfileUrl(profile),
    username: profile?.username ?? '',
    tlsCaFile: profile?.tlsCaFile ?? '',
    tlsCertFile: profile?.tlsCertFile ?? '',
    tlsKeyFile: profile?.tlsKeyFile ?? '',
    rejectUnauthorized: profile?.rejectUnauthorized ?? true,
  };
}

/** Применяет форму к черновику, сохраняя скрытые legacy-поля схем, если URL не менялся. */
function applyForm(
  form: ProfileFormState,
  existing: ProxyProfileDraft | undefined,
): ProxyProfileDraft {
  const base: ProxyProfileDraft = existing ? { ...existing } : emptyProfileDraft();
  const url = form.url.trim();
  const previousUrl = displayProfileUrl(existing);
  if (!existing || url !== previousUrl) {
    // URL изменился — legacy-поля схем больше не актуальны.
    base.url = url;
    delete (base as Partial<ProxyProfileDraft>).httpProxy;
    delete (base as Partial<ProxyProfileDraft>).httpsProxy;
    delete (base as Partial<ProxyProfileDraft>).allProxy;
  }
  base.label = form.label.trim();
  base.username = form.username.trim();
  base.tlsCaFile = form.tlsCaFile.trim();
  base.tlsCertFile = form.tlsCertFile.trim();
  base.tlsKeyFile = form.tlsKeyFile.trim();
  base.rejectUnauthorized = form.rejectUnauthorized;
  return base;
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read error'));
    reader.readAsText(file);
  });
}

async function readPemFiles(files: FileList | null): Promise<string> {
  if (!files || files.length === 0) return '';
  const parts = await Promise.all([...files].map(readFileText));
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined;

interface ProxyProfilesSectionProps {
  draft: ProxyDraft;
  setDraft: (updater: (prev: ProxyDraft) => ProxyDraft) => void;
  status: ProxyStatusInfo;
  onPasswordChanged: (name: string, password: ProxyPasswordStatus) => void;
  onTlsChanged: (name: string, status: ProxyStatusInfo, restartRequired: boolean) => void;
  disabled?: boolean;
}

/**
 * ADR-099 / ADR-072: профили egress-прокси.
 *
 * Имя неизменяемо, URL — один (legacy `httpProxy/httpsProxy/allProxy` скрыто
 * сохраняются, если URL не меняли). Пароль и TLS/mTLS применяются сразу
 * write-only endpoint'ами (значения после сохранения не отображаются).
 */
export function ProxyProfilesSection({
  draft,
  setDraft,
  status,
  onPasswordChanged,
  onTlsChanged,
  disabled = false,
}: ProxyProfilesSectionProps) {
  const { t } = useI18n();
  const { notify } = useNotification();

  /** Понятное сообщение для 404/409 (остальное — текст сервера). */
  const mutationMessage = (err: unknown): string => {
    const status = statusOf(err);
    if (status === 409) return t('proxy.password.envConflictGeneric');
    if (status === 404) return t('proxy.profiles.notFound');
    return err instanceof Error && err.message ? err.message : 'HTTP';
  };

  const [editing, setEditing] = useState<string | '__new__' | null>(null);
  const [form, setForm] = useState<ProfileFormState>(formFromDraft('', undefined));
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [caPem, setCaPem] = useState('');
  const [clientCertPem, setClientCertPem] = useState('');
  const [clientKeyPem, setClientKeyPem] = useState('');
  const [tlsPending, setTlsPending] = useState(false);
  const [tlsError, setTlsError] = useState<string | null>(null);
  const [tlsValidate, setTlsValidate] = useState<TlsValidateResult | null>(null);
  /** Секция TLS/mTLS свёрнута по умолчанию; ошибка проверки/загрузки раскрывает её. */
  const [tlsOpen, setTlsOpen] = useState(false);

  useEffect(() => {
    if (tlsError || (tlsValidate && !tlsValidate.ok)) setTlsOpen(true);
  }, [tlsError, tlsValidate]);

  const names = Object.keys(draft.profiles);

  const openAdd = () => {
    setEditing('__new__');
    setDeleteError(null);
    setForm(formFromDraft('', undefined));
    setFormError(null);
    setPassword('');
    setPasswordError(null);
    setCaPem('');
    setClientCertPem('');
    setClientKeyPem('');
    setTlsError(null);
    setTlsValidate(null);
    setTlsOpen(false);
  };

  const openEdit = (name: string) => {
    setEditing(name);
    setDeleteError(null);
    setForm(formFromDraft(name, draft.profiles[name]));
    setFormError(null);
    setPassword('');
    setPasswordError(null);
    setCaPem('');
    setClientCertPem('');
    setClientKeyPem('');
    setTlsError(null);
    setTlsValidate(null);
    setTlsOpen(false);
  };

  const closeForm = () => {
    setEditing(null);
    setFormError(null);
    setPassword('');
    setPasswordError(null);
    setCaPem('');
    setClientCertPem('');
    setClientKeyPem('');
    setTlsError(null);
    setTlsValidate(null);
    setTlsOpen(false);
  };

  const submitForm = () => {
    const name = form.name.trim();
    if (!isValidProfileName(name)) {
      setFormError(t('proxy.profiles.nameInvalid'));
      return;
    }
    const isNew = editing === '__new__';
    if (isNew && draft.profiles[name]) {
      setFormError(t('proxy.profiles.exists'));
      return;
    }
    if (!form.url.trim()) {
      setFormError(t('proxy.profiles.urlRequired'));
      return;
    }
    const existing = isNew ? undefined : draft.profiles[name];
    const next = applyForm(form, existing);
    // Профиль, которого ещё нет в saved-статусе, сервер примет только после
    // PUT /settings/proxy — пароль такого профиля тоже держим в черновике.
    const deferPassword = isNew || !status.profiles?.[name];
    if (isNew) {
      // Пароль и TLS-материалы нового профиля принимаются только после
      // PUT /settings/proxy — запоминаем их в клиентском черновике.
      if (password.trim()) next.pendingPassword = password;
      else delete next.pendingPassword;

      const hasCert = clientCertPem.trim() !== '';
      const hasKey = clientKeyPem.trim() !== '';
      if (hasCert !== hasKey) {
        setFormError(t('proxy.tls.clientPairRequired'));
        return;
      }
      if (caPem.trim()) next.pendingCaPem = caPem.trim();
      else delete next.pendingCaPem;
      if (hasCert && hasKey) {
        next.pendingClientCertPem = clientCertPem.trim();
        next.pendingClientKeyPem = clientKeyPem.trim();
      } else {
        delete next.pendingClientCertPem;
        delete next.pendingClientKeyPem;
      }
    } else if (deferPassword && password.trim()) {
      next.pendingPassword = password;
    }
    setDraft((prev) => {
      const profiles = { ...prev.profiles, [name]: next };
      // Первый профиль автоматически становится default-профилем.
      const defaultProfile = profiles[prev.defaultProfile] ? prev.defaultProfile : name;
      return { ...prev, profiles, defaultProfile };
    });
    if (deferPassword) setPassword('');
    if (isNew) {
      setCaPem('');
      setClientCertPem('');
      setClientKeyPem('');
    }
    setTlsValidate(null);
    setTlsError(null);
    setTlsOpen(false);
    setEditing(null);
    setFormError(null);
  };

  const handleDelete = async (name: string) => {
    setDeleteError(null);
    const usage = profileUsage(draft, name);
    if (usage.isDefault) {
      setDeleteError(t('proxy.profiles.deleteBlockedDefault', { name }));
      return;
    }
    if (usage.rules.length > 0) {
      setDeleteError(
        t('proxy.profiles.deleteBlockedRules', { name, rules: usage.rules.join(', ') }),
      );
      return;
    }
    const ok = await confirm({
      title: t('proxy.profiles.deleteConfirmTitle'),
      message: t('proxy.profiles.deleteConfirmMessage', { name }),
      variant: 'warning',
    });
    if (!ok) return;
    setDeleteError(null);
    setDraft((prev) => {
      const profiles = { ...prev.profiles };
      delete profiles[name];
      return { ...prev, profiles };
    });
  };

  const serverProfile = editing && editing !== '__new__' ? status.profiles?.[editing] : undefined;
  const profilePassword = serverProfile?.password;
  const passwordFromEnv = profilePassword?.source === 'env';
  const tlsMeta = serverProfile?.tls;

  const handleSetPassword = async () => {
    if (!editing || editing === '__new__') return;
    if (!password.trim()) {
      setPasswordError(t('proxy.password.required'));
      return;
    }
    setPasswordPending(true);
    setPasswordError(null);
    try {
      const next = await synthApi.setProfilePassword(editing, password);
      onPasswordChanged(editing, next);
      setPassword('');
      notify({ text: t('proxy.password.setSuccess'), type: 'success', category: 'system' });
    } catch (e) {
      const message = mutationMessage(e);
      setPasswordError(message);
      notify({ text: message, type: 'error', category: 'error' });
    } finally {
      setPasswordPending(false);
    }
  };

  const handleClearPassword = async () => {
    if (!editing || editing === '__new__') return;
    if (passwordFromEnv) return;
    const ok = await confirm({
      title: t('proxy.password.clearConfirmTitle'),
      message: t('proxy.password.clearConfirmMessage'),
      variant: 'warning',
    });
    if (!ok) return;
    setPasswordPending(true);
    setPasswordError(null);
    try {
      const next = await synthApi.clearProfilePassword(editing);
      onPasswordChanged(editing, next);
      setPassword('');
      notify({ text: t('proxy.password.clearSuccess'), type: 'success', category: 'system' });
    } catch (e) {
      const message = mutationMessage(e);
      setPasswordError(message);
      notify({ text: message, type: 'error', category: 'error' });
    } finally {
      setPasswordPending(false);
    }
  };

  const applyTlsResponse = (name: string, response: ProxyTlsMutationResponse): void => {
    const saved = response.status.profiles?.[name];
    if (saved) {
      setForm((prev) => ({
        ...prev,
        tlsCaFile: saved.tls?.caFile ?? '',
        tlsCertFile: saved.tls?.certFile ?? '',
        tlsKeyFile: saved.tls?.keyFile ?? '',
        rejectUnauthorized: saved.tls?.rejectUnauthorized ?? true,
      }));
    }
    onTlsChanged(name, response.status, response.restartRequired);
  };

  const handleTlsFiles = async (
    event: ChangeEvent<HTMLInputElement>,
    apply: (pem: string) => void,
  ) => {
    try {
      const pem = await readPemFiles(event.target.files);
      if (pem) apply(pem);
    } catch (e) {
      setTlsError(e instanceof Error ? e.message : String(e));
    } finally {
      event.target.value = '';
    }
  };

  const validateCa = async (): Promise<boolean> => {
    if (!caPem.trim()) {
      setTlsError(t('proxy.tls.required'));
      return false;
    }
    setTlsPending(true);
    setTlsError(null);
    setTlsValidate(null);
    try {
      const result = await synthApi.validateTls({ caPem });
      setTlsValidate(result);
      if (!result.ok) setTlsError(result.errors.join('; ') || t('proxy.tls.checkFailed'));
      return result.ok;
    } catch (e) {
      setTlsError(mutationMessage(e));
      return false;
    } finally {
      setTlsPending(false);
    }
  };

  const uploadCa = async () => {
    if (!editing || editing === '__new__' || !caPem.trim()) return;
    if (!(await validateCa())) return;
    setTlsPending(true);
    try {
      applyTlsResponse(editing, await synthApi.uploadProfileCa(editing, caPem));
      setCaPem('');
      setTlsValidate(null);
      notify({ text: t('proxy.tls.saved'), type: 'success', category: 'system' });
    } catch (e) {
      setTlsError(mutationMessage(e));
    } finally {
      setTlsPending(false);
    }
  };

  const removeCa = async () => {
    if (!editing || editing === '__new__') return;
    const ok = await confirm({
      title: t('proxy.tls.removeCaConfirmTitle'),
      message: t('proxy.tls.removeCaConfirmMessage', { name: editing }),
      variant: 'warning',
    });
    if (!ok) return;
    setTlsPending(true);
    setTlsError(null);
    try {
      applyTlsResponse(editing, await synthApi.removeProfileCa(editing));
      setCaPem('');
      setTlsValidate(null);
      notify({ text: t('proxy.tls.saved'), type: 'success', category: 'system' });
    } catch (e) {
      setTlsError(mutationMessage(e));
    } finally {
      setTlsPending(false);
    }
  };

  const validateClient = async (): Promise<boolean> => {
    if (!clientCertPem.trim() || !clientKeyPem.trim()) {
      setTlsError(t('proxy.tls.required'));
      return false;
    }
    setTlsPending(true);
    setTlsError(null);
    setTlsValidate(null);
    try {
      const result = await synthApi.validateTls({ certPem: clientCertPem, keyPem: clientKeyPem });
      setTlsValidate(result);
      if (!result.ok) setTlsError(result.errors.join('; ') || t('proxy.tls.checkFailed'));
      return result.ok;
    } catch (e) {
      setTlsError(mutationMessage(e));
      return false;
    } finally {
      setTlsPending(false);
    }
  };

  const uploadClient = async () => {
    if (!editing || editing === '__new__') return;
    if (!(await validateClient())) return;
    setTlsPending(true);
    try {
      applyTlsResponse(
        editing,
        await synthApi.uploadProfileClient(editing, clientCertPem, clientKeyPem),
      );
      setClientCertPem('');
      setClientKeyPem('');
      setTlsValidate(null);
      notify({ text: t('proxy.tls.saved'), type: 'success', category: 'system' });
    } catch (e) {
      setTlsError(mutationMessage(e));
    } finally {
      setTlsPending(false);
    }
  };

  const removeClient = async () => {
    if (!editing || editing === '__new__') return;
    const ok = await confirm({
      title: t('proxy.tls.removeClientConfirmTitle'),
      message: t('proxy.tls.removeClientConfirmMessage', { name: editing }),
      variant: 'danger',
    });
    if (!ok) return;
    setTlsPending(true);
    setTlsError(null);
    try {
      applyTlsResponse(editing, await synthApi.removeProfileClient(editing));
      setClientCertPem('');
      setClientKeyPem('');
      setTlsValidate(null);
      notify({ text: t('proxy.tls.saved'), type: 'success', category: 'system' });
    } catch (e) {
      setTlsError(mutationMessage(e));
    } finally {
      setTlsPending(false);
    }
  };

  const renderForm = (isNew: boolean) => (
    <div
      className="space-y-3 min-w-0 rounded-lg border border-border/60 bg-surface-inset p-3"
      data-testid="proxy-profile-form"
    >
      <div className="text-sm font-medium text-foreground">
        {isNew ? t('proxy.profiles.addTitle') : t('proxy.profiles.editTitle', { name: form.name })}
      </div>

      <TextField
        label={t('proxy.profiles.name')}
        description={t('proxy.profiles.nameHelp')}
        value={form.name}
        onChange={(e) => {
          setForm((prev) => ({ ...prev, name: e.target.value }));
          if (formError) setFormError(null);
        }}
        disabled={!isNew || disabled}
        mono
        placeholder="corp"
        tooltip={t('settings.help.network.profileName')}
        data-testid="proxy-profile-form-name"
      />
      <TextField
        label={t('proxy.profiles.label')}
        value={form.label}
        onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))}
        placeholder={t('proxy.profiles.labelPlaceholder')}
        disabled={disabled}
        tooltip={t('settings.help.network.profileLabel')}
        data-testid="proxy-profile-form-label"
      />
      <TextField
        label={t('proxy.profiles.url')}
        description={t('proxy.profiles.urlHelp')}
        value={form.url}
        onChange={(e) => {
          setForm((prev) => ({ ...prev, url: e.target.value }));
          if (formError) setFormError(null);
        }}
        placeholder="http://proxy.corp:3128"
        mono
        disabled={disabled}
        tooltip={t('settings.help.network.profileUrl')}
        data-testid="proxy-profile-form-url"
      />
      {/* ADR-099 / ADR-072: единый auth-блок — логин и пароль Basic-аутентификации. */}
      <div
        className="space-y-2 min-w-0 rounded-lg border border-border/60 p-3"
        data-testid="proxy-profile-auth"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="text-sm font-medium text-foreground">{t('proxy.profiles.authTitle')}</div>
          <FieldTooltip text={t('settings.help.network.profileAuth')} />
        </div>
        <p className="text-xs text-muted-foreground">{t('proxy.profiles.authHelp')}</p>

        <TextField
          label={t('proxy.profiles.username')}
          value={form.username}
          onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
          autoComplete="off"
          disabled={disabled}
          tooltip={t('settings.help.network.profileUsername')}
          data-testid="proxy-profile-form-username"
        />

        <TextField
          label={t('proxy.password.placeholder')}
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (passwordError) setPasswordError(null);
          }}
          autoComplete="new-password"
          disabled={disabled || passwordPending || passwordFromEnv}
          tooltip={t('settings.help.network.profilePassword')}
          data-testid="proxy-profile-password-input"
        />

        {serverProfile && (
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => void handleSetPassword()}
              disabled={passwordFromEnv || passwordPending || disabled || !password.trim()}
              data-testid="proxy-profile-password-set"
            >
              {t('proxy.password.set')}
            </Button>
            <Button
              variant="outline-muted"
              className="shrink-0"
              onClick={() => void handleClearPassword()}
              disabled={passwordFromEnv || passwordPending || disabled || !profilePassword?.set}
              data-testid="proxy-profile-password-clear"
            >
              {t('proxy.password.clear')}
            </Button>
          </div>
        )}

        {serverProfile && passwordFromEnv && (
          <p
            data-testid="proxy-profile-password-env-hint"
            className="text-xs text-muted-foreground"
          >
            {t('proxy.password.envManaged')}
          </p>
        )}

        {serverProfile && passwordError && (
          <div
            role="alert"
            data-testid="proxy-profile-password-error"
            className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
          >
            {passwordError}
          </div>
        )}
      </div>

      {formError && (
        <div
          role="alert"
          data-testid="proxy-profile-form-error"
          className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
        >
          {formError}
        </div>
      )}

      {/* TLS/mTLS к прокси — свёрнутая секция; пути в профиле, PEM/ключи write-only. */}
      <div className="min-w-0 rounded-lg border border-border/60">
        <button
          type="button"
          onClick={() => setTlsOpen((prev) => !prev)}
          aria-expanded={tlsOpen}
          aria-controls="proxy-profile-tls-content"
          className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 p-3 text-left"
          data-testid="proxy-profile-tls-toggle"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{t('proxy.tls.toggle')}</span>
            <FieldTooltip text={t('settings.help.network.profileTls')} />
            {tlsMeta && (tlsMeta.caFile || tlsMeta.hasCaPem || tlsMeta.certFile) && (
              <span
                data-testid="proxy-profile-tls-badge"
                className={cn(BADGE, 'bg-status-success/15 text-status-success')}
              >
                {t('proxy.tls.badge')}
              </span>
            )}
          </span>
          <Icon
            name="arrow-down-s"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              tlsOpen && 'rotate-180',
            )}
          />
        </button>
        <div
          id="proxy-profile-tls-content"
          hidden={!tlsOpen}
          data-testid="proxy-profile-tls-content"
          className="space-y-3 min-w-0 border-t border-border/60 p-3"
        >
          <p className="text-xs text-muted-foreground">{t('proxy.tls.help')}</p>
          {isNew && (
            <p
              data-testid="proxy-profile-tls-pending-hint"
              className="text-xs text-muted-foreground"
            >
              {t('proxy.tls.pendingUploadHint')}
            </p>
          )}

          <TextField
            label={t('proxy.tls.caFile')}
            value={form.tlsCaFile}
            onChange={(e) => setForm((prev) => ({ ...prev, tlsCaFile: e.target.value }))}
            placeholder="/etc/synth/proxy-ca.pem"
            mono
            disabled={disabled}
            tooltip={t('settings.help.network.profileTlsCaFile')}
            data-testid="proxy-profile-tls-ca-file"
          />
          <TextField
            label={t('proxy.tls.certFile')}
            value={form.tlsCertFile}
            onChange={(e) => setForm((prev) => ({ ...prev, tlsCertFile: e.target.value }))}
            placeholder="/etc/synth/proxy-client.crt"
            mono
            disabled={disabled}
            tooltip={t('settings.help.network.profileTlsCertFile')}
            data-testid="proxy-profile-tls-cert-file"
          />
          <TextField
            label={t('proxy.tls.keyFile')}
            value={form.tlsKeyFile}
            onChange={(e) => setForm((prev) => ({ ...prev, tlsKeyFile: e.target.value }))}
            placeholder="/etc/synth/proxy-client.key"
            mono
            disabled={disabled}
            tooltip={t('settings.help.network.profileTlsKeyFile')}
            data-testid="proxy-profile-tls-key-file"
          />
          <ToggleField
            label={t('proxy.tls.rejectUnauthorized')}
            enabled={form.rejectUnauthorized}
            onToggle={() =>
              setForm((prev) => ({ ...prev, rejectUnauthorized: !prev.rejectUnauthorized }))
            }
            disabled={disabled}
            tooltip={t('settings.help.network.profileTlsRejectUnauthorized')}
          />

          <div className="space-y-2 min-w-0">
            <div className="text-xs font-medium text-muted-foreground">
              {t('proxy.tls.caTitle')}
            </div>
            {tlsMeta?.hasCaPem && (
              <div data-testid="proxy-profile-tls-has-ca" className="text-xs text-status-success">
                {t('proxy.tls.hasCa')}
              </div>
            )}
            <TextArea
              label={t('proxy.tls.caPem')}
              value={caPem}
              onChange={(e) => {
                setCaPem(e.target.value);
                if (tlsError) setTlsError(null);
              }}
              placeholder="-----BEGIN CERTIFICATE-----"
              rows={5}
              mono
              disabled={tlsPending || disabled}
              tooltip={t('settings.help.network.profileTlsCaPem')}
              data-testid="proxy-profile-tls-ca-pem"
            />
            <input
              type="file"
              accept=".pem,.crt,.cer"
              multiple
              aria-label={t('proxy.tls.caLoadFile')}
              className={FILE_INPUT}
              disabled={tlsPending || disabled}
              onChange={(e) => void handleTlsFiles(e, setCaPem)}
              data-testid="proxy-profile-tls-ca-file-input"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void validateCa()}
                disabled={tlsPending || disabled || !caPem.trim()}
                data-testid="proxy-profile-tls-ca-check"
              >
                {t('proxy.tls.check')}
              </Button>
              {!isNew && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void uploadCa()}
                    disabled={tlsPending || disabled || !serverProfile || !caPem.trim()}
                    data-testid="proxy-profile-tls-ca-upload"
                  >
                    {t('proxy.tls.upload')}
                  </Button>
                  <Button
                    variant="outline-muted"
                    size="sm"
                    onClick={() => void removeCa()}
                    disabled={
                      tlsPending ||
                      disabled ||
                      !serverProfile ||
                      (!tlsMeta?.caFile && !tlsMeta?.hasCaPem)
                    }
                    data-testid="proxy-profile-tls-ca-remove"
                  >
                    {t('proxy.tls.remove')}
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="space-y-2 min-w-0 border-t border-border/60 pt-2">
            <div className="text-xs font-medium text-muted-foreground">
              {t('proxy.tls.clientTitle')}
            </div>
            <label className="block space-y-1 min-w-0">
              <span className="flex items-center gap-1.5 text-xs text-foreground">
                {t('proxy.tls.clientCert')}
                <FieldTooltip text={t('settings.help.network.profileTlsClientCert')} />
              </span>
              <input
                type="file"
                accept=".pem,.crt,.cer"
                className={FILE_INPUT}
                disabled={tlsPending || disabled}
                onChange={(e) => void handleTlsFiles(e, setClientCertPem)}
                data-testid="proxy-profile-tls-client-cert-input"
              />
            </label>
            <label className="block space-y-1 min-w-0">
              <span className="flex items-center gap-1.5 text-xs text-foreground">
                {t('proxy.tls.clientKey')}
                <FieldTooltip text={t('settings.help.network.profileTlsClientKey')} />
              </span>
              <input
                type="file"
                accept=".pem,.key"
                className={FILE_INPUT}
                disabled={tlsPending || disabled}
                onChange={(e) => void handleTlsFiles(e, setClientKeyPem)}
                data-testid="proxy-profile-tls-client-key-input"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void validateClient()}
                disabled={tlsPending || disabled}
                data-testid="proxy-profile-tls-client-check"
              >
                {t('proxy.tls.check')}
              </Button>
              {!isNew && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void uploadClient()}
                    disabled={
                      tlsPending ||
                      disabled ||
                      !serverProfile ||
                      !clientCertPem.trim() ||
                      !clientKeyPem.trim()
                    }
                    data-testid="proxy-profile-tls-client-upload"
                  >
                    {t('proxy.tls.upload')}
                  </Button>
                  <Button
                    variant="outline-muted"
                    size="sm"
                    onClick={() => void removeClient()}
                    disabled={
                      tlsPending ||
                      disabled ||
                      !serverProfile ||
                      (!tlsMeta?.certFile && !tlsMeta?.keyFile)
                    }
                    data-testid="proxy-profile-tls-client-remove"
                  >
                    {t('proxy.tls.remove')}
                  </Button>
                </>
              )}
            </div>
          </div>

          {tlsValidate && (
            <div
              role="status"
              data-testid="proxy-profile-tls-result"
              className={cn(
                'rounded-lg p-2 text-xs',
                tlsValidate.ok
                  ? 'bg-status-success/10 text-status-success'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              <div className="font-medium">
                {tlsValidate.ok ? t('proxy.tls.checkOk') : t('proxy.tls.checkFailed')}
              </div>
              {tlsValidate.errors.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4">
                  {tlsValidate.errors.map((error) => (
                    <li key={error} className="min-w-0 break-words">
                      {error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {tlsError && (
            <div
              role="alert"
              data-testid="proxy-profile-tls-error"
              className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
            >
              {tlsError}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline-muted"
          size="sm"
          onClick={closeForm}
          data-testid="proxy-profile-form-cancel"
        >
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={submitForm}
          disabled={disabled}
          data-testid="proxy-profile-form-apply"
        >
          {t('proxy.profiles.apply')}
        </Button>
      </div>
    </div>
  );

  return (
    <div
      className="space-y-3 min-w-0 rounded-lg border border-border/60 p-3"
      data-testid="proxy-profiles"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="text-sm font-medium text-foreground">{t('proxy.profiles.title')}</div>
          <FieldTooltip text={t('settings.help.network.profiles')} />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={openAdd}
          disabled={editing !== null || disabled}
          data-testid="proxy-profile-add"
        >
          <Icon name="add" className="size-3.5" />
          {t('proxy.profiles.add')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('proxy.profiles.description')}</p>

      {deleteError && (
        <div
          role="alert"
          data-testid="proxy-profile-delete-error"
          className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
        >
          {deleteError}
        </div>
      )}

      {names.length === 0 && editing !== '__new__' && (
        <p data-testid="proxy-profiles-empty" className="text-xs text-muted-foreground">
          {t('proxy.profiles.empty')}
        </p>
      )}

      <div className="space-y-2 min-w-0">
        {names.map((name) => {
          const profile = draft.profiles[name]!;
          const usage = profileUsage(draft, name);
          const server = status.profiles?.[name];
          const tlsConfigured =
            server?.tls && (server.tls.caFile || server.tls.hasCaPem || server.tls.certFile);
          return (
            <div key={name} className="min-w-0" data-testid={`proxy-profile-${name}`}>
              <div className="flex flex-wrap items-start justify-between gap-2 min-w-0 rounded-lg bg-surface-inset p-2">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-sm font-medium text-foreground">{name}</span>
                    {profile.label && (
                      <span className="text-xs text-muted-foreground">{profile.label}</span>
                    )}
                    {usage.isDefault && (
                      <span
                        data-testid={`proxy-profile-default-${name}`}
                        className={cn(BADGE, 'bg-status-info/15 text-status-info')}
                      >
                        {t('proxy.profiles.usedByDefault')}
                      </span>
                    )}
                    {usage.rules.length > 0 && (
                      <span
                        data-testid={`proxy-profile-rules-${name}`}
                        className={cn(BADGE, 'bg-interactive-hover text-muted-foreground')}
                      >
                        {t('proxy.profiles.usedByRules', { rules: usage.rules.join(', ') })}
                      </span>
                    )}
                    {tlsConfigured && (
                      <span
                        data-testid={`proxy-profile-tls-${name}`}
                        className={cn(BADGE, 'bg-status-success/15 text-status-success')}
                      >
                        {t('proxy.tls.badge')}
                      </span>
                    )}
                    <span
                      data-testid={`proxy-profile-password-badge-${name}`}
                      className={cn(
                        BADGE,
                        server?.password?.set
                          ? 'bg-status-success/15 text-status-success'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {server?.password?.set
                        ? t('proxy.password.setBadge')
                        : t('proxy.password.notSet')}
                    </span>
                  </div>
                  <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                    {displayProfileUrl(profile) || '—'}
                  </div>
                  {profile.username && (
                    <div className="text-xs text-muted-foreground">
                      {t('proxy.profiles.username')}: {profile.username}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(name)}
                    disabled={editing !== null || disabled}
                    data-testid={`proxy-profile-edit-${name}`}
                  >
                    {t('proxy.profiles.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDelete(name)}
                    disabled={editing !== null || disabled}
                    data-testid={`proxy-profile-delete-${name}`}
                  >
                    {t('proxy.profiles.delete')}
                  </Button>
                </div>
              </div>
              {editing === name && renderForm(false)}
            </div>
          );
        })}
      </div>

      {editing === '__new__' && renderForm(true)}
    </div>
  );
}
