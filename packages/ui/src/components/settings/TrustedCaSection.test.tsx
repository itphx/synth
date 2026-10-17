import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getTls: vi.fn(),
  updateTls: vi.fn(),
  uploadCa: vi.fn(),
  removeCa: vi.fn(),
  setDefaultClient: vi.fn(),
  removeDefaultClient: vi.fn(),
  createTlsMapping: vi.fn(),
  updateTlsMapping: vi.fn(),
  deleteTlsMapping: vi.fn(),
  validateTls: vi.fn(),
  getProxy: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TrustedCaSection } from './TrustedCaSection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const MAPPING = {
  id: 'm1',
  hosts: ['api.corp.local', '*.corp.local'],
  label: 'corp',
  certSubject: 'CN=mapped-client',
  source: 'runtime' as const,
  readOnly: false,
}

const BASE_STATUS = {
  ca: { source: 'runtime' as const, count: 1, subjects: ['CN=Corp CA'] },
  rejectUnauthorized: true,
  defaultClient: {
    source: 'runtime' as const,
    certSubject: 'CN=default-client',
    hasKey: true,
    readOnly: false,
  },
  mappings: [MAPPING],
  params: {} as Record<string, unknown>,
}

function makeInfo(
  over: Record<string, unknown> = {},
  statusOver: Record<string, unknown> = {},
): Record<string, unknown> {
  const status = { ...BASE_STATUS, ...statusOver }
  return {
    status,
    ...status,
    saved: status,
    running: status,
    defaults: status,
    restartRequired: true,
    ...over,
  }
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Файл-заглушка с `.text()` — без FileReader/jsdom-особенностей. */
const fakeFile = (content: string) =>
  ({ text: async () => content }) as unknown as File

async function selectFiles(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})
}

async function renderSection(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TrustedCaSection />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

const click = async (el: HTMLElement | null): Promise<void> => {
  expect(el, 'element').toBeTruthy()
  await act(async () => {
    el!.click()
  })
  await act(async () => {})
}

const okValidate = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  errors: [],
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getTls.mockResolvedValue(makeInfo())
  mocks.updateTls.mockResolvedValue({ status: BASE_STATUS, restartRequired: true })
  mocks.uploadCa.mockResolvedValue({ status: BASE_STATUS, restartRequired: true })
  mocks.removeCa.mockResolvedValue({ status: BASE_STATUS, restartRequired: true })
  mocks.setDefaultClient.mockResolvedValue({ status: BASE_STATUS, restartRequired: true })
  mocks.removeDefaultClient.mockResolvedValue({ status: BASE_STATUS, restartRequired: true })
  mocks.createTlsMapping.mockResolvedValue({
    status: BASE_STATUS,
    restartRequired: true,
    mapping: MAPPING,
  })
  mocks.updateTlsMapping.mockResolvedValue({
    status: BASE_STATUS,
    restartRequired: true,
    mapping: MAPPING,
  })
  mocks.deleteTlsMapping.mockResolvedValue({ status: BASE_STATUS, restartRequired: true })
  mocks.validateTls.mockResolvedValue(okValidate({ caCount: 1, caSubjects: ['CN=Corp CA'] }))
  mocks.getProxy.mockResolvedValue({
    enabled: true,
    source: 'config',
    url: 'http://proxy.local:3128',
    noProxy: [],
    fallbackDirect: false,
    connectTimeoutMs: 5000,
    saved: {
      enabled: true,
      source: 'config',
      url: 'http://proxy.local:3128',
      noProxy: [],
      fallbackDirect: false,
      connectTimeoutMs: 5000,
      restartRequired: true,
      tls: { caFile: '/etc/proxy-ca.pem', hasCaPem: false, rejectUnauthorized: false },
    },
  })
  mocks.confirm.mockResolvedValue(true)
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('TrustedCaSection — статус и read-only параметры', () => {
  it('показывает CA source/count/subjects, client и restart-баннер', async () => {
    const container = await renderSection()

    expect(mocks.getTls).toHaveBeenCalledTimes(1)
    expect(mocks.getProxy).toHaveBeenCalledTimes(1)
    expect(byTestId(container, 'tls-status-ca-count')!.textContent).toBe('1 certificate')
    expect(byTestId(container, 'tls-status-ca-subjects')!.textContent).toContain('CN=Corp CA')
    expect(byTestId(container, 'tls-status-client-subject')!.textContent).toContain(
      'CN=default-client',
    )
    expect(byTestId(container, 'tls-restart')!.textContent).toContain(
      'TLS changes take effect after an instance restart',
    )
  })

  it('restart-баннер скрыт, когда рестарт не требуется', async () => {
    mocks.getTls.mockResolvedValue(makeInfo({ restartRequired: false }))
    const container = await renderSection()
    expect(byTestId(container, 'tls-restart')).toBeNull()
  })

  it('read-only блок «Из параметров» показывает CA/клиента из config/env', async () => {
    mocks.getTls.mockResolvedValue(
      makeInfo({}, {
        ca: { source: 'config', count: 1, subjects: ['CN=Config CA'] },
        defaultClient: {
          source: 'config',
          certSubject: 'CN=config-client',
          hasKey: true,
          readOnly: true,
        },
        params: {
          ca: { source: 'config', caFile: '/etc/synth/ca.pem', hasPem: false },
          client: {
            source: 'config',
            certFile: '/etc/synth/client.crt',
            keyFile: '/etc/synth/client.key',
            readOnly: true,
          },
        },
      }),
    )
    const container = await renderSection()

    expect(byTestId(container, 'tls-params')).not.toBeNull()
    expect(byTestId(container, 'tls-params-ca')!.textContent).toContain('/etc/synth/ca.pem')
    expect(byTestId(container, 'tls-params-client')!.textContent).toContain(
      '/etc/synth/client.crt',
    )
    expect(byTestId(container, 'tls-params-client')!.textContent).toContain(
      '/etc/synth/client.key',
    )
    // Default client из config — read-only: полей загрузки нет.
    expect(byTestId(container, 'tls-client-readonly')).not.toBeNull()
    expect(byTestId(container, 'tls-client-cert-file')).toBeNull()
  })

  it('CA из env — редактор скрыт, показана пометка read-only', async () => {
    mocks.getTls.mockResolvedValue(
      makeInfo({}, { ca: { source: 'env', count: 1, subjects: ['CN=Env CA'] } }),
    )
    const container = await renderSection()

    expect(byTestId(container, 'tls-ca-readonly')).not.toBeNull()
    expect(byTestId(container, 'tls-ca-input')).toBeNull()
    expect(container.textContent).toContain('CA is set via environment variables')
  })

  it('ошибка загрузки статуса — inline-сообщение и error-тост', async () => {
    mocks.getTls.mockRejectedValue(new Error('boom'))
    const container = await renderSection()
    expect(byTestId(container, 'tls-load-error')!.textContent).toContain('boom')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', category: 'error' }),
    )
  })
})

describe('TrustedCaSection — CA', () => {
  it('«Проверить» вызывает validateTls и показывает caCount/subjects', async () => {
    const container = await renderSection()
    await act(async () => {
      setValue(byTestId(container, 'tls-ca-input') as HTMLTextAreaElement, 'CA-PEM')
    })
    await click(byTestId(container, 'tls-ca-validate'))

    expect(mocks.validateTls).toHaveBeenCalledWith({ caPem: 'CA-PEM' })
    const result = byTestId(container, 'tls-ca-result')!
    expect(result.textContent).toContain('Validation passed')
    expect(result.textContent).toContain('CA: 1 certificates')
    expect(result.textContent).toContain('CN=Corp CA')
  })

  it('«Загрузить» валидирует и вызывает uploadCa, затем перезагружает статус', async () => {
    const container = await renderSection()
    await act(async () => {
      setValue(byTestId(container, 'tls-ca-input') as HTMLTextAreaElement, 'CA-PEM')
    })
    await click(byTestId(container, 'tls-ca-upload'))

    expect(mocks.validateTls).toHaveBeenCalledWith({ caPem: 'CA-PEM' })
    expect(mocks.uploadCa).toHaveBeenCalledWith('CA-PEM')
    expect(mocks.getTls).toHaveBeenCalledTimes(2)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
    expect((byTestId(container, 'tls-ca-input') as HTMLTextAreaElement).value).toBe('')
  })

  it('ошибка валидации блокирует загрузку', async () => {
    mocks.validateTls.mockResolvedValue({ ok: false, errors: ['bad PEM'] })
    const container = await renderSection()
    await act(async () => {
      setValue(byTestId(container, 'tls-ca-input') as HTMLTextAreaElement, 'BAD')
    })
    await click(byTestId(container, 'tls-ca-upload'))

    expect(mocks.uploadCa).not.toHaveBeenCalled()
    expect(byTestId(container, 'tls-ca-error')!.textContent).toContain('bad PEM')
  })

  it('409 при загрузке — понятный текст про config/env', async () => {
    mocks.uploadCa.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }))
    const container = await renderSection()
    await act(async () => {
      setValue(byTestId(container, 'tls-ca-input') as HTMLTextAreaElement, 'CA-PEM')
    })
    await click(byTestId(container, 'tls-ca-upload'))

    expect(byTestId(container, 'tls-ca-error')!.textContent).toContain(
      'managed by config.yaml/env',
    )
  })

  it('«Сбросить runtime CA» подтверждается и вызывает removeCa', async () => {
    const container = await renderSection()
    await click(byTestId(container, 'tls-ca-reset'))

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.removeCa).toHaveBeenCalledTimes(1)
  })

  it('сброс недоступен, когда runtime CA нет', async () => {
    mocks.getTls.mockResolvedValue(
      makeInfo({}, { ca: { source: 'none', count: 0, subjects: [] } }),
    )
    const container = await renderSection()
    expect((byTestId(container, 'tls-ca-reset') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('TrustedCaSection — default client', () => {
  it('загрузка cert+key: валидация, setDefaultClient и скрытие PEM', async () => {
    mocks.validateTls.mockResolvedValue(
      okValidate({ certSubject: 'CN=new-client', keyMatches: true }),
    )
    const container = await renderSection()
    await selectFiles(byTestId(container, 'tls-client-cert-file') as HTMLInputElement, [
      fakeFile('CERT-PEM'),
    ])
    await selectFiles(byTestId(container, 'tls-client-key-file') as HTMLInputElement, [
      fakeFile('KEY-PEM'),
    ])

    await click(byTestId(container, 'tls-client-validate'))
    expect(mocks.validateTls).toHaveBeenCalledWith({ certPem: 'CERT-PEM', keyPem: 'KEY-PEM' })
    expect(byTestId(container, 'tls-client-result')!.textContent).toContain(
      'Key matches certificate',
    )

    await click(byTestId(container, 'tls-client-upload'))
    expect(mocks.setDefaultClient).toHaveBeenCalledWith('CERT-PEM', 'KEY-PEM')

    // PEM/ключ не попадают в DOM и не остаются в полях.
    expect(container.textContent).not.toContain('CERT-PEM')
    expect(container.textContent).not.toContain('KEY-PEM')
    expect((byTestId(container, 'tls-client-cert-file') as HTMLInputElement).value).toBe('')
  })

  it('удаление default client — confirm + removeDefaultClient', async () => {
    const container = await renderSection()
    await click(byTestId(container, 'tls-client-delete'))

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.removeDefaultClient).toHaveBeenCalledTimes(1)
  })

  it('без default client кнопка удаления неактивна', async () => {
    mocks.getTls.mockResolvedValue(makeInfo({}, { defaultClient: undefined }))
    const container = await renderSection()
    expect((byTestId(container, 'tls-client-delete') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('TrustedCaSection — маппинги', () => {
  it('таблица показывает hosts/label/certSubject/source', async () => {
    const container = await renderSection()
    const row = byTestId(container, 'tls-mapping-m1')!
    expect(row.textContent).toContain('api.corp.local')
    expect(row.textContent).toContain('*.corp.local')
    expect(row.textContent).toContain('corp')
    expect(row.textContent).toContain('CN=mapped-client')
    expect(row.textContent).toContain('runtime (UI)')
  })

  it('добавление: hosts/label + cert/key, валидация и createTlsMapping', async () => {
    mocks.validateTls.mockResolvedValue(okValidate({ certSubject: 'CN=new', keyMatches: true }))
    const container = await renderSection()
    await click(byTestId(container, 'tls-mapping-add'))

    const form = byTestId(container, 'tls-mapping-form')!
    const hostInput = form.querySelector('input[placeholder="api.corp.local"]') as HTMLInputElement
    await act(async () => {
      setValue(hostInput, '*.corp.local')
    })
    const addButton = [...form.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Add',
    ) as HTMLButtonElement
    await click(addButton)
    await act(async () => {
      setValue(byTestId(container, 'tls-mapping-label') as HTMLInputElement, 'corp')
    })
    await selectFiles(byTestId(container, 'tls-mapping-cert-file') as HTMLInputElement, [
      fakeFile('CERT-PEM'),
    ])
    await selectFiles(byTestId(container, 'tls-mapping-key-file') as HTMLInputElement, [
      fakeFile('KEY-PEM'),
    ])

    await click(byTestId(container, 'tls-mapping-save'))

    expect(mocks.validateTls).toHaveBeenCalledWith({
      hosts: ['*.corp.local'],
      certPem: 'CERT-PEM',
      keyPem: 'KEY-PEM',
    })
    expect(mocks.createTlsMapping).toHaveBeenCalledWith({
      hosts: ['*.corp.local'],
      label: 'corp',
      certPem: 'CERT-PEM',
      keyPem: 'KEY-PEM',
    })
    expect(byTestId(container, 'tls-mapping-form')).toBeNull()
  })

  it('wildcard «*» уходит как есть', async () => {
    mocks.validateTls.mockResolvedValue(okValidate({ hostPatternsValid: true }))
    const container = await renderSection()
    await click(byTestId(container, 'tls-mapping-add'))
    const form = byTestId(container, 'tls-mapping-form')!
    const hostInput = form.querySelector('input[placeholder="api.corp.local"]') as HTMLInputElement
    await act(async () => {
      setValue(hostInput, '*')
    })
    const addButton = [...form.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Add',
    ) as HTMLButtonElement
    await click(addButton)
    await selectFiles(byTestId(container, 'tls-mapping-cert-file') as HTMLInputElement, [
      fakeFile('CERT'),
    ])
    await selectFiles(byTestId(container, 'tls-mapping-key-file') as HTMLInputElement, [
      fakeFile('KEY'),
    ])
    await click(byTestId(container, 'tls-mapping-save'))

    expect(mocks.createTlsMapping).toHaveBeenCalledWith(
      expect.objectContaining({ hosts: ['*'] }),
    )
  })

  it('изменение: hosts/label без новой пары ключей', async () => {
    const container = await renderSection()
    await click(byTestId(container, 'tls-mapping-edit-m1'))
    await act(async () => {
      setValue(byTestId(container, 'tls-mapping-label') as HTMLInputElement, 'renamed')
    })
    await click(byTestId(container, 'tls-mapping-save'))

    expect(mocks.validateTls).toHaveBeenCalledWith({
      hosts: ['api.corp.local', '*.corp.local'],
    })
    expect(mocks.updateTlsMapping).toHaveBeenCalledWith('m1', {
      hosts: ['api.corp.local', '*.corp.local'],
      label: 'renamed',
    })
  })

  it('удаление маппинга — confirm + deleteTlsMapping', async () => {
    const container = await renderSection()
    await click(byTestId(container, 'tls-mapping-delete-m1'))

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteTlsMapping).toHaveBeenCalledWith('m1')
  })

  it('пустой список — пустое состояние', async () => {
    mocks.getTls.mockResolvedValue(makeInfo({}, { mappings: [] }))
    const container = await renderSection()
    expect(byTestId(container, 'tls-mappings-empty')).not.toBeNull()
  })
})

describe('TrustedCaSection — TLS к прокси (read-only)', () => {
  it('показывает метаданные TLS прокси из GET /settings/proxy', async () => {
    const container = await renderSection()
    const line = byTestId(container, 'tls-proxy-tls')!
    expect(line.textContent).toContain('/etc/proxy-ca.pem')
    expect(line.textContent).toContain('Verify proxy certificate: Disabled')
    expect(container.textContent).toContain('Configured in the Proxy block above')
  })
})
