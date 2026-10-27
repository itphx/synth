import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const mocks = vi.hoisted(() => ({
  getAttachmentsSettings: vi.fn(),
  updateAttachmentsSettings: vi.fn(),
  resetAttachmentsSettings: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: mocks,
  MODALITY_FAMILIES: ['image', 'pdf', 'audio', 'video'],
}))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useProvidersStore } from '@/stores/providersStore'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  MIB_BYTES,
  NOT_SET_MODALITY_MODEL,
  MultimodalSettings,
  buildAttachmentsBody,
  formFromAttachments,
  modalityModelKey,
  modelsForModality,
  parseMimePrefixes,
} from './MultimodalSettings'
import type {
  AttachmentsSettings,
  AttachmentsSettingsInfo,
  ModelInfo,
} from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const ATTACHMENTS: AttachmentsSettings = {
  enabled: true,
  modalities: { image: true, pdf: true, audio: false, video: false },
  maxBytesPerFile: 10 * MIB_BYTES,
  maxFilesPerMessage: 5,
  maxBytesPerSession: 100 * MIB_BYTES,
  gcDays: 7,
  workspaceFallback: false,
  allowedMimePrefixes: ['image/', 'application/pdf'],
}

const DEFAULTS: AttachmentsSettings = {
  ...ATTACHMENTS,
  modalities: { image: true, pdf: false, audio: false, video: false },
  maxBytesPerFile: 5 * MIB_BYTES,
  gcDays: 30,
}

const INFO: AttachmentsSettingsInfo = {
  attachments: ATTACHMENTS,
  defaults: DEFAULTS,
  isOverridden: true,
  source: 'runtime',
  envLocked: [],
  restartRequired: false,
  running: ATTACHMENTS,
}

/**
 * Каталог моделей (мок `useProvidersStore.models`): vision/PDF, аудио, видео,
 * видео-модель, чисто текстовая и модель без известных модальностей.
 */
const CATALOG: ModelInfo[] = [
  {
    id: 'openai/gpt-4o',
    name: 'gpt-4o',
    provider: 'openai',
    enabled: true,
    isDefault: true,
    modalities: ['text', 'image', 'pdf'],
  },
  {
    id: 'local/whisper',
    name: 'whisper',
    provider: 'local',
    enabled: true,
    isDefault: false,
    modalities: ['audio'],
  },
  {
    id: 'local/llava',
    name: 'llava',
    provider: 'local',
    enabled: true,
    isDefault: false,
    modalities: ['image'],
  },
  {
    id: 'local/movie',
    name: 'movie',
    provider: 'local',
    enabled: true,
    isDefault: false,
    modalities: ['video'],
  },
  {
    id: 'openai/gpt-3.5-turbo',
    name: 'gpt-3.5-turbo',
    provider: 'openai',
    enabled: true,
    isDefault: false,
    modalities: ['text'],
  },
  {
    id: 'openai/plain',
    name: 'plain',
    provider: 'openai',
    enabled: true,
    isDefault: false,
  },
]

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

const switchByLabel = (container: HTMLElement, label: string): HTMLButtonElement | null =>
  container.querySelector(`[role="switch"][aria-label="${label}"]`)

async function flush(): Promise<void> {
  await act(async () => {})
}

async function click(el: HTMLElement | null): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
  await flush()
}

/** Устанавливает значение контролируемого input так, чтобы React увидел `onChange`. */
async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

/** Открывает Base UI select и возвращает подписи опций (рендерятся в portal). */
async function openOptions(container: HTMLElement, testId: string): Promise<string[]> {
  const trigger = byTestId(container, testId)
  expect(trigger, `триггер ${testId}`).toBeTruthy()
  await act(async () => {
    ;(trigger as HTMLElement).click()
  })
  await flush()
  return [...document.body.querySelectorAll('[role="option"]')].map(
    (option) => option.textContent?.trim() ?? '',
  )
}

/** Выбирает опцию селекта строки «модель по модальности». */
async function selectModalityOption(
  container: HTMLElement,
  testId: string,
  optionText: string,
): Promise<void> {
  const trigger = byTestId(container, testId)
  expect(trigger, `триггер ${testId}`).toBeTruthy()
  await act(async () => {
    ;(trigger as HTMLElement).click()
  })
  const options = [...document.body.querySelectorAll('[role="option"]')] as HTMLElement[]
  const option = options.find((item) => item.textContent?.trim() === optionText)
  expect(option, `опция «${optionText}»`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
  await flush()
  await flush()
}

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({ settingsShowAdvanced: true, settingsFocus: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <MultimodalSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  useProvidersStore.setState({ models: CATALOG, error: null })
  mocks.getAttachmentsSettings.mockResolvedValue(INFO)
  mocks.updateAttachmentsSettings.mockResolvedValue({ ...INFO, source: 'runtime' })
  mocks.resetAttachmentsSettings.mockResolvedValue({
    ...INFO,
    attachments: DEFAULTS,
    isOverridden: false,
    source: 'default',
  })
})

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.container.remove()
  }
})

describe('MultimodalSettings — состояние и значения', () => {
  it('рендерит значения из GET /settings/attachments', async () => {
    const container = await renderSettings()

    expect(mocks.getAttachmentsSettings).toHaveBeenCalledTimes(1)

    // Источник + признак runtime-override + состояние запущенного процесса.
    expect(byTestId(container, 'attachments-source-badge')?.textContent).toBe('runtime (UI)')
    expect(byTestId(container, 'attachments-overridden-badge')?.textContent).toBe('overridden')
    expect(byTestId(container, 'attachments-running-badge')?.textContent).toBe('enabled')

    // Мастер-выключатель и модальности.
    expect(switchByLabel(container, 'Attachments enabled')?.getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(switchByLabel(container, 'Images')?.getAttribute('aria-checked')).toBe('true')
    expect(switchByLabel(container, 'PDF')?.getAttribute('aria-checked')).toBe('true')
    expect(switchByLabel(container, 'Audio')?.getAttribute('aria-checked')).toBe('false')
    expect(switchByLabel(container, 'Video')?.getAttribute('aria-checked')).toBe('false')

    // Лимиты: байты → MiB, MIME-список — строкой через запятую.
    expect((byTestId(container, 'attachments-max-file') as HTMLInputElement).value).toBe('10')
    expect((byTestId(container, 'attachments-max-files') as HTMLInputElement).value).toBe('5')
    expect((byTestId(container, 'attachments-max-session') as HTMLInputElement).value).toBe('100')
    expect((byTestId(container, 'attachments-gc-days') as HTMLInputElement).value).toBe('7')
    expect((byTestId(container, 'attachments-mime') as HTMLInputElement).value).toBe(
      'image/, application/pdf',
    )

    // Без правок сохранение недоступно.
    expect((byTestId(container, 'attachments-save') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId(container, 'attachments-cancel') as HTMLButtonElement).disabled).toBe(true)
  })

  it('сохраняет модальность и лимит (MiB → байты) полным телом секции', async () => {
    const container = await renderSettings()

    await click(switchByLabel(container, 'Images'))
    await setInputValue(byTestId(container, 'attachments-max-file') as HTMLInputElement, '20')

    expect((byTestId(container, 'attachments-save') as HTMLButtonElement).disabled).toBe(false)
    await click(byTestId(container, 'attachments-save'))

    expect(mocks.updateAttachmentsSettings).toHaveBeenCalledTimes(1)
    // PUT заменяет runtime-секцию целиком — уходят все поля, байты изменённого
    // лимита посчитаны из MiB, неизменённые взяты из сохранённых значений.
    expect(mocks.updateAttachmentsSettings).toHaveBeenCalledWith({
      enabled: true,
      modalities: { image: false, pdf: true, audio: false, video: false },
      maxBytesPerFile: 20 * MIB_BYTES,
      maxFilesPerMessage: 5,
      maxBytesPerSession: 100 * MIB_BYTES,
      gcDays: 7,
      workspaceFallback: false,
      allowedMimePrefixes: ['image/', 'application/pdf'],
      // ADR-115: назначения уходят целиком, не заданные — `null`.
      modalityModels: { image: null, pdf: null, audio: null, video: null },
    })
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Attachment settings saved' }),
    )
  })

  it('переключает лимит на сессию и срок хранения (байты/дни)', async () => {
    const container = await renderSettings()

    await setInputValue(byTestId(container, 'attachments-max-session') as HTMLInputElement, '1.5')
    await setInputValue(byTestId(container, 'attachments-gc-days') as HTMLInputElement, '0')
    await click(byTestId(container, 'attachments-save'))

    expect(mocks.updateAttachmentsSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBytesPerSession: Math.round(1.5 * MIB_BYTES),
        gcDays: 0,
      }),
    )
  })

  it('сбрасывает runtime-настройку через DELETE', async () => {
    const container = await renderSettings()

    const reset = byTestId(container, 'attachments-reset') as HTMLButtonElement
    expect(reset.disabled).toBe(false)
    await click(reset)

    expect(mocks.resetAttachmentsSettings).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Attachment settings saved' }),
    )
  })

  it('невалидные значения блокируют сохранение', async () => {
    const container = await renderSettings()

    await setInputValue(byTestId(container, 'attachments-max-file') as HTMLInputElement, '0')
    expect(container.textContent).toContain('Enter a positive number of MiB')
    expect((byTestId(container, 'attachments-save') as HTMLButtonElement).disabled).toBe(true)

    await setInputValue(byTestId(container, 'attachments-max-file') as HTMLInputElement, '10')

    // Пустой элемент между запятыми в MIME-списке — тоже ошибка.
    await setInputValue(byTestId(container, 'attachments-mime') as HTMLInputElement, 'image/,,text/plain')
    expect(container.textContent).toContain('Remove empty items between commas')
    expect((byTestId(container, 'attachments-save') as HTMLButtonElement).disabled).toBe(true)

    await click(byTestId(container, 'attachments-save'))
    expect(mocks.updateAttachmentsSettings).not.toHaveBeenCalled()
  })

  it('ошибка сохранения показывается тостом type=error', async () => {
    mocks.updateAttachmentsSettings.mockRejectedValue(new Error('boom'))
    const container = await renderSettings()

    await click(switchByLabel(container, 'Video'))
    await click(byTestId(container, 'attachments-save'))

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text: 'Failed to save settings: boom' }),
    )
  })
})

describe('MultimodalSettings — envLocked и источник env', () => {
  const ENV_INFO: AttachmentsSettingsInfo = {
    ...INFO,
    source: 'env',
    isOverridden: false,
    envLocked: ['maxBytesPerSession', 'modalities.image', 'enabled'],
  }

  beforeEach(() => {
    mocks.getAttachmentsSettings.mockResolvedValue(ENV_INFO)
  })

  it('показывает бейдж источника env и блокирует зафиксированные поля', async () => {
    const container = await renderSettings()

    expect(byTestId(container, 'attachments-source-badge')?.textContent).toBe('env')
    expect(byTestId(container, 'attachments-overridden-badge')).toBeNull()

    // Лимит на сессию задан через env — поле disabled.
    expect((byTestId(container, 'attachments-max-session') as HTMLInputElement).disabled).toBe(true)
    // Мастер-выключатель зафиксирован — тумблер недоступен и есть пояснение.
    const masterToggle = switchByLabel(container, 'Attachments enabled')
    expect(masterToggle?.getAttribute('aria-checked')).toBe('true')
    await click(masterToggle)
    expect(masterToggle?.getAttribute('aria-checked')).toBe('true')
    expect(byTestId(container, 'attachments-env-locked')).toBeTruthy()
    // Изображения зафиксированы точечно (`modalities.image`).
    const imageToggle = switchByLabel(container, 'Images')
    expect(imageToggle?.parentElement?.className).toContain('pointer-events-none')
    await click(imageToggle)
    expect(imageToggle?.getAttribute('aria-checked')).toBe('true')
  })

  it('env-зафиксированное поле не уходит в тело PUT', async () => {
    const container = await renderSettings()

    await setInputValue(byTestId(container, 'attachments-max-file') as HTMLInputElement, '15')
    await click(switchByLabel(container, 'PDF'))

    await click(byTestId(container, 'attachments-save'))

    const body = mocks.updateAttachmentsSettings.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.maxBytesPerFile).toBe(15 * MIB_BYTES)
    expect(body.modalities).toEqual({
      image: true,
      pdf: false,
      audio: false,
      video: false,
    })
    // env-зафиксированные поля в тело не попадают (иначе сервер ответит 409).
    expect(body).not.toHaveProperty('maxBytesPerSession')
  })
})

describe('MultimodalSettings — модели по модальностям (ADR-115)', () => {
  const ASSIGNED: AttachmentsSettings = {
    ...ATTACHMENTS,
    modalityModels: {
      image: { provider: 'openai', model: 'gpt-4o' },
      audio: { provider: 'local', model: 'whisper' },
    },
  }

  const ASSIGNED_INFO: AttachmentsSettingsInfo = {
    ...INFO,
    attachments: ASSIGNED,
    saved: {
      modalityModels: {
        image: { provider: 'openai', model: 'gpt-4o' },
        audio: { provider: 'local', model: 'whisper' },
      },
    },
  }

  beforeEach(() => {
    mocks.getAttachmentsSettings.mockResolvedValue(ASSIGNED_INFO)
  })

  it('рендерит четыре строки и подсказку о неизменности модели сессии', async () => {
    const container = await renderSettings()

    for (const family of ['image', 'pdf', 'audio', 'video']) {
      expect(byTestId(container, `attachments-modality-row-${family}`)).toBeTruthy()
      expect(byTestId(container, `attachments-modality-${family}`)).toBeTruthy()
    }

    // Текущие назначения видны в триггерах, незаданное — «Не задано (отбрасывать)».
    expect(byTestId(container, 'attachments-modality-image')?.textContent).toContain(
      'openai / gpt-4o',
    )
    expect(byTestId(container, 'attachments-modality-audio')?.textContent).toContain(
      'local / whisper',
    )
    expect(byTestId(container, 'attachments-modality-pdf')?.textContent).toContain(
      'Not set (drop)',
    )
    expect(byTestId(container, 'attachments-modality-hint')?.textContent).toContain(
      'the selected model processes the attachment and only text reaches the dialogue',
    )
  })

  it('предлагает только модели каталога с нужной модальностью', async () => {
    const container = await renderSettings()

    const imageOptions = await openOptions(container, 'attachments-modality-image')
    expect(imageOptions).toEqual(['Not set (drop)', 'openai / gpt-4o', 'local / llava'])
    // Модель без модальности изображения и модель без известных модальностей не предлагаются.
    expect(imageOptions).not.toContain('local / whisper')
    expect(imageOptions).not.toContain('openai / plain')
  })

  it('в списке PDF — только модели с модальностью pdf', async () => {
    const container = await renderSettings()

    expect(await openOptions(container, 'attachments-modality-pdf')).toEqual([
      'Not set (drop)',
      'openai / gpt-4o',
    ])
  })

  it('сброс строки отправляет null, остальные назначения сохраняются', async () => {
    const container = await renderSettings()

    await selectModalityOption(container, 'attachments-modality-audio', 'Not set (drop)')
    await click(byTestId(container, 'attachments-save'))

    expect(mocks.updateAttachmentsSettings).toHaveBeenCalledTimes(1)
    const body = mocks.updateAttachmentsSettings.mock.calls[0]?.[0] as Record<string, unknown>
    // PUT заменяет секцию `modalityModels` целиком — уходят все четыре ключа.
    expect(body.modalityModels).toEqual({
      image: { provider: 'openai', model: 'gpt-4o' },
      pdf: null,
      audio: null,
      video: null,
    })
  })

  it('выбор модели попадает в назначение строки', async () => {
    const container = await renderSettings()

    await selectModalityOption(container, 'attachments-modality-pdf', 'openai / gpt-4o')
    expect(byTestId(container, 'attachments-modality-pdf')?.textContent).toContain(
      'openai / gpt-4o',
    )

    await click(byTestId(container, 'attachments-save'))
    const body = mocks.updateAttachmentsSettings.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.modalityModels).toEqual({
      image: { provider: 'openai', model: 'gpt-4o' },
      pdf: { provider: 'openai', model: 'gpt-4o' },
      audio: { provider: 'local', model: 'whisper' },
      video: null,
    })
  })

  it('назначение модели без нужной модальности помечается предупреждением', async () => {
    mocks.getAttachmentsSettings.mockResolvedValue({
      ...INFO,
      attachments: {
        ...ATTACHMENTS,
        // Модель есть в каталоге, но модальность image не заявляет.
        modalityModels: { image: { provider: 'openai', model: 'gpt-3.5-turbo' } },
      },
    })
    const container = await renderSettings()

    expect(byTestId(container, 'attachments-modality-warning-image')?.textContent).toBe(
      'Model openai/gpt-3.5-turbo does not accept this modality',
    )
    // Остальные строки — без предупреждения.
    expect(byTestId(container, 'attachments-modality-warning-pdf')).toBeNull()
  })

  it('envLocked блокирует строки и не отправляет modalityModels', async () => {
    mocks.getAttachmentsSettings.mockResolvedValue({
      ...ASSIGNED_INFO,
      source: 'env',
      envLocked: ['modalityModels'],
    })
    const container = await renderSettings()

    expect((byTestId(container, 'attachments-modality-image') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(byTestId(container, 'attachments-modality-env-locked')).toBeTruthy()

    // Меняем другую настройку — поле env-зафиксированной секции в тело не попадает.
    await click(switchByLabel(container, 'Video'))
    await click(byTestId(container, 'attachments-save'))

    const body = mocks.updateAttachmentsSettings.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body).not.toHaveProperty('modalityModels')
    expect(body.modalities).toEqual({ image: true, pdf: true, audio: false, video: true })
  })

  it('ошибка API показывается тостом type=error', async () => {
    mocks.updateAttachmentsSettings.mockRejectedValue(new Error('model rejected'))
    const container = await renderSettings()

    await selectModalityOption(container, 'attachments-modality-image', 'local / llava')
    await click(byTestId(container, 'attachments-save'))

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text: 'Failed to save settings: model rejected' }),
    )
  })
})

describe('MultimodalSettings — чистые хелперы', () => {
  it('форма ↔ настройки: байты конвертируются в MiB и обратно', () => {
    const form = formFromAttachments(ATTACHMENTS)
    expect(form.maxFileMiB).toBe('10')
    expect(form.maxSessionMiB).toBe('100')
    expect(form.mimePrefixes).toBe('image/, application/pdf')
    expect(form.image).toBe(true)
    expect(form.video).toBe(false)
  })

  it('тело PUT: все поля, изменённые — из черновика, прочие — из сохранённых', () => {
    const saved = formFromAttachments(ATTACHMENTS)
    const draft = { ...saved, pdf: false, gcDays: '30' }

    expect(buildAttachmentsBody(draft, saved, ATTACHMENTS)).toEqual({
      enabled: true,
      modalities: { image: true, pdf: false, audio: false, video: false },
      maxBytesPerFile: 10 * MIB_BYTES,
      maxFilesPerMessage: 5,
      maxBytesPerSession: 100 * MIB_BYTES,
      gcDays: 30,
      workspaceFallback: false,
      allowedMimePrefixes: ['image/', 'application/pdf'],
      modalityModels: { image: null, pdf: null, audio: null, video: null },
    })
  })

  it('envLocked исключается из тела, в т. ч. по групповому имени', () => {
    const saved = formFromAttachments(ATTACHMENTS)
    const draft = {
      ...saved,
      image: false,
      enabled: false,
      workspaceFallback: true,
      mimePrefixes: 'image/',
    }

    expect(buildAttachmentsBody(draft, saved, ATTACHMENTS, ['modalities', 'enabled'])).toEqual({
      maxBytesPerFile: 10 * MIB_BYTES,
      maxFilesPerMessage: 5,
      maxBytesPerSession: 100 * MIB_BYTES,
      gcDays: 7,
      workspaceFallback: true,
      allowedMimePrefixes: ['image/'],
      modalityModels: { image: null, pdf: null, audio: null, video: null },
    })
  })

  it('неизменённые байты не пересчитываются через MiB (нет потери точности)', () => {
    const odd: AttachmentsSettings = { ...ATTACHMENTS, maxBytesPerFile: 10_485_777 }
    const saved = formFromAttachments(odd)
    const draft = { ...saved, pdf: false }

    expect(buildAttachmentsBody(draft, saved, odd).maxBytesPerFile).toBe(10_485_777)
  })

  it('MIME-список: пустые элементы — ошибка, пустая строка — нет', () => {
    expect(parseMimePrefixes('image/,,text/plain')).toEqual({
      values: ['image/', 'text/plain'],
      hasEmpty: true,
    })
    expect(parseMimePrefixes('image/, application/pdf')).toEqual({
      values: ['image/', 'application/pdf'],
      hasEmpty: false,
    })
    expect(parseMimePrefixes('   ')).toEqual({ values: [], hasEmpty: false })
  })

  it('назначения по модальностям: форма из настроек и обратно в тело PUT', () => {
    const settings: AttachmentsSettings = {
      ...ATTACHMENTS,
      modalityModels: { image: { provider: 'openai', model: 'gpt-4o' } },
    }
    const saved = formFromAttachments(settings)

    expect(saved.modalityModels).toEqual({
      image: { provider: 'openai', model: 'gpt-4o' },
      pdf: null,
      audio: null,
      video: null,
    })
    // Черновик без изменений → все четыре ключа, незаданные — `null`.
    expect(buildAttachmentsBody(saved, saved, settings).modalityModels).toEqual({
      image: { provider: 'openai', model: 'gpt-4o' },
      pdf: null,
      audio: null,
      video: null,
    })
  })

  it('каталог: только модели с нужной модальностью, ключ — provider/model', () => {
    expect(modelsForModality(CATALOG, 'audio')).toEqual([
      {
        key: 'local/whisper',
        ref: { provider: 'local', model: 'whisper' },
        label: 'local / whisper',
      },
    ])
    // Модели без `modalities` не предлагаются — сервер отклонит такую aux-модель.
    expect(modelsForModality(CATALOG, 'video').map((option) => option.key)).toEqual([
      'local/movie',
    ])
    expect(modalityModelKey({ provider: 'openai', model: 'gpt-4o' })).toBe('openai/gpt-4o')
    expect(NOT_SET_MODALITY_MODEL).not.toBe('openai/gpt-4o')
  })
})
