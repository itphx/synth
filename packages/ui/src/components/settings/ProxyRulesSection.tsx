import { useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Icon } from '../icon/Icon';
import { Button } from '../ui/button';
import { FieldTooltip, ListField, SelectField, TextField } from '../ui/settings';
import { SelectContent, SelectItem } from '../ui/select';
import { nextRuleKey, type ProxyDraft, type ProxyRuleDraft } from './proxy-draft';

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium';

interface RuleFormState {
  label: string;
  hosts: string[];
  action: 'proxy' | 'direct';
  profile: string;
}

interface ProxyRulesSectionProps {
  draft: ProxyDraft;
  setDraft: (updater: (prev: ProxyDraft) => ProxyDraft) => void;
  disabled?: boolean;
}

/**
 * ADR-099: правила маршрутизации прокси (порядок = приоритет, первое совпадение).
 * `noProxy` всегда важнее правил; `direct` несовместим с профилем.
 */
export function ProxyRulesSection({ draft, setDraft, disabled = false }: ProxyRulesSectionProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<string | '__new__' | null>(null);
  const [form, setForm] = useState<RuleFormState>({
    label: '',
    hosts: [],
    action: 'proxy',
    profile: '',
  });
  const [formError, setFormError] = useState<string | null>(null);

  const profileNames = Object.keys(draft.profiles);
  const profileItems = [
    { value: '', label: t('proxy.rules.defaultProfile') },
    ...profileNames.map((name) => ({ value: name, label: name })),
  ];

  const openAdd = () => {
    setEditing('__new__');
    setForm({ label: '', hosts: [], action: 'proxy', profile: '' });
    setFormError(null);
  };

  const openEdit = (rule: ProxyRuleDraft) => {
    setEditing(rule.key);
    setForm({
      label: rule.label,
      hosts: [...rule.hosts],
      action: rule.action,
      profile: rule.profile,
    });
    setFormError(null);
  };

  const close = () => {
    setEditing(null);
    setFormError(null);
  };

  const submit = () => {
    const hosts = form.hosts.map((host) => host.trim()).filter(Boolean);
    if (hosts.length === 0) {
      setFormError(t('proxy.rules.hostsRequired'));
      return;
    }
    if (form.action === 'proxy') {
      const profile = form.profile || draft.defaultProfile;
      if (!profile || !draft.profiles[profile]) {
        setFormError(t('proxy.rules.profileRequired'));
        return;
      }
    }
    if (editing === '__new__') {
      const rule: ProxyRuleDraft = {
        key: nextRuleKey(),
        id: '',
        label: form.label.trim(),
        hosts,
        action: form.action,
        profile: form.action === 'proxy' ? form.profile : '',
      };
      setDraft((prev) => ({ ...prev, rules: [...prev.rules, rule] }));
    } else {
      setDraft((prev) => ({
        ...prev,
        rules: prev.rules.map((rule) =>
          rule.key === editing
            ? {
                ...rule,
                label: form.label.trim(),
                hosts,
                action: form.action,
                profile: form.action === 'proxy' ? form.profile : '',
              }
            : rule,
        ),
      }));
    }
    close();
  };

  const remove = (key: string) => {
    setDraft((prev) => ({ ...prev, rules: prev.rules.filter((rule) => rule.key !== key) }));
    if (editing === key) close();
  };

  const move = (index: number, delta: -1 | 1) => {
    setDraft((prev) => {
      const next = [...prev.rules];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return { ...prev, rules: next };
    });
  };

  const renderForm = (isNew: boolean) => (
    <div
      className="space-y-3 min-w-0 rounded-lg border border-border/60 bg-surface-inset p-3"
      data-testid="proxy-rule-form"
    >
      <div className="text-sm font-medium text-foreground">
        {isNew
          ? t('proxy.rules.addTitle')
          : t('proxy.rules.editTitle', { label: form.label || t('proxy.rules.untitled') })}
      </div>

      <div data-testid="proxy-rule-form-hosts">
        <ListField
          label={t('proxy.rules.hosts')}
          description={t('proxy.rules.hostsHelp')}
          values={form.hosts}
          onChange={(hosts) => {
            setForm((prev) => ({ ...prev, hosts }));
            if (formError) setFormError(null);
          }}
          placeholder="api.openai.com"
          variant="chips"
          tooltip={t('settings.help.network.ruleHosts')}
        />
      </div>

      <TextField
        label={t('proxy.rules.label')}
        value={form.label}
        onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))}
        placeholder={t('proxy.rules.labelPlaceholder')}
        disabled={disabled}
        tooltip={t('settings.help.network.ruleLabel')}
        data-testid="proxy-rule-form-label"
      />

      <SelectField
        label={t('proxy.rules.action')}
        value={form.action}
        onValueChange={(value) =>
          setForm((prev) => ({
            ...prev,
            action: value === 'direct' ? 'direct' : 'proxy',
          }))
        }
        items={[
          { value: 'proxy', label: t('proxy.rules.action.proxy') },
          { value: 'direct', label: t('proxy.rules.action.direct') },
        ]}
        disabled={disabled}
        tooltip={t('settings.help.network.ruleAction')}
        triggerTestId="proxy-rule-form-action"
      >
        <SelectContent>
          <SelectItem value="proxy">{t('proxy.rules.action.proxy')}</SelectItem>
          <SelectItem value="direct">{t('proxy.rules.action.direct')}</SelectItem>
        </SelectContent>
      </SelectField>

      <SelectField
        label={t('proxy.rules.profile')}
        description={t('proxy.rules.profileHelp')}
        value={form.action === 'proxy' ? form.profile : ''}
        onValueChange={(profile) => setForm((prev) => ({ ...prev, profile }))}
        items={profileItems}
        disabled={disabled || form.action === 'direct'}
        tooltip={t('settings.help.network.ruleProfile')}
        triggerTestId="proxy-rule-form-profile"
      >
        <SelectContent>
          {profileItems.map((item) => (
            <SelectItem key={item.value || '__default__'} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectField>

      {formError && (
        <div
          role="alert"
          data-testid="proxy-rule-form-error"
          className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
        >
          {formError}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline-muted"
          size="sm"
          onClick={close}
          data-testid="proxy-rule-form-cancel"
        >
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={disabled}
          data-testid="proxy-rule-form-apply"
        >
          {t('proxy.rules.apply')}
        </Button>
      </div>
    </div>
  );

  return (
    <div
      className="space-y-3 min-w-0 rounded-lg border border-border/60 p-3"
      data-testid="proxy-rules"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="text-sm font-medium text-foreground">{t('proxy.rules.title')}</div>
          <FieldTooltip text={t('settings.help.network.rules')} />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={openAdd}
          disabled={editing !== null || disabled}
          data-testid="proxy-rule-add"
        >
          <Icon name="add" className="size-3.5" />
          {t('proxy.rules.add')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('proxy.rules.hint')}</p>

      {draft.rules.length === 0 && editing !== '__new__' && (
        <p data-testid="proxy-rules-empty" className="text-xs text-muted-foreground">
          {t('proxy.rules.empty')}
        </p>
      )}

      <div className="space-y-2 min-w-0">
        {draft.rules.map((rule, index) => (
          <div key={rule.key} className="min-w-0" data-testid={`proxy-rule-${rule.key}`}>
            <div className="flex flex-wrap items-start justify-between gap-2 min-w-0 rounded-lg bg-surface-inset p-2">
              <div className="flex min-w-0 items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-interactive-hover px-1.5 py-0.5 text-[0.625rem] tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1">
                    {rule.hosts.map((host) => (
                      <span
                        key={host}
                        className="rounded-full bg-interactive-hover px-1.5 py-0.5 font-mono text-[0.6875rem] text-foreground"
                      >
                        {host}
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {rule.label && <span className="min-w-0 break-words">{rule.label}</span>}
                    <span
                      data-testid={`proxy-rule-action-${rule.key}`}
                      className={cn(
                        BADGE,
                        rule.action === 'proxy'
                          ? 'bg-status-info/15 text-status-info'
                          : 'bg-status-warning/15 text-status-warning',
                      )}
                    >
                      {rule.action === 'proxy'
                        ? t('proxy.rules.action.proxy')
                        : t('proxy.rules.action.direct')}
                    </span>
                    {rule.action === 'proxy' && (
                      <span className="font-mono">
                        {rule.profile || draft.defaultProfile || t('proxy.rules.defaultProfile')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => move(index, -1)}
                  disabled={editing !== null || disabled || index === 0}
                  aria-label={t('proxy.rules.moveUp')}
                  data-testid={`proxy-rule-up-${rule.key}`}
                >
                  <Icon name="arrow-up" className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => move(index, 1)}
                  disabled={editing !== null || disabled || index === draft.rules.length - 1}
                  aria-label={t('proxy.rules.moveDown')}
                  data-testid={`proxy-rule-down-${rule.key}`}
                >
                  <Icon name="arrow-down" className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEdit(rule)}
                  disabled={editing !== null || disabled}
                  data-testid={`proxy-rule-edit-${rule.key}`}
                >
                  {t('proxy.rules.edit')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(rule.key)}
                  disabled={editing !== null || disabled}
                  data-testid={`proxy-rule-delete-${rule.key}`}
                >
                  {t('proxy.rules.delete')}
                </Button>
              </div>
            </div>
            {editing === rule.key && renderForm(false)}
          </div>
        ))}
      </div>

      {editing === '__new__' && renderForm(true)}
    </div>
  );
}
