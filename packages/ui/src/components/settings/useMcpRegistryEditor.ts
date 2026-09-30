import { useState } from 'react'

import type { McpRegistryEntry } from '@itphx/synth-shared'
import type { McpServerConfig } from '@/lib/api/synthApi'

export const EMPTY_MCP_CONFIG: McpServerConfig = { type: 'http' }

export interface McpRegistryEditorInput {
  name: string
  config: McpServerConfig
  /** Системный мастер-флаг (hard-gate). */
  enabled?: boolean
  /** Включён по умолчанию для новых проектов (сид). */
  enabledByDefault?: boolean
}

export interface UseMcpRegistryEditorOptions {
  addEntry: (input: McpRegistryEditorInput) => Promise<unknown>
  updateEntry: (id: string, input: McpRegistryEditorInput) => Promise<unknown>
  deleteEntry: (id: string) => Promise<unknown>
  /** Ошибка сохранения/удаления; уже локализованный текст. */
  onError?: (message: string) => void
  /** Вызывается при открытии формы (сброс внешнего состояния, напр. результата теста). */
  onOpen?: () => void
  /** Вызывается при закрытии формы. */
  onClose?: () => void
}

/**
 * Общая логика редактирования реестра MCP (AD-071): состояние формы
 * (`__new__`/id), add/edit/save/delete и цель подтверждения удаления.
 * Используется админской (`McpSettings`) и пользовательской (`McpUserSettings`)
 * панелями, чтобы не дублировать каркас.
 */
export function useMcpRegistryEditor({
  addEntry,
  updateEntry,
  deleteEntry,
  onError,
  onOpen,
  onClose,
}: UseMcpRegistryEditorOptions) {
  const [editing, setEditing] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formConfig, setFormConfig] = useState<McpServerConfig>(EMPTY_MCP_CONFIG)
  const [formEnabled, setFormEnabled] = useState(true)
  const [formDefault, setFormDefault] = useState(false)
  const [savingForm, setSavingForm] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<McpRegistryEntry | null>(null)

  const updateConfig = (patch: Partial<McpServerConfig>) => {
    setFormConfig((prev) => ({ ...prev, ...patch }))
  }

  const openAdd = () => {
    setEditing('__new__')
    setFormName('')
    setFormConfig(EMPTY_MCP_CONFIG)
    setFormEnabled(true)
    setFormDefault(false)
    onOpen?.()
  }

  const openEdit = (entry: McpRegistryEntry) => {
    setEditing(entry.id)
    setFormName(entry.name)
    setFormConfig({ ...entry.config })
    setFormEnabled(entry.enabled !== false)
    setFormDefault(entry.enabledByDefault)
    onOpen?.()
  }

  const closeForm = () => {
    setEditing(null)
    onClose?.()
  }

  const handleSave = async () => {
    if (!formName.trim()) return
    setSavingForm(true)
    try {
      const input: McpRegistryEditorInput = {
        name: formName.trim(),
        config: formConfig,
        enabled: formEnabled,
        enabledByDefault: formDefault,
      }
      if (editing === '__new__') {
        await addEntry(input)
      } else if (editing) {
        await updateEntry(editing, input)
      }
      closeForm()
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'unknown')
    } finally {
      setSavingForm(false)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      await deleteEntry(deleteTarget.id)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'unknown')
    }
    setDeleteTarget(null)
  }

  return {
    editing,
    formName,
    setFormName,
    formConfig,
    setFormConfig,
    formEnabled,
    setFormEnabled,
    formDefault,
    setFormDefault,
    savingForm,
    deleteTarget,
    setDeleteTarget,
    updateConfig,
    openAdd,
    openEdit,
    closeForm,
    handleSave,
    handleDeleteConfirm,
  }
}
