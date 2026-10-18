// proxy-draft: чистая модель формы egress-прокси (ADR-099) — без React.
//
// `status → draft → PUT /settings/proxy`. В режиме профилей payload содержит
// только `profiles`/`rules`/`mode`/`defaultProfile`: top-level `url`/`auth`/`tls`
// сервер запрещает, если заданы профили. Legacy-конфигурация (flat-поля)
// синтезируется в профиль `default` с сохранением `httpProxy/httpsProxy/allProxy`.

import type { ProxyMode, ProxyStatusRule } from '@itphx/synth-shared';
import type {
  ProxyConfigInput,
  ProxyProfileInput,
  ProxyProfileStatus,
  ProxyRuleInput,
  ProxyStatusInfo,
  ProxyTlsConfig,
} from '@/lib/api/synthApi';

/** Редактируемая форма профиля (строки — чтобы не терять ввод). */
export interface ProxyProfileDraft {
  label: string;
  url: string;
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  username: string;
  tlsCaFile: string;
  tlsCertFile: string;
  tlsKeyFile: string;
  rejectUnauthorized: boolean;
  /**
   * Пароль профиля, введённый до первого сохранения: write-only endpoint
   * принимает его только после `PUT /settings/proxy`, поэтому значение ждёт
   * в клиентском черновике. В payload/DOM не попадает.
   */
  pendingPassword?: string;
  /**
   * TLS-материалы нового профиля, выбранные до первого сохранения: upload
   * доступен только после `PUT /settings/proxy`. В payload/DOM не попадают.
   */
  pendingCaPem?: string;
  pendingClientCertPem?: string;
  pendingClientKeyPem?: string;
}

/** Правило в черновике; `key` — стабильный React-ключ (в payload не уходит). */
export interface ProxyRuleDraft {
  key: string;
  id: string;
  label: string;
  hosts: string[];
  action: 'proxy' | 'direct';
  profile: string;
}

export interface ProxyDraft {
  enabled: boolean;
  mode: ProxyMode;
  defaultProfile: string;
  profiles: Record<string, ProxyProfileDraft>;
  rules: ProxyRuleDraft[];
  noProxy: string[];
  fromEnv: boolean;
  fallbackDirect: boolean;
  connectTimeoutMs: number;
}

/** Имя профиля: `^[a-z][a-z0-9_-]{0,31}$` (контракт `PROXY_PROFILE_NAME_RE`). */
const PROXY_PROFILE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

let ruleKeySeq = 0;

/** Стабильный клиентский ключ правила (не отправляется на сервер). */
export function nextRuleKey(): string {
  ruleKeySeq += 1;
  return `rule-key-${ruleKeySeq}`;
}

export function emptyProfileDraft(): ProxyProfileDraft {
  return {
    label: '',
    url: '',
    httpProxy: '',
    httpsProxy: '',
    allProxy: '',
    username: '',
    tlsCaFile: '',
    tlsCertFile: '',
    tlsKeyFile: '',
    rejectUnauthorized: true,
  };
}

/** Короткий URL профиля для карточки/списка. */
export function displayProfileUrl(profile: ProxyProfileDraft | undefined): string {
  if (!profile) return '';
  return (
    (profile.url ?? '').trim() ||
    (profile.httpsProxy ?? '').trim() ||
    (profile.httpProxy ?? '').trim() ||
    (profile.allProxy ?? '').trim()
  );
}

function profileStatusToDraft(profile: ProxyProfileStatus): ProxyProfileDraft {
  const tls = profile.tls;
  return {
    label: profile.label ?? '',
    url: profile.url ?? '',
    httpProxy: profile.httpProxy ?? '',
    httpsProxy: profile.httpsProxy ?? '',
    allProxy: profile.allProxy ?? '',
    username: profile.auth?.username ?? '',
    tlsCaFile: tls?.caFile ?? '',
    tlsCertFile: tls?.certFile ?? '',
    tlsKeyFile: tls?.keyFile ?? '',
    rejectUnauthorized: tls?.rejectUnauthorized ?? true,
  };
}

function ruleStatusToDraft(rule: ProxyStatusRule): ProxyRuleDraft {
  return {
    key: rule.id,
    id: rule.id,
    label: rule.label ?? '',
    hosts: [...rule.hosts],
    action: rule.action,
    profile: rule.profile ?? '',
  };
}

/**
 * `saved`/`defaults` статус → черновик. Legacy (нет `profiles`, но есть flat-URL,
 * auth или tls) синтезируется в профиль `default`; `mode`/`rules` сохраняются.
 */
export function statusToDraft(status: ProxyStatusInfo): ProxyDraft {
  const profiles: Record<string, ProxyProfileDraft> = {};
  for (const [name, profile] of Object.entries(status.profiles ?? {})) {
    profiles[name] = profileStatusToDraft(profile);
  }

  const hasFlatUrl = [status.url, status.httpProxy, status.httpsProxy, status.allProxy].some(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  if (Object.keys(profiles).length === 0 && (hasFlatUrl || status.auth || status.tls)) {
    profiles.default = {
      ...emptyProfileDraft(),
      url: status.url ?? '',
      httpProxy: status.httpProxy ?? '',
      httpsProxy: status.httpsProxy ?? '',
      allProxy: status.allProxy ?? '',
      username: status.auth?.username ?? '',
      tlsCaFile: status.tls?.caFile ?? '',
      tlsCertFile: status.tls?.certFile ?? '',
      tlsKeyFile: status.tls?.keyFile ?? '',
      rejectUnauthorized: status.tls?.rejectUnauthorized ?? true,
    };
  }

  const names = Object.keys(profiles);
  let defaultProfile = status.defaultProfile ?? '';
  if (!defaultProfile) {
    if (profiles.default) defaultProfile = 'default';
    else if (names.length > 0) defaultProfile = names[0]!;
  }

  return {
    enabled: status.enabled,
    mode: status.mode ?? 'all',
    defaultProfile,
    profiles,
    rules: (status.rules ?? []).map(ruleStatusToDraft),
    noProxy: [...(status.noProxy ?? [])],
    fromEnv: status.fromEnv ?? true,
    fallbackDirect: status.fallbackDirect,
    connectTimeoutMs: status.connectTimeoutMs,
  };
}

function tlsFromDraft(profile: ProxyProfileDraft): ProxyTlsConfig | undefined {
  const tls: ProxyTlsConfig = {};
  if (profile.tlsCaFile.trim()) tls.caFile = profile.tlsCaFile.trim();
  if (profile.tlsCertFile.trim()) tls.certFile = profile.tlsCertFile.trim();
  if (profile.tlsKeyFile.trim()) tls.keyFile = profile.tlsKeyFile.trim();
  if (!profile.rejectUnauthorized) tls.rejectUnauthorized = false;
  return Object.keys(tls).length > 0 ? tls : undefined;
}

/**
 * Черновик профиля → сохраняемая форма (пустые поля не отправляются).
 * `pendingPassword` и pending TLS намеренно не входят: пароль и PEM
 * применяются отдельными write-only endpoint'ами уже после сохранения профиля.
 */
export function profileDraftToInput(profile: ProxyProfileDraft): ProxyProfileInput {
  const input: ProxyProfileInput = {};
  const label = profile.label.trim();
  if (label) input.label = label;
  const url = profile.url.trim();
  if (url) input.url = url;
  const httpProxy = (profile.httpProxy ?? '').trim();
  if (httpProxy) input.httpProxy = httpProxy;
  const httpsProxy = (profile.httpsProxy ?? '').trim();
  if (httpsProxy) input.httpsProxy = httpsProxy;
  const allProxy = (profile.allProxy ?? '').trim();
  if (allProxy) input.allProxy = allProxy;
  const username = profile.username.trim();
  if (username) input.auth = { type: 'basic', username };
  const tls = tlsFromDraft(profile);
  if (tls) input.tls = tls;
  return input;
}

function ruleDraftToInput(rule: ProxyRuleDraft): ProxyRuleInput {
  const input: ProxyRuleInput = {
    hosts: rule.hosts.map((host) => host.trim()).filter(Boolean),
    action: rule.action,
  };
  if (rule.id.trim()) input.id = rule.id.trim();
  if (rule.label.trim()) input.label = rule.label.trim();
  if (rule.action === 'proxy' && rule.profile) input.profile = rule.profile;
  return input;
}

/**
 * Черновик → тело `PUT /settings/proxy`. Всегда отправляет
 * `mode`/`defaultProfile`/`profiles`/`rules` (structured), без top-level
 * `url`/`auth`/`tls` — при непустых профилях сервер их запрещает.
 */
export function proxyDraftToInput(draft: ProxyDraft): ProxyConfigInput {
  const profiles: Record<string, ProxyProfileInput> = {};
  for (const [name, profile] of Object.entries(draft.profiles)) {
    profiles[name] = profileDraftToInput(profile);
  }
  const input: ProxyConfigInput = {
    enabled: draft.enabled,
    mode: draft.mode,
    profiles,
    rules: draft.rules.map(ruleDraftToInput),
    noProxy: draft.noProxy.map((item) => item.trim()).filter(Boolean),
    fromEnv: draft.fromEnv,
    fallbackDirect: draft.fallbackDirect,
    connectTimeoutMs: draft.connectTimeoutMs,
  };
  if (draft.defaultProfile) input.defaultProfile = draft.defaultProfile;
  return input;
}

/**
 * Профили с непустым `pendingPassword` — применяются отдельными вызовами
 * `PUT /settings/proxy/profiles/:name/password` сразу после `PUT /settings/proxy`.
 */
export function pendingProfilePasswords(
  draft: ProxyDraft,
): Array<{ name: string; password: string }> {
  return Object.entries(draft.profiles)
    .map(([name, profile]) => ({ name, password: profile.pendingPassword ?? '' }))
    .filter((entry) => entry.password.trim() !== '');
}

/** Отложенные TLS-материалы профиля (загружаются после `PUT /settings/proxy`). */
export interface PendingProfileTls {
  name: string;
  caPem?: string;
  certPem?: string;
  keyPem?: string;
}

/**
 * Профили с непустыми pending TLS-материалами — загружаются write-only
 * endpoint'ами (`.../tls/ca`, `.../tls/client`) сразу после `PUT /settings/proxy`.
 * Пустые поля не включаются; PEM в сохраняемую форму не попадает.
 */
export function pendingProfileTls(draft: ProxyDraft): PendingProfileTls[] {
  const entries: PendingProfileTls[] = [];
  for (const [name, profile] of Object.entries(draft.profiles)) {
    const caPem = profile.pendingCaPem?.trim();
    const certPem = profile.pendingClientCertPem?.trim();
    const keyPem = profile.pendingClientKeyPem?.trim();
    const entry: PendingProfileTls = { name };
    if (caPem) entry.caPem = caPem;
    if (certPem) entry.certPem = certPem;
    if (keyPem) entry.keyPem = keyPem;
    if (entry.caPem || entry.certPem || entry.keyPem) entries.push(entry);
  }
  return entries;
}

export type ProxyDraftIssue =
  | { kind: 'timeout' }
  | { kind: 'noProfiles' }
  | { kind: 'profileName'; name: string }
  | { kind: 'profileUrl'; name: string }
  | { kind: 'defaultProfile' }
  | { kind: 'selectedNoRules' }
  | { kind: 'ruleHosts'; index: number }
  | { kind: 'ruleProfile'; index: number };

/** `true` — имя профиля валидно (`^[a-z][a-z0-9_-]{0,31}$`). */
export function isValidProfileName(name: string): boolean {
  return PROXY_PROFILE_NAME_RE.test(name);
}

/**
 * Локальная валидация до сохранения (те же правила, что у резолвера, чтобы не
 * получать 400 на ровном месте): URL профиля, default-профиль для `all`,
 * непустые правила для `selected`, профиль у `proxy`-правила.
 */
export function validateProxyDraft(draft: ProxyDraft): ProxyDraftIssue[] {
  const issues: ProxyDraftIssue[] = [];
  if (!Number.isFinite(draft.connectTimeoutMs) || draft.connectTimeoutMs < 1) {
    issues.push({ kind: 'timeout' });
  }

  const names = Object.keys(draft.profiles);
  for (const name of names) {
    const profile = draft.profiles[name]!;
    if (!isValidProfileName(name)) issues.push({ kind: 'profileName', name });
    const hasUrl = [profile.url, profile.httpProxy, profile.httpsProxy, profile.allProxy].some(
      (value) => (value ?? '').trim() !== '',
    );
    if (!hasUrl) issues.push({ kind: 'profileUrl', name });
  }

  if (draft.enabled && draft.mode === 'all' && names.length === 0) {
    issues.push({ kind: 'noProfiles' });
  }

  if (draft.mode === 'all' && names.length > 0) {
    if (!draft.defaultProfile || !draft.profiles[draft.defaultProfile]) {
      issues.push({ kind: 'defaultProfile' });
    }
  }

  if (draft.mode === 'selected' && draft.rules.length === 0) {
    issues.push({ kind: 'selectedNoRules' });
  }

  draft.rules.forEach((rule, index) => {
    if (rule.hosts.some((host) => host.trim() !== '') === false) {
      issues.push({ kind: 'ruleHosts', index });
    }
    if (rule.action === 'proxy') {
      const profile = rule.profile || draft.defaultProfile;
      if (!profile || !draft.profiles[profile]) {
        issues.push({ kind: 'ruleProfile', index });
      }
    }
  });

  return issues;
}

/** `true` — профиль используется как default или в правилах (удаление блокируется). */
export function profileUsage(
  draft: ProxyDraft,
  name: string,
): { isDefault: boolean; rules: string[] } {
  return {
    isDefault: draft.defaultProfile === name,
    rules: draft.rules
      .filter((rule) => rule.action === 'proxy' && rule.profile === name)
      .map((rule) => rule.id || rule.label || '—'),
  };
}
