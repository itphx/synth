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
  getStatus: vi.fn(),
  getDoctor: vi.fn(),
  getMigrations: vi.fn(),
  applyMigrations: vi.fn(),
  listBackups: vi.fn(),
  createBackup: vi.fn(),
  backupDownloadUrl: vi.fn((name: string) => `/api/v2/maintenance/backups/${name}/download`),
  deleteBackup: vi.fn(),
  validateRestoreByRef: vi.fn(),
  validateRestoreUpload: vi.fn(),
  getPendingRestore: vi.fn(),
  scheduleRestore: vi.fn(),
  cancelRestore: vi.fn(),
  listAudit: vi.fn(),
  clearAudit: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn(async () => true) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MaintenanceSettings, archiveBaseName, formatBytes, summarizeAuditDetails } from './MaintenanceSettings'
import { CATEGORIES, resolveActiveSettingsPage } from './SettingsModal'
import type {
  DoctorResult,
  MaintenanceAuditEntry,
  MaintenanceBackupInfo,
  MaintenanceStatus,
  MigrationPlan,
  PendingRestoreRequest,
  RestoreValidation,
} from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const BACKUP: MaintenanceBackupInfo = {
  name: 'synth-backup-1.2.3-20261016-120000.tar.gz',
  path: '/var/synth/data/backups/synth-backup-1.2.3-20261016-120000.tar.gz',
  bytes: 1536,
  createdAt: '2026-10-16T12:00:00.000Z',
  schemaVersion: 2,
  instanceVersion: '1.2.3',
  withSecrets: true,
  withWorkspace: false,
  entries: 42,
}

const BACKUP_2: MaintenanceBackupInfo = {
  name: 'synth-backup-1.2.0-20261010-090000.tar.gz',
  path: '/var/synth/data/backups/synth-backup-1.2.0-20261010-090000.tar.gz',
  bytes: 3 * 1024 * 1024,
  createdAt: '2026-10-10T09:00:00.000Z',
  schemaVersion: 1,
  instanceVersion: '1.2.0',
  withSecrets: false,
  withWorkspace: true,
  entries: 12,
}

const BACKUP_ENC: MaintenanceBackupInfo = {
  name: 'synth-backup-1.2.3-20261016-130000.tar.gz.enc',
  path: '/var/synth/data/backups/synth-backup-1.2.3-20261016-130000.tar.gz.enc',
  bytes: 2048,
  createdAt: '2026-10-16T13:00:00.000Z',
  schemaVersion: 3,
  instanceVersion: '1.2.3',
  withSecrets: false,
  withWorkspace: false,
  entries: 42,
  encrypted: true,
  metadataAvailable: true,
}

const BACKUP_ENC_NO_META: MaintenanceBackupInfo = {
  name: 'synth-backup-1.2.3-20261016-140000.tar.gz.enc',
  path: '/var/synth/data/backups/synth-backup-1.2.3-20261016-140000.tar.gz.enc',
  bytes: 1024,
  createdAt: '2026-10-16T14:00:00.000Z',
  schemaVersion: 0,
  instanceVersion: '',
  withSecrets: false,
  withWorkspace: false,
  entries: 0,
  encrypted: true,
  metadataAvailable: false,
}

const STATUS: MaintenanceStatus = {
  version: '1.2.3',
  dataDir: '/var/synth/data',
  schema: {
    current: 2,
    expected: 3,
    applied: ['m1'],
    pending: [{ id: 'm2', toVersion: 3, description: 'add field' }],
  },
  backups: [BACKUP, BACKUP_2],
  pendingRestore: null,
  doctor: { ok: false, fail: 1, warn: 2 },
}

const PENDING_RESTORE: PendingRestoreRequest = {
  archive: '/var/synth/data/backups/synth-backup-1.2.0-20261010-090000.tar.gz',
  requestedAt: '2026-10-16T13:00:00.000Z',
  safetyCopy: true,
}

const MIGRATIONS: MigrationPlan = {
  current: 2,
  expected: 3,
  applied: ['m1'],
  pending: [{ id: 'm2', toVersion: 3, description: 'add field' }],
}

const NO_MIGRATIONS: MigrationPlan = { current: 3, expected: 3, applied: ['m1', 'm2'], pending: [] }

const DOCTOR: DoctorResult = {
  ok: false,
  dataDir: '/var/synth/data',
  version: '1.2.3',
  checks: [
    { id: 'data-dir', title: 'Data directory', status: 'ok', detail: '/var/synth/data' },
    {
      id: 'schema',
      title: 'Data schema',
      status: 'warn',
      detail: 'schema 2 (expected 3)',
      hint: 'synth migrate',
    },
    {
      id: 'master-key',
      title: 'Master key',
      status: 'fail',
      detail: 'missing',
      hint: 'set SYNTH_SECRET_KEY',
    },
    // PROP-032: при backend=postgres файловые проверки помечаются skipped.
    {
      id: 'providers',
      title: 'Providers',
      status: 'skipped',
      detail: 'неприменимо (backend=postgres)',
    },
  ],
}

const VALIDATION_OK: RestoreValidation = {
  ok: true,
  manifest: {
    schemaVersion: 2,
    instanceVersion: '1.2.0',
    withSecrets: false,
    withWorkspace: true,
    entries: 10,
    createdAt: '2026-10-15T10:00:00.000Z',
  },
}

const VALIDATION_UPLOAD: RestoreValidation = { ...VALIDATION_OK, staged: 'upload.tar.gz' }

const VALIDATION_FAIL: RestoreValidation = { ok: false, problem: 'checksum mismatch' }

const AUDIT_ENTRIES: MaintenanceAuditEntry[] = [
  {
    id: 'ma_2',
    ts: '2026-10-16T12:30:00.000Z',
    op: 'backup.created',
    status: 'ok',
    actor: 'admin',
    version: '1.2.3',
    details: { name: 'synth-backup.tar.gz', bytes: 1536 },
  },
  {
    id: 'ma_1',
    ts: '2026-10-16T12:00:00.000Z',
    op: 'migrate.applied',
    status: 'failed',
    actor: 'cli',
    error: 'boom',
  },
]

const clickTestId = async (container: HTMLElement, testId: string) => {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  expect(el, `элемент ${testId}`).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** Открывает Base UI select и кликает опцию по подписи. */
async function selectOption(trigger: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    trigger.click()
  })
  const listId = trigger.getAttribute('aria-controls')
  const scope = listId ? document.getElementById(listId) ?? document.body : document.body
  const options = [...scope.querySelectorAll('[role="option"]')] as HTMLElement[]
  const option = options.find((o) => o.textContent?.trim().startsWith(label))
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
}

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <MaintenanceSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

/** Устанавливает файл в нативном `<input type="file">` (jsdom: files read-only). */
async function setFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

let anchorClickSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getStatus.mockResolvedValue(STATUS)
  mocks.getDoctor.mockResolvedValue(DOCTOR)
  mocks.getMigrations.mockResolvedValue(MIGRATIONS)
  mocks.applyMigrations.mockResolvedValue({ applied: ['m2'], safetyCopyPath: '/var/synth/data/backups/x' })
  mocks.listBackups.mockResolvedValue({ backups: [BACKUP, BACKUP_2] })
  mocks.createBackup.mockResolvedValue(BACKUP)
  mocks.backupDownloadUrl.mockImplementation(
    (name: string) => `/api/v2/maintenance/backups/${name}/download`,
  )
  mocks.deleteBackup.mockResolvedValue(undefined)
  mocks.validateRestoreByRef.mockResolvedValue(VALIDATION_OK)
  mocks.validateRestoreUpload.mockResolvedValue(VALIDATION_UPLOAD)
  mocks.getPendingRestore.mockResolvedValue({ pending: null })
  mocks.scheduleRestore.mockResolvedValue({ pending: PENDING_RESTORE, appliesOnNextStart: true })
  mocks.cancelRestore.mockResolvedValue({ cancelled: true })
  mocks.listAudit.mockResolvedValue({ entries: AUDIT_ENTRIES })
  mocks.clearAudit.mockResolvedValue({ cleared: 2 })
  vi.mocked(confirm).mockResolvedValue(true)
  anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(async () => {
  anchorClickSpy.mockRestore()
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

describe('MaintenanceSettings — админ-раздел «Обслуживание» (ADR-091/ADR-092)', () => {
  it('загружает статус и миграции, рендерит заголовок/описание', async () => {
    const container = await renderSettings()

    expect(mocks.getStatus).toHaveBeenCalledTimes(1)
    expect(mocks.getMigrations).toHaveBeenCalledTimes(1)
    expect(container.querySelector('header')!.textContent).toContain('Maintenance')
    expect(container.textContent).toContain('Instance health')
  })

  it('показывает версию, каталог данных и схему', async () => {
    const container = await renderSettings()

    const summary = container.querySelector('[data-testid="maintenance-status-summary"]')!
    expect(summary.textContent).toContain('1.2.3')
    expect(summary.textContent).toContain('/var/synth/data')
    expect(summary.textContent).toContain('2 / 3') // current / expected
  })

  it('показывает сводку doctor (warn/fail) и проблемы', async () => {
    const container = await renderSettings()

    const summary = container.querySelector('[data-testid="maintenance-doctor-summary"]')!
    expect(summary.textContent).toContain('Problems detected')
    expect(summary.textContent).toContain('warnings: 2')
    expect(summary.textContent).toContain('failures: 1')
  })

  it('до нажатия «Проверить» список проверок пуст', async () => {
    const container = await renderSettings()

    expect(mocks.getDoctor).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="maintenance-doctor-empty"]')).not.toBeNull()
  })

  it('«Проверить» перезапускает doctor и status, показывает проверки с detail/hint', async () => {
    const container = await renderSettings()
    mocks.getStatus.mockClear()

    await clickTestId(container, 'maintenance-check')
    await act(async () => {})

    expect(mocks.getDoctor).toHaveBeenCalledTimes(1)
    expect(mocks.getStatus).toHaveBeenCalledTimes(1) // refresh после проверки

    const checks = container.querySelector('[data-testid="maintenance-doctor-checks"]')!
    expect(checks.textContent).toContain('Data directory')
    expect(checks.textContent).toContain('schema 2 (expected 3)')
    expect(checks.textContent).toContain('synth migrate')
    expect(checks.textContent).toContain('Master key')
    expect(checks.textContent).toContain('set SYNTH_SECRET_KEY')
    // Глифы статусов ✓/⚠/✗ и «−» (неприменимо к backend'у, PROP-032).
    expect(checks.textContent).toContain('✓')
    expect(checks.textContent).toContain('⚠')
    expect(checks.textContent).toContain('✗')
    expect(checks.textContent).toContain('−')
    expect(checks.textContent).toContain('backend=postgres')
  })

  it('показывает применённые и ожидающие миграции, кнопка «Применить» при pending', async () => {
    const container = await renderSettings()

    expect(container.textContent).toContain('m1') // applied
    const pending = container.querySelector('[data-testid="maintenance-migrations-pending"]')!
    expect(pending.textContent).toContain('m2')
    expect(pending.textContent).toContain('add field')
    expect(container.querySelector('[data-testid="maintenance-migrations-apply"]')).not.toBeNull()
  })

  it('без pending нет кнопки «Применить миграции»', async () => {
    mocks.getMigrations.mockResolvedValue(NO_MIGRATIONS)
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="maintenance-migrations-apply"]')).toBeNull()
    expect(container.querySelector('[data-testid="maintenance-migrations-none"]')).not.toBeNull()
  })

  it('«Применить миграции» подтверждается (confirm) и вызывает applyMigrations + refresh', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'maintenance-migrations-apply')
    await act(async () => {})

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.applyMigrations).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
    expect(mocks.getStatus).toHaveBeenCalledTimes(2) // mount + refresh
  })

  it('создаёт бэкап с выбранными опциями', async () => {
    const container = await renderSettings()

    // Отметить «секреты» и «live».
    const secrets = container
      .querySelector('[data-testid="maintenance-backup-opt-secrets"]')!
      .querySelector('input') as HTMLInputElement
    const live = container
      .querySelector('[data-testid="maintenance-backup-opt-live"]')!
      .querySelector('input') as HTMLInputElement
    await act(async () => {
      secrets.click()
      live.click()
    })

    await clickTestId(container, 'maintenance-backup-create')
    await act(async () => {})

    expect(mocks.createBackup).toHaveBeenCalledWith({
      withSecrets: true,
      withWorkspace: false,
      live: true,
    })
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
  })

  it('список бэкапов показывает имя/размер/схему/флаги', async () => {
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="maintenance-backups-count"]')!.textContent).toContain(
      '2 backups',
    )
    const item = container.querySelector(`[data-testid="maintenance-backup-${BACKUP.name}"]`)!
    expect(item.textContent).toContain(BACKUP.name)
    expect(item.textContent).toContain('1.5 KiB')
    expect(item.textContent).toContain('secrets')
    expect(item.textContent).toContain('42')
  })

  it('скачивание строит URL и кликает ссылку', async () => {
    const container = await renderSettings()

    await clickTestId(container, `maintenance-backup-download-${BACKUP.name}`)
    await act(async () => {})

    expect(mocks.backupDownloadUrl).toHaveBeenCalledWith(BACKUP.name)
    expect(anchorClickSpy).toHaveBeenCalledTimes(1)
  })

  it('удаление бэкапа подтверждается и вызывает deleteBackup', async () => {
    const container = await renderSettings()

    await clickTestId(container, `maintenance-backup-delete-${BACKUP.name}`)
    await act(async () => {})

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteBackup).toHaveBeenCalledWith(BACKUP.name)
    expect(anchorClickSpy).not.toHaveBeenCalled()
  })

  it('проверка архива из списка показывает манифест и кнопку планирования', async () => {
    const container = await renderSettings()

    await selectOption(
      container.querySelector('[data-testid="maintenance-restore-select"]') as HTMLElement,
      BACKUP.name,
    )
    await clickTestId(container, 'maintenance-restore-validate')
    await act(async () => {})

    expect(mocks.validateRestoreByRef).toHaveBeenCalledWith(BACKUP.name)
    const manifest = container.querySelector('[data-testid="maintenance-restore-manifest"]')!
    expect(manifest.textContent).toContain('1.2.0') // instanceVersion
    expect(manifest.textContent).toContain('10') // entries
    expect(container.querySelector('[data-testid="maintenance-restore-schedule"]')).not.toBeNull()
  })

  it('планирование восстановления подтверждается и вызывает scheduleRestore', async () => {
    const container = await renderSettings()

    await selectOption(
      container.querySelector('[data-testid="maintenance-restore-select"]') as HTMLElement,
      BACKUP.name,
    )
    await clickTestId(container, 'maintenance-restore-validate')
    await act(async () => {})
    await clickTestId(container, 'maintenance-restore-schedule')
    await act(async () => {})

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.scheduleRestore).toHaveBeenCalledWith(BACKUP.name, true)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
  })

  it('загрузка файла проверяется через validateRestoreUpload, staged-имя идёт в scheduleRestore', async () => {
    const container = await renderSettings()

    const fileInput = container.querySelector(
      '[data-testid="maintenance-restore-file"]',
    ) as HTMLInputElement
    await setFile(fileInput, new File(['x'], 'upload.tar.gz', { type: 'application/gzip' }))
    await clickTestId(container, 'maintenance-restore-validate')
    await act(async () => {})

    expect(mocks.validateRestoreUpload).toHaveBeenCalledTimes(1)
    await clickTestId(container, 'maintenance-restore-schedule')
    await act(async () => {})

    expect(mocks.scheduleRestore).toHaveBeenCalledWith('upload.tar.gz', true)
  })

  it('проверка без выбора архива показывает подсказку', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'maintenance-restore-validate')
    await act(async () => {})

    expect(mocks.validateRestoreByRef).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="maintenance-restore-error"]')!.textContent).toContain(
      enDict['maintenance.restore.needArchive'],
    )
  })

  it('неудачная проверка показывает причину отказа', async () => {
    mocks.validateRestoreByRef.mockResolvedValue(VALIDATION_FAIL)
    const container = await renderSettings()

    await selectOption(
      container.querySelector('[data-testid="maintenance-restore-select"]') as HTMLElement,
      BACKUP.name,
    )
    await clickTestId(container, 'maintenance-restore-validate')
    await act(async () => {})

    expect(container.querySelector('[data-testid="maintenance-restore-problem"]')!.textContent).toContain(
      'checksum mismatch',
    )
    expect(container.querySelector('[data-testid="maintenance-restore-schedule"]')).toBeNull()
  })

  it('показывает отложенное восстановление и отменяет его', async () => {
    mocks.getStatus.mockResolvedValue({ ...STATUS, pendingRestore: PENDING_RESTORE })
    const container = await renderSettings()

    const pending = container.querySelector('[data-testid="maintenance-restore-pending"]')!
    expect(pending.textContent).toContain('synth-backup-1.2.0-20261010-090000.tar.gz')

    await clickTestId(container, 'maintenance-restore-cancel')
    await act(async () => {})

    expect(mocks.cancelRestore).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
  })

  it('показывает ошибку загрузки статуса', async () => {
    mocks.getStatus.mockRejectedValueOnce(new Error('boom'))
    const container = await renderSettings()

    expect(container.querySelector('[role="alert"]')!.textContent).toContain('boom')
  })

  it('зашифрованный бэкап: бейдж, отключённое скачивание, вне выбора восстановления', async () => {
    mocks.getStatus.mockResolvedValue({ ...STATUS, backups: [BACKUP, BACKUP_ENC] })
    const container = await renderSettings()

    const badge = container.querySelector(
      `[data-testid="maintenance-backup-encrypted-${BACKUP_ENC.name}"]`,
    )
    expect(badge).toBeTruthy()
    expect(badge!.textContent).toContain(enDict['maintenance.backups.badgeEncrypted'])

    const encDownload = container.querySelector(
      `[data-testid="maintenance-backup-download-${BACKUP_ENC.name}"]`,
    ) as HTMLButtonElement
    expect(encDownload.disabled).toBe(true)
    expect(encDownload.getAttribute('title')).toContain('CLI')

    // Незашифрованный бэкап по-прежнему скачивается.
    const plainDownload = container.querySelector(
      `[data-testid="maintenance-backup-download-${BACKUP.name}"]`,
    ) as HTMLButtonElement
    expect(plainDownload.disabled).toBe(false)

    // В выборе восстановления — только незашифрованные архивы.
    const trigger = container.querySelector(
      '[data-testid="maintenance-restore-select"]',
    ) as HTMLElement
    await act(async () => {
      trigger.click()
    })
    const listId = trigger.getAttribute('aria-controls')
    const scope = listId ? document.getElementById(listId) ?? document.body : document.body
    const optionTexts = [...scope.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.trim(),
    )
    expect(optionTexts.some((text) => text?.startsWith(BACKUP.name))).toBe(true)
    expect(optionTexts.some((text) => text?.startsWith(BACKUP_ENC.name))).toBe(false)
  })

  it('зашифрованный бэкап без sidecar: пометка «метаданные недоступны»', async () => {
    mocks.getStatus.mockResolvedValue({ ...STATUS, backups: [BACKUP_ENC_NO_META] })
    const container = await renderSettings()

    const note = container.querySelector(
      `[data-testid="maintenance-backup-meta-unavailable-${BACKUP_ENC_NO_META.name}"]`,
    )
    expect(note).toBeTruthy()
    expect(note!.textContent).toContain(enDict['maintenance.backups.metaUnavailable'])
  })
})

describe('MaintenanceSettings — журнал обслуживания (ADR-092)', () => {
  it('загружает журнал и рендерит записи (операция, статус, автор, сводка details)', async () => {
    const container = await renderSettings()

    expect(mocks.listAudit).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="maintenance-audit-count"]')!.textContent).toContain(
      '2 entries',
    )

    const created = container.querySelector('[data-testid="maintenance-audit-ma_2"]')!
    expect(created.textContent).toContain('backup.created')
    expect(created.textContent).toContain('ok')
    expect(created.textContent).toContain('admin')
    expect(
      container.querySelector('[data-testid="maintenance-audit-details-ma_2"]')!.textContent,
    ).toContain('synth-backup.tar.gz')

    const migrated = container.querySelector('[data-testid="maintenance-audit-ma_1"]')!
    expect(migrated.textContent).toContain('migrate.applied')
    expect(migrated.textContent).toContain('failed')
    expect(migrated.textContent).toContain('cli')
    expect(migrated.textContent).toContain('boom')
  })

  it('«Обновить» перечитывает журнал', async () => {
    const container = await renderSettings()
    mocks.listAudit.mockClear()

    await clickTestId(container, 'maintenance-audit-refresh')
    await act(async () => {})

    expect(mocks.listAudit).toHaveBeenCalledTimes(1)
  })

  it('«Очистить журнал» подтверждается через confirm и вызывает clearAudit + refresh', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'maintenance-audit-clear')
    await act(async () => {})

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.clearAudit).toHaveBeenCalledTimes(1)
    expect(mocks.listAudit).toHaveBeenCalledTimes(2) // mount + refresh после очистки
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
  })

  it('пустой журнал показывает заглушку и блокирует очистку', async () => {
    mocks.listAudit.mockResolvedValue({ entries: [] })
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="maintenance-audit-empty"]')).not.toBeNull()
    expect(
      (container.querySelector('[data-testid="maintenance-audit-clear"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('ошибка загрузки журнала показывается и не ломает раздел', async () => {
    mocks.listAudit.mockRejectedValueOnce(new Error('audit boom'))
    const container = await renderSettings()

    const error = container.querySelector('[data-testid="maintenance-audit-error"]')!
    expect(error.textContent).toContain('audit boom')
    expect(container.querySelector('[data-testid="maintenance-audit-list"]')).toBeNull()
  })

  it('summarizeAuditDetails склеивает пары и объекты', () => {
    expect(summarizeAuditDetails(undefined)).toBe('')
    expect(summarizeAuditDetails({ name: 'x.tar.gz', count: 3 })).toBe('name: x.tar.gz, count: 3')
    expect(summarizeAuditDetails({ nested: { a: 1 } })).toBe('nested: {"a":1}')
  })
})

describe('MaintenanceSettings — утилиты, права (ADMIN) и i18n (ADR-091/ADR-092)', () => {
  it('formatBytes форматирует размер', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MiB')
    expect(formatBytes(Number.NaN)).toBe('—')
  })

  it('archiveBaseName извлекает имя из абсолютного пути', () => {
    expect(archiveBaseName('/var/synth/data/backups/x.tar.gz')).toBe('x.tar.gz')
    expect(archiveBaseName('x.tar.gz')).toBe('x.tar.gz')
  })

  it('категория «Обслуживание» — только ADMIN', () => {
    const config = CATEGORIES.find((cat) => cat.id === 'maintenance')!
    expect(config).toBeDefined()
    expect(config.roles).toEqual(['ADMIN'])
  })

  it('ADMIN видит раздел, USER/LEAD — нет', () => {
    const visibleFor = (roles: string[]) =>
      CATEGORIES.filter((cat) => !cat.roles || cat.roles.some((r) => roles.includes(r))).map(
        (c) => c.id,
      )

    expect(visibleFor(['ADMIN'])).toContain('maintenance')
    expect(visibleFor(['LEAD'])).not.toContain('maintenance')
    expect(visibleFor(['USER'])).not.toContain('maintenance')
  })

  it('resolveActiveSettingsPage не оставляет недоступный раздел активным', () => {
    const visible = CATEGORIES.filter(
      (cat) => !cat.roles || cat.roles.some((r) => ['USER'].includes(r)),
    )
    expect(visible.some((cat) => cat.id === 'maintenance')).toBe(false)
    expect(resolveActiveSettingsPage(visible, 'maintenance')).toBe(visible[0].id)
  })

  it('ключи «Обслуживание» есть в ru и en словарях', () => {
    expect(enDict['settings.category.maintenance']).toBeTruthy()
    expect(ruDict['settings.category.maintenance']).toBeTruthy()
    expect(enDict['maintenance.title']).toBeTruthy()
    expect(ruDict['maintenance.title']).toBeTruthy()
    expect(enDict['maintenance.schema.apply']).toBeTruthy()
    expect(ruDict['maintenance.schema.apply']).toBeTruthy()
    expect(enDict['maintenance.backups.create']).toBeTruthy()
    expect(ruDict['maintenance.backups.create']).toBeTruthy()
    expect(enDict['maintenance.restore.schedule']).toBeTruthy()
    expect(ruDict['maintenance.restore.schedule']).toBeTruthy()
    expect(enDict['maintenance.restore.warning']).toBeTruthy()
    expect(ruDict['maintenance.restore.warning']).toBeTruthy()
    expect(enDict['maintenance.audit.title']).toBeTruthy()
    expect(ruDict['maintenance.audit.title']).toBeTruthy()
    expect(enDict['maintenance.audit.clear']).toBeTruthy()
    expect(ruDict['maintenance.audit.clear']).toBeTruthy()
    expect(enDict['maintenance.audit.status.scheduled']).toBeTruthy()
    expect(ruDict['maintenance.audit.status.scheduled']).toBeTruthy()
    expect(enDict['maintenance.backups.badgeEncrypted']).toBeTruthy()
    expect(ruDict['maintenance.backups.badgeEncrypted']).toBeTruthy()
    expect(enDict['maintenance.backups.encryptedCli']).toBeTruthy()
    expect(ruDict['maintenance.backups.encryptedCli']).toBeTruthy()
    expect(enDict['maintenance.backups.metaUnavailable']).toBeTruthy()
    expect(ruDict['maintenance.backups.metaUnavailable']).toBeTruthy()
  })
})
