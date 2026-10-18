import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';

const uiMocks = vi.hoisted(() => ({ setSettingsPage: vi.fn() }));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: { setSettingsPage: typeof uiMocks.setSettingsPage }) => unknown) =>
    selector({ setSettingsPage: uiMocks.setSettingsPage }),
}));

const mocks = vi.hoisted(() => ({
  getProxy: vi.fn(),
  saveProxy: vi.fn(),
  resetProxy: vi.fn(),
  setProxyPassword: vi.fn(),
  clearProxyPassword: vi.fn(),
  checkProxy: vi.fn(),
  setProfilePassword: vi.fn(),
  clearProfilePassword: vi.fn(),
  uploadProfileCa: vi.fn(),
  removeProfileCa: vi.fn(),
  uploadProfileClient: vi.fn(),
  removeProfileClient: vi.fn(),
  validateTls: vi.fn(),
  testProxyRoute: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }));
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}));
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }));

import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { dict as enDict } from '@/lib/i18n/messages/en';
import { ProxyStatusSection } from './ProxyStatusSection';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; container: HTMLElement }> = [];

const CORP = {
  name: 'corp',
  label: 'Corp',
  url: 'http://proxy.corp:3128',
  auth: { type: 'basic' as const, username: 'svc' },
  legacy: false,
  source: 'config' as const,
  password: { source: 'none' as const, set: false, removable: false },
};

const SPARE = {
  name: 'spare',
  url: 'http://proxy.spare:3128',
  legacy: false,
  source: 'config' as const,
  password: { source: 'none' as const, set: false, removable: false },
};

const SAVED = {
  enabled: true,
  source: 'config' as const,
  mode: 'all' as const,
  defaultProfile: 'corp',
  profiles: { corp: CORP, spare: SPARE },
  rules: [
    {
      id: 'r1',
      label: 'Example',
      hosts: ['*.example.com'],
      action: 'proxy' as const,
      profile: 'corp',
    },
  ],
  noProxy: ['localhost'],
  fromEnv: false,
  fallbackDirect: false,
  connectTimeoutMs: 5000,
  restartRequired: true as const,
};

const RUNNING = {
  enabled: false,
  source: 'none' as const,
  mode: 'all' as const,
  profiles: {},
  rules: [],
  noProxy: [],
  fromEnv: true,
  fallbackDirect: false,
  connectTimeoutMs: 10_000,
  restartRequired: true as const,
};

const DEFAULTS = {
  ...SAVED,
  url: 'http://config-proxy:3128',
  profiles: {},
  rules: [],
};

function makeInfo(over: Record<string, unknown> = {}) {
  return {
    ...SAVED,
    saved: SAVED,
    running: RUNNING,
    isOverridden: false,
    defaults: DEFAULTS,
    password: { source: 'none' as const, set: false, removable: false },
    restartRequired: true,
    ...over,
  };
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderSection(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => {
    root.render(
      <I18nProvider>
        <ProxyStatusSection />
      </I18nProvider>,
    );
  });
  await act(async () => {});
  return container;
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

const click = async (el: HTMLElement | null) => {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await act(async () => {});
};

const addHost = async (container: HTMLElement, value: string) => {
  const input = container.querySelector('input[placeholder="api.openai.com"]') as HTMLInputElement;
  await act(async () => {
    setInputValue(input, value);
  });
  const add = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Add',
  ) as HTMLButtonElement;
  await act(async () => {
    add.click();
  });
};

/** Заполняет форму нового профиля и нажимает «Применить». */
const addNewProfile = async (
  container: HTMLElement,
  name: string,
  url: string,
  options: { password?: string; username?: string } = {},
) => {
  await click(byTestId(container, 'proxy-profile-add'));
  await act(async () => {
    setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, name);
    setInputValue(byTestId(container, 'proxy-profile-form-url') as HTMLInputElement, url);
    if (options.username) {
      setInputValue(
        byTestId(container, 'proxy-profile-form-username') as HTMLInputElement,
        options.username,
      );
    }
    if (options.password) {
      setInputValue(
        byTestId(container, 'proxy-profile-password-input') as HTMLInputElement,
        options.password,
      );
    }
  });
  await click(byTestId(container, 'proxy-profile-form-apply'));
};

/** Подменяет `files` у file-input и шлёт change (jsdom не умеет DataTransfer). */
const setFileInput = async (el: HTMLElement | null, contents: string, name = 'material.pem') => {
  expect(el).not.toBeNull();
  const input = el as HTMLInputElement;
  const file = { name, text: async () => contents } as unknown as File;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {});
};

const serverProfileStatus = (name: string, url: string, tls?: Record<string, unknown>) => ({
  name,
  url,
  legacy: false,
  source: 'runtime' as const,
  password: { source: 'none' as const, set: false, removable: false },
  ...(tls ? { tls } : {}),
});

interface SavedProfileInput {
  url?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  label?: string;
  auth?: { type: string; username: string };
  tls?: Record<string, unknown>;
}

interface SavedRuleInput {
  id?: string;
  label?: string;
  hosts?: string[];
  action?: string;
  profile?: string;
}

interface SavedProxyInput {
  mode?: string;
  defaultProfile?: string;
  profiles: Record<string, SavedProfileInput>;
  rules: SavedRuleInput[];
  [key: string]: unknown;
}

const lastSaveInput = (): SavedProxyInput =>
  mocks.saveProxy.mock.calls[mocks.saveProxy.mock.calls.length - 1]![0] as SavedProxyInput;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProxy.mockResolvedValue(makeInfo());
  mocks.saveProxy.mockResolvedValue({
    saved: SAVED,
    running: RUNNING,
    restartRequired: true,
  });
  mocks.resetProxy.mockResolvedValue({
    status: 'restored',
    saved: DEFAULTS,
    defaults: DEFAULTS,
    running: RUNNING,
    restartRequired: true,
  });
  mocks.setProxyPassword.mockResolvedValue({ source: 'file', set: true, removable: true });
  mocks.clearProxyPassword.mockResolvedValue({ source: 'none', set: false, removable: false });
  mocks.setProfilePassword.mockResolvedValue({ source: 'file', set: true, removable: true });
  mocks.clearProfilePassword.mockResolvedValue({ source: 'none', set: false, removable: false });
  mocks.uploadProfileCa.mockResolvedValue({
    status: SAVED,
    restartRequired: true,
  });
  mocks.removeProfileCa.mockResolvedValue({ status: SAVED, restartRequired: true });
  mocks.uploadProfileClient.mockResolvedValue({ status: SAVED, restartRequired: true });
  mocks.removeProfileClient.mockResolvedValue({ status: SAVED, restartRequired: true });
  mocks.validateTls.mockResolvedValue({ ok: true, errors: [] });
  mocks.testProxyRoute.mockResolvedValue({
    url: 'https://api.example.com',
    route: {
      action: 'proxy',
      via: 'proxy',
      reason: 'rule',
      ruleId: 'r1',
      ruleLabel: 'Example',
      profile: 'corp',
      profileLabel: 'Corp',
      proxyUrl: 'http://proxy.corp:3128',
    },
    ok: true,
    httpStatus: 200,
    latencyMs: 42,
    authChallenge: 'none',
    usingSaved: true,
    restartRequired: true,
  });
  mocks.confirm.mockResolvedValue(true);
});

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!;
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('ProxyStatusSection — статус и загрузка профилей/правил', () => {
  it('показывает running/saved: mode, число профилей, default, плашку рестарта', async () => {
    const container = await renderSection();

    expect(mocks.getProxy).toHaveBeenCalledTimes(1);
    expect(byTestId(container, 'proxy-status-running-enabled')!.textContent).toBe('Disabled');
    expect(byTestId(container, 'proxy-status-saved-enabled')!.textContent).toBe('Enabled');
    expect(byTestId(container, 'proxy-status-saved-mode')!.textContent).toBe(
      'All hosts except noProxy',
    );
    expect(byTestId(container, 'proxy-status-saved-profiles')!.textContent).toBe('2');
    expect(byTestId(container, 'proxy-status-saved-default-profile')!.textContent).toBe('corp');
    expect(byTestId(container, 'proxy-status-restart')).not.toBeNull();
  });

  it('кнопка рестарта переключает страницу настроек на «Обслуживание»', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-restart-goto'));
    expect(uiMocks.setSettingsPage).toHaveBeenCalledWith('maintenance');
  });

  it('список профилей: имя, URL, username, бейджи default/rule/password', async () => {
    const container = await renderSection();

    expect(byTestId(container, 'proxy-profile-corp')).not.toBeNull();
    expect(byTestId(container, 'proxy-profile-spare')).not.toBeNull();
    expect(byTestId(container, 'proxy-profile-corp')!.textContent).toContain(
      'http://proxy.corp:3128',
    );
    expect(byTestId(container, 'proxy-profile-corp')!.textContent).toContain('svc');
    expect(byTestId(container, 'proxy-profile-default-corp')).not.toBeNull();
    expect(byTestId(container, 'proxy-profile-rules-corp')!.textContent).toContain('r1');
    expect(byTestId(container, 'proxy-profile-password-badge-corp')!.textContent).toBe(
      'no password',
    );
  });

  it('ошибка загрузки — inline-сообщение и error-тост', async () => {
    mocks.getProxy.mockRejectedValue(new Error('boom'));
    const container = await renderSection();

    expect(byTestId(container, 'proxy-status-error')!.textContent).toContain('boom');
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', category: 'error' }),
    );
  });
});

describe('ProxyStatusSection — профили (добавление/редактирование/удаление)', () => {
  it('подсказка логина — только Basic-логин; поле пароля подписано «Password»', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-add'));

    expect(container.textContent).toContain('Basic auth username.');
    expect(container.textContent).not.toContain('the password is set in the profile form');
    const passwordInput = byTestId(container, 'proxy-profile-password-input') as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    // Метка поля — «Password» (не «New password»).
    const passwordField = passwordInput.parentElement;
    expect(passwordField?.textContent).toContain('Password');
    expect(passwordField?.textContent).not.toContain('New password');
  });

  it('добавляет профиль и отправляет его в saveProxy (structured payload)', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-add'));

    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, 'newcorp');
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://new.corp:8080',
      );
    });
    await click(byTestId(container, 'proxy-profile-form-apply'));
    await click(byTestId(container, 'proxy-save'));

    const input = lastSaveInput();
    expect(input.profiles.newcorp).toEqual({ url: 'http://new.corp:8080' });
    expect(input.mode).toBe('all');
    expect(input.defaultProfile).toBe('corp');
    expect(input).not.toHaveProperty('url');
    expect(input).not.toHaveProperty('auth');
    expect(input).not.toHaveProperty('tls');
  });

  it('новый профиль: TLS-пути из формы сохраняются обычным PUT', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-add'));
    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, 'newcorp');
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://new.corp:8080',
      );
      setInputValue(
        byTestId(container, 'proxy-profile-tls-ca-file') as HTMLInputElement,
        '/etc/synth/ca.pem',
      );
      setInputValue(
        byTestId(container, 'proxy-profile-tls-cert-file') as HTMLInputElement,
        '/etc/synth/client.crt',
      );
      setInputValue(
        byTestId(container, 'proxy-profile-tls-key-file') as HTMLInputElement,
        '/etc/synth/client.key',
      );
    });
    await click(byTestId(container, 'proxy-profile-form-apply'));
    await click(byTestId(container, 'proxy-save'));

    expect(lastSaveInput().profiles.newcorp).toEqual({
      url: 'http://new.corp:8080',
      tls: {
        caFile: '/etc/synth/ca.pem',
        certFile: '/etc/synth/client.crt',
        keyFile: '/etc/synth/client.key',
      },
    });
  });

  it('имя профиля валидируется regex, дубликат запрещён', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-add'));

    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, 'Bad Name');
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://x:1',
      );
    });
    await click(byTestId(container, 'proxy-profile-form-apply'));
    expect(byTestId(container, 'proxy-profile-form-error')!.textContent).toContain(
      'Invalid profile name',
    );

    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, 'corp');
    });
    await click(byTestId(container, 'proxy-profile-form-apply'));
    expect(byTestId(container, 'proxy-profile-form-error')!.textContent).toContain(
      'already exists',
    );
  });

  it('редактирование URL/метки профиля уходит в saveProxy', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-edit-corp'));

    await act(async () => {
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://proxy.corp:8081',
      );
      setInputValue(byTestId(container, 'proxy-profile-form-label') as HTMLInputElement, 'Corp 2');
    });
    await click(byTestId(container, 'proxy-profile-form-apply'));
    await click(byTestId(container, 'proxy-save'));

    expect(lastSaveInput().profiles.corp).toMatchObject({
      label: 'Corp 2',
      url: 'http://proxy.corp:8081',
      auth: { type: 'basic', username: 'svc' },
    });
  });

  it('удаление default-профиля блокируется с причиной', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-delete-corp'));

    expect(byTestId(container, 'proxy-profile-delete-error')!.textContent).toContain(
      'default profile',
    );
    expect(byTestId(container, 'proxy-profile-corp')).not.toBeNull();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('удаление неиспользуемого профиля — с подтверждением, затем saveProxy', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-delete-spare'));
    await click(byTestId(container, 'proxy-save'));

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(lastSaveInput().profiles.spare).toBeUndefined();
  });

  it('профиль, используемый правилом, нельзя удалить', async () => {
    mocks.getProxy.mockResolvedValue(
      makeInfo({
        saved: { ...SAVED, defaultProfile: 'spare' },
        ...SAVED,
        defaultProfile: 'spare',
      }),
    );
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-delete-corp'));

    expect(byTestId(container, 'proxy-profile-delete-error')!.textContent).toContain('rules: r1');
  });
});

describe('ProxyStatusSection — пароль нового профиля (после сохранения)', () => {
  const profileStatus = (name: string, url: string) => ({
    name,
    url,
    legacy: false,
    source: 'runtime' as const,
    password: { source: 'none' as const, set: false, removable: false },
  });

  it('поле пароля в форме нового профиля; Apply держит его в черновике, Save применяет после saveProxy', async () => {
    mocks.saveProxy.mockResolvedValue({
      saved: {
        ...SAVED,
        profiles: { ...SAVED.profiles, newcorp: profileStatus('newcorp', 'http://new.corp:8080') },
      },
      running: RUNNING,
      restartRequired: true,
    });
    const container = await renderSection();

    await click(byTestId(container, 'proxy-profile-add'));
    const passwordInput = byTestId(container, 'proxy-profile-password-input') as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    expect(passwordInput.type).toBe('password');
    // Для нового профиля Set/Clear не нужны.
    expect(byTestId(container, 'proxy-profile-password-set')).toBeNull();
    expect(byTestId(container, 'proxy-profile-password-clear')).toBeNull();

    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, 'newcorp');
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://new.corp:8080',
      );
      setInputValue(byTestId(container, 'proxy-profile-form-username') as HTMLInputElement, 'svc');
      setInputValue(passwordInput, 'p@ss-value');
    });
    await click(byTestId(container, 'proxy-profile-form-apply'));
    expect(container.textContent).not.toContain('p@ss-value');

    await click(byTestId(container, 'proxy-save'));

    const input = lastSaveInput();
    expect(input.profiles.newcorp).toEqual({
      url: 'http://new.corp:8080',
      auth: { type: 'basic', username: 'svc' },
    });
    expect(JSON.stringify(input)).not.toContain('p@ss-value');
    expect(JSON.stringify(input)).not.toContain('pendingPassword');
    expect(mocks.setProfilePassword).toHaveBeenCalledWith('newcorp', 'p@ss-value');
    expect(mocks.saveProxy.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.setProfilePassword.mock.invocationCallOrder[0]!,
    );
    // Пароль из ответа применяется к saved-статусу сразу (бейдж).
    expect(byTestId(container, 'proxy-profile-password-badge-newcorp')!.textContent).toBe(
      'password set',
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    );
  });

  it('409 при применении пароля: saveProxy выполнен, профиль сохранён, показана ошибка', async () => {
    mocks.setProfilePassword.mockRejectedValue(
      Object.assign(new Error('conflict'), { status: 409 }),
    );
    mocks.saveProxy.mockResolvedValue({
      saved: {
        ...SAVED,
        profiles: { ...SAVED.profiles, newcorp: profileStatus('newcorp', 'http://new.corp:8080') },
      },
      running: RUNNING,
      restartRequired: true,
    });
    const container = await renderSection();
    await addNewProfile(container, 'newcorp', 'http://new.corp:8080', { password: 'pw' });
    await click(byTestId(container, 'proxy-save'));

    expect(mocks.saveProxy).toHaveBeenCalledTimes(1);
    expect(byTestId(container, 'proxy-profile-newcorp')).not.toBeNull();
    expect(byTestId(container, 'proxy-profile-password-badge-newcorp')!.textContent).toBe(
      'no password',
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        category: 'error',
        text: expect.stringContaining('environment'),
      }),
    );
    expect(mocks.notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('несколько новых профилей с паролями — применяются оба', async () => {
    mocks.saveProxy.mockResolvedValue({
      saved: {
        ...SAVED,
        profiles: {
          ...SAVED.profiles,
          one: profileStatus('one', 'http://one:1'),
          two: profileStatus('two', 'http://two:2'),
        },
      },
      running: RUNNING,
      restartRequired: true,
    });
    const container = await renderSection();

    await addNewProfile(container, 'one', 'http://one:1', { username: 'u1', password: 'p1' });
    await addNewProfile(container, 'two', 'http://two:2', { username: 'u2', password: 'p2' });
    await click(byTestId(container, 'proxy-save'));

    expect(mocks.setProfilePassword).toHaveBeenCalledTimes(2);
    expect(mocks.setProfilePassword).toHaveBeenCalledWith('one', 'p1');
    expect(mocks.setProfilePassword).toHaveBeenCalledWith('two', 'p2');
    expect(byTestId(container, 'proxy-profile-password-badge-one')!.textContent).toBe(
      'password set',
    );
    expect(byTestId(container, 'proxy-profile-password-badge-two')!.textContent).toBe(
      'password set',
    );
  });

  it('пароль без логина — мягкая подсказка, Apply не блокируется', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-add'));
    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, 'nologin');
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://nologin:1',
      );
      setInputValue(byTestId(container, 'proxy-profile-password-input') as HTMLInputElement, 'pw');
    });

    expect(byTestId(container, 'proxy-profile-password-no-username')).not.toBeNull();
    await click(byTestId(container, 'proxy-profile-form-apply'));
    expect(byTestId(container, 'proxy-profile-nologin')).not.toBeNull();
  });
});

describe('ProxyStatusSection — пароль профиля (write-only)', () => {
  it('«Задать» отправляет пароль, очищает поле и не показывает значение', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-edit-corp'));

    const input = byTestId(container, 'proxy-profile-password-input') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, 's3cret-value');
    });
    await click(byTestId(container, 'proxy-profile-password-set'));

    expect(mocks.setProfilePassword).toHaveBeenCalledWith('corp', 's3cret-value');
    expect(input.value).toBe('');
    expect(container.textContent).not.toContain('s3cret-value');
    expect(byTestId(container, 'proxy-profile-password-status')!.textContent).toBe(
      'secrets/proxy-password',
    );
  });

  it('пароль из env: поле/кнопки disabled + подсказка', async () => {
    mocks.getProxy.mockResolvedValue(
      makeInfo({
        saved: {
          ...SAVED,
          profiles: {
            ...SAVED.profiles,
            corp: { ...CORP, password: { source: 'env', set: true, removable: false } },
          },
        },
      }),
    );
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-edit-corp'));

    expect((byTestId(container, 'proxy-profile-password-input') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((byTestId(container, 'proxy-profile-password-set') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(byTestId(container, 'proxy-profile-password-env-hint')!.textContent).toContain('corp');
  });

  it('409 при задании пароля — понятный текст про env', async () => {
    mocks.setProfilePassword.mockRejectedValue(
      Object.assign(new Error('conflict'), { status: 409 }),
    );
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-edit-corp'));
    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-password-input') as HTMLInputElement, 'x');
    });
    await click(byTestId(container, 'proxy-profile-password-set'));

    expect(byTestId(container, 'proxy-profile-password-error')!.textContent).toContain(
      'environment',
    );
  });
});

describe('ProxyStatusSection — TLS профиля (write-only)', () => {
  it('«Загрузить» CA валидирует PEM и вызывает uploadProfileCa; PEM не остаётся в DOM', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-edit-corp'));

    await act(async () => {
      setInputValue(
        byTestId(container, 'proxy-profile-tls-ca-pem') as HTMLInputElement,
        '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      );
    });
    await click(byTestId(container, 'proxy-profile-tls-ca-upload'));

    expect(mocks.validateTls).toHaveBeenCalledWith({
      caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    });
    expect(mocks.uploadProfileCa).toHaveBeenCalledWith(
      'corp',
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    );
    expect(container.textContent).not.toContain('MIIB');
    expect(byTestId(container, 'proxy-profile-tls-ca-pem')).not.toBeNull();
  });

  it('«Удалить» CA подтверждается и вызывает removeProfileCa', async () => {
    mocks.getProxy.mockResolvedValue(
      makeInfo({
        saved: {
          ...SAVED,
          profiles: {
            ...SAVED.profiles,
            corp: {
              ...CORP,
              tls: {
                caFile: '/secrets/proxy/corp/ca.pem',
                hasCaPem: false,
                rejectUnauthorized: true,
              },
            },
          },
        },
      }),
    );
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-edit-corp'));
    await click(byTestId(container, 'proxy-profile-tls-ca-remove'));

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.removeProfileCa).toHaveBeenCalledWith('corp');
  });

  it('rejectUnauthorized и пути TLS сохраняются в профиле при Save', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-edit-corp'));

    await act(async () => {
      setInputValue(
        byTestId(container, 'proxy-profile-tls-ca-file') as HTMLInputElement,
        '/etc/synth/ca.pem',
      );
    });
    await click(byTestId(container, 'proxy-profile-form-apply'));
    await click(byTestId(container, 'proxy-save'));

    expect(lastSaveInput().profiles.corp).toMatchObject({
      tls: { caFile: '/etc/synth/ca.pem' },
    });
  });
});

describe('ProxyStatusSection — TLS нового профиля (pending до сохранения)', () => {
  const PEM = '-----BEGIN CERTIFICATE-----\nNEWCA\n-----END CERTIFICATE-----';
  const CERT = '-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----';
  const KEY = '-----BEGIN PRIVATE KEY-----\nKEYDATA\n-----END PRIVATE KEY-----';

  it('TLS-блок доступен сразу, CA ждёт Save и загружается после saveProxy', async () => {
    const savedWithProfile = {
      ...SAVED,
      profiles: {
        ...SAVED.profiles,
        newcorp: serverProfileStatus('newcorp', 'http://new.corp:8080'),
      },
    };
    const savedWithTls = {
      ...SAVED,
      profiles: {
        ...SAVED.profiles,
        newcorp: serverProfileStatus('newcorp', 'http://new.corp:8080', {
          caFile: '/data/secrets/proxy/newcorp/ca.pem',
          hasCaPem: true,
          rejectUnauthorized: true,
        }),
      },
    };
    mocks.saveProxy.mockResolvedValue({
      saved: savedWithProfile,
      running: RUNNING,
      restartRequired: true,
    });
    mocks.uploadProfileCa.mockResolvedValue({ status: savedWithTls, restartRequired: true });

    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-add'));

    // Блок TLS доступен в новом профиле; upload/remove скрыты.
    expect(byTestId(container, 'proxy-profile-tls-ca-pem')).not.toBeNull();
    expect(byTestId(container, 'proxy-profile-tls-ca-file-input')).not.toBeNull();
    const certInput = byTestId(
      container,
      'proxy-profile-tls-client-cert-input',
    ) as HTMLInputElement;
    const keyInput = byTestId(container, 'proxy-profile-tls-client-key-input') as HTMLInputElement;
    expect(certInput).not.toBeNull();
    expect(keyInput).not.toBeNull();
    expect(certInput.disabled).toBe(false);
    expect(keyInput.disabled).toBe(false);
    expect(byTestId(container, 'proxy-profile-tls-ca-upload')).toBeNull();
    expect(byTestId(container, 'proxy-profile-tls-ca-remove')).toBeNull();
    expect(byTestId(container, 'proxy-profile-tls-pending-hint')!.textContent).toContain(
      'after the profile is saved',
    );

    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, 'newcorp');
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://new.corp:8080',
      );
      setInputValue(byTestId(container, 'proxy-profile-tls-ca-pem') as HTMLTextAreaElement, PEM);
    });
    await click(byTestId(container, 'proxy-profile-form-apply'));

    // PEM остался в клиентском pending-поле, но не в DOM.
    expect(container.textContent).not.toContain('NEWCA');

    await click(byTestId(container, 'proxy-save'));

    const payload = lastSaveInput();
    expect(payload.profiles.newcorp).toEqual({ url: 'http://new.corp:8080' });
    expect(JSON.stringify(payload)).not.toContain('NEWCA');
    expect(JSON.stringify(payload)).not.toContain('pendingCaPem');

    expect(mocks.uploadProfileCa).toHaveBeenCalledWith('newcorp', PEM);
    expect(mocks.saveProxy.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.uploadProfileCa.mock.invocationCallOrder[0]!,
    );
    // Статус TLS обновлён из ответа upload.
    expect(byTestId(container, 'proxy-profile-tls-newcorp')).not.toBeNull();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    );
  });

  it('client cert+key нового профиля уходят в uploadProfileClient после saveProxy', async () => {
    mocks.saveProxy.mockResolvedValue({
      saved: {
        ...SAVED,
        profiles: {
          ...SAVED.profiles,
          newcorp: serverProfileStatus('newcorp', 'http://new.corp:8080'),
        },
      },
      running: RUNNING,
      restartRequired: true,
    });

    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-add'));
    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, 'newcorp');
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://new.corp:8080',
      );
    });
    await setFileInput(byTestId(container, 'proxy-profile-tls-client-cert-input'), CERT);
    await setFileInput(byTestId(container, 'proxy-profile-tls-client-key-input'), KEY);
    await click(byTestId(container, 'proxy-profile-form-apply'));
    await click(byTestId(container, 'proxy-save'));

    expect(JSON.stringify(lastSaveInput())).not.toContain('CLIENT');
    expect(mocks.uploadProfileClient).toHaveBeenCalledWith('newcorp', CERT, KEY);
    expect(mocks.saveProxy.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.uploadProfileClient.mock.invocationCallOrder[0]!,
    );
  });

  it('сертификат без ключа — ошибка формы, Apply не закрывает форму', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-add'));
    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, 'newcorp');
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://new.corp:8080',
      );
    });
    await setFileInput(byTestId(container, 'proxy-profile-tls-client-cert-input'), CERT);
    await click(byTestId(container, 'proxy-profile-form-apply'));

    expect(byTestId(container, 'proxy-profile-form-error')!.textContent).toContain(
      'both the client certificate and the private key',
    );
    expect(byTestId(container, 'proxy-profile-newcorp')).toBeNull();
    expect(byTestId(container, 'proxy-profile-form')).not.toBeNull();

    await click(byTestId(container, 'proxy-save'));
    expect(mocks.saveProxy).not.toHaveBeenCalled();
  });

  it('ошибка загрузки TLS не отменяет сохранение и показывает причину', async () => {
    mocks.uploadProfileCa.mockRejectedValue(new Error('mount failed'));
    mocks.saveProxy.mockResolvedValue({
      saved: {
        ...SAVED,
        profiles: {
          ...SAVED.profiles,
          newcorp: serverProfileStatus('newcorp', 'http://new.corp:8080'),
        },
      },
      running: RUNNING,
      restartRequired: true,
    });

    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-add'));
    await act(async () => {
      setInputValue(byTestId(container, 'proxy-profile-form-name') as HTMLInputElement, 'newcorp');
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://new.corp:8080',
      );
      setInputValue(byTestId(container, 'proxy-profile-tls-ca-pem') as HTMLTextAreaElement, PEM);
    });
    await click(byTestId(container, 'proxy-profile-form-apply'));
    await click(byTestId(container, 'proxy-save'));

    expect(mocks.saveProxy).toHaveBeenCalledTimes(1);
    expect(byTestId(container, 'proxy-profile-newcorp')).not.toBeNull();
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        category: 'error',
        text: expect.stringContaining('mount failed'),
      }),
    );
    expect(mocks.notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
});

describe('ProxyStatusSection — правила', () => {
  it('добавляет правило с hosts/label и отправляет в saveProxy', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-rule-add'));
    await addHost(container, 'api.openai.com');

    await act(async () => {
      setInputValue(byTestId(container, 'proxy-rule-form-label') as HTMLInputElement, 'OpenAI');
    });
    await click(byTestId(container, 'proxy-rule-form-apply'));
    await click(byTestId(container, 'proxy-save'));

    expect(lastSaveInput().rules).toHaveLength(2);
    expect(lastSaveInput().rules[1]).toMatchObject({
      label: 'OpenAI',
      hosts: ['api.openai.com'],
      action: 'proxy',
    });
  });

  it('редактирует правило', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-rule-edit-r1'));
    await act(async () => {
      setInputValue(byTestId(container, 'proxy-rule-form-label') as HTMLInputElement, 'Updated');
    });
    await click(byTestId(container, 'proxy-rule-form-apply'));
    await click(byTestId(container, 'proxy-save'));

    expect(lastSaveInput().rules[0]).toMatchObject({
      id: 'r1',
      label: 'Updated',
      hosts: ['*.example.com'],
      action: 'proxy',
      profile: 'corp',
    });
  });

  it('перестановка вверх/вниз меняет порядок (приоритет)', async () => {
    mocks.getProxy.mockResolvedValue(
      makeInfo({
        saved: {
          ...SAVED,
          rules: [
            { id: 'r1', hosts: ['a.example'], action: 'proxy', profile: 'corp' },
            { id: 'r2', hosts: ['b.example'], action: 'direct' },
          ],
        },
      }),
    );
    const container = await renderSection();
    await click(container.querySelector('[data-testid^="proxy-rule-down-"]') as HTMLElement);
    await click(byTestId(container, 'proxy-save'));

    expect(lastSaveInput().rules.map((rule) => rule.id)).toEqual(['r2', 'r1']);
  });

  it('удаление правила', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-rule-delete-r1'));
    await click(byTestId(container, 'proxy-save'));

    expect(lastSaveInput().rules).toHaveLength(0);
  });

  it('mode=selected без правил: предупреждение и Save заблокирован', async () => {
    mocks.getProxy.mockResolvedValue(
      makeInfo({
        saved: { ...SAVED, mode: 'selected', rules: [] },
      }),
    );
    const container = await renderSection();

    expect(byTestId(container, 'proxy-mode-selected-warning')).not.toBeNull();

    const switches = [
      ...container.querySelectorAll('button[role="switch"]'),
    ] as HTMLButtonElement[];
    await click(switches[0]!);
    expect((byTestId(container, 'proxy-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ProxyStatusSection — сохранение legacy и redaction', () => {
  it('legacy flat-конфигурация конвертируется в profiles.default (scheme-поля сохраняются)', async () => {
    const legacy = {
      enabled: true,
      source: 'config' as const,
      mode: 'all' as const,
      url: 'http://legacy:3128',
      httpsProxy: 'http://legacy-https:3128',
      noProxy: ['localhost'],
      fromEnv: false,
      fallbackDirect: false,
      connectTimeoutMs: 5000,
      restartRequired: true as const,
      profiles: {},
      rules: [],
    };
    mocks.getProxy.mockResolvedValue({
      ...legacy,
      saved: legacy,
      running: RUNNING,
      isOverridden: false,
      defaults: legacy,
      password: { source: 'none', set: false, removable: false },
      restartRequired: true,
    });
    const container = await renderSection();

    // Профиль синтезирован из legacy-полей.
    expect(byTestId(container, 'proxy-profile-default')).not.toBeNull();
    expect(byTestId(container, 'proxy-profile-default')!.textContent).toContain(
      'http://legacy:3128',
    );

    // Меняем timeout — этого достаточно для dirty.
    await act(async () => {
      setInputValue(byTestId(container, 'proxy-form-timeout') as HTMLInputElement, '6000');
    });
    await click(byTestId(container, 'proxy-save'));

    const input = lastSaveInput();
    expect(input.profiles.default).toEqual({
      url: 'http://legacy:3128',
      httpsProxy: 'http://legacy-https:3128',
    });
    expect(input).not.toHaveProperty('url');
    expect(input).not.toHaveProperty('httpProxy');
    expect(input).not.toHaveProperty('httpsProxy');
    expect(input).not.toHaveProperty('auth');
    expect(input).not.toHaveProperty('tls');
  });

  it('после сохранения — плашка рестарта и success-тост', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-profile-edit-spare'));
    await act(async () => {
      setInputValue(
        byTestId(container, 'proxy-profile-form-url') as HTMLInputElement,
        'http://spare:9999',
      );
    });
    await click(byTestId(container, 'proxy-profile-form-apply'));
    await click(byTestId(container, 'proxy-save'));

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    );
    expect(byTestId(container, 'proxy-status-restart')).not.toBeNull();
  });
});

describe('ProxyStatusSection — проверка target URL', () => {
  it('показывает правило/профиль/прокси/ok/http/latency/usingSaved', async () => {
    const container = await renderSection();
    await act(async () => {
      setInputValue(
        byTestId(container, 'proxy-target-url') as HTMLInputElement,
        'https://api.example.com',
      );
    });
    await click(byTestId(container, 'proxy-target-check'));

    expect(mocks.testProxyRoute).toHaveBeenCalledWith('https://api.example.com');
    const result = byTestId(container, 'proxy-target-result')!;
    expect(result.textContent).toContain('Request succeeded');
    expect(result.textContent).toContain('Example');
    expect(result.textContent).toContain('Corp (corp)');
    expect(result.textContent).toContain('http://proxy.corp:3128');
    expect(result.textContent).toContain('HTTP status: 200');
    expect(result.textContent).toContain('42 ms');
    expect(result.textContent).toContain('saved configuration');
  });

  it('неуспешная проверка показывает error', async () => {
    mocks.testProxyRoute.mockResolvedValue({
      url: 'https://blocked.example',
      route: { action: 'direct', via: 'direct', reason: 'no-match' },
      ok: false,
      latencyMs: 0,
      authChallenge: 'none',
      error: 'egress: host not allowed',
      usingSaved: true,
      restartRequired: false,
    });
    const container = await renderSection();
    await act(async () => {
      setInputValue(
        byTestId(container, 'proxy-target-url') as HTMLInputElement,
        'https://blocked.example',
      );
    });
    await click(byTestId(container, 'proxy-target-check'));

    const result = byTestId(container, 'proxy-target-result')!;
    expect(result.textContent).toContain('Request failed');
    expect(result.textContent).toContain('egress: host not allowed');
    expect(result.textContent).toContain('no rule');
  });

  it('пустой URL — inline-ошибка без вызова API', async () => {
    const container = await renderSection();
    await click(byTestId(container, 'proxy-target-check'));

    expect(mocks.testProxyRoute).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Enter a target URL');
  });

  it('ошибка API проверки — inline-сообщение', async () => {
    mocks.testProxyRoute.mockRejectedValue(new Error('url: некорректный URL'));
    const container = await renderSection();
    await act(async () => {
      setInputValue(byTestId(container, 'proxy-target-url') as HTMLInputElement, 'not-a-url');
    });
    await click(byTestId(container, 'proxy-target-check'));

    expect(byTestId(container, 'proxy-target-error')!.textContent).toContain('некорректный URL');
  });
});
