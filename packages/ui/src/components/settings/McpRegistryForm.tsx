import type React from 'react'

import type { McpServerConfig } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { SelectContent, SelectItem } from '../ui/select'
import {
  SelectField,
  SettingsActions,
  SettingsSection,
  TextArea,
  TextField,
} from '../ui/settings'

export interface McpRegistryFormProps {
  title: string
  /** true — редактирование существующей записи (имя не меняется). */
  editing: boolean
  name: string
  onNameChange: (value: string) => void
  config: McpServerConfig
  onConfigChange: (patch: Partial<McpServerConfig>) => void
  /** Разрешить тип stdio (только ADMIN, ADR-071 §2.5). */
  allowStdio: boolean
  saving: boolean
  onSave: () => void
  onCancel: () => void
  /** Пояснение к полю типа (напр. «только HTTP» / «stdio — только админ»). */
  typeDescription?: string
  /** Доп. поля перед действиями (напр. enabledByDefault). */
  extraFields?: React.ReactNode
  /** Доп. контент рядом с действиями (напр. кнопка проверки). */
  extraActions?: React.ReactNode
}

/** Строки `KEY=value` → объект; пустые строки игнорируются. */
export function parseEnv(value: string): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const line of value.split('\n').filter(Boolean)) {
    const eqIdx = line.indexOf('=')
    if (eqIdx > 0) env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim()
  }
  return Object.keys(env).length ? env : undefined
}

/** Объект env → строки `KEY=value`. */
export function formatEnv(env?: Record<string, string>): string {
  if (!env) return ''
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')
}

/** Аргументы командной строки в кавычках → строка. */
export function formatArgs(args?: string[]): string {
  return (args ?? []).map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')
}

/** Аргументы в строке с кавычками → массив. */
export function parseArgs(value: string): string[] {
  const matches = value.match(/(?:[^\s"]+|"[^"]*")+/g) || []
  return matches.map((v) => v.replace(/^"|"$/g, ''))
}

/**
 * ADR-071 §2.5 / ADR-072: общая форма записи реестра MCP (имя, описание, тип,
 * URL/команда/аргументы/env, действия). Используется админской и
 * пользовательской панелями; различия — через `allowStdio`/`extraFields`.
 */
export function McpRegistryForm({
  title,
  editing,
  name,
  onNameChange,
  config,
  onConfigChange,
  allowStdio,
  saving,
  onSave,
  onCancel,
  typeDescription,
  extraFields,
  extraActions,
}: McpRegistryFormProps) {
  const { t } = useI18n()

  return (
    <SettingsSection title={title}>
      <TextField
        label={t('mcp.serverName')}
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        disabled={editing}
        placeholder="my-server"
      />

      <TextArea
        label={t('mcp.serverDescription')}
        value={config.description || ''}
        onChange={(e) => onConfigChange({ description: e.target.value || undefined })}
        rows={2}
        placeholder={t('mcp.serverDescriptionPlaceholder')}
      />

      <SelectField
        label={t('mcp.type')}
        description={typeDescription}
        value={config.type}
        onValueChange={(value) => onConfigChange({ type: value as McpServerConfig['type'] })}
        ariaLabel={t('mcp.type')}
      >
        <SelectContent>
          {allowStdio && <SelectItem value="stdio">{t('mcp.type.stdio')}</SelectItem>}
          <SelectItem value="http">{t('mcp.type.http')}</SelectItem>
          <SelectItem value="sse">{t('mcp.type.sse.legacy')}</SelectItem>
        </SelectContent>
      </SelectField>

      {config.type === 'stdio' && (
        <>
          <TextField
            label={t('mcp.command')}
            value={config.command || ''}
            onChange={(e) => onConfigChange({ command: e.target.value })}
            placeholder="python или npx"
          />
          <TextField
            label={t('mcp.args')}
            value={formatArgs(config.args)}
            onChange={(e) => onConfigChange({ args: parseArgs(e.target.value) })}
            mono
            placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
          />
          <TextArea
            id="mcp-server-env"
            name="mcpServerEnv"
            autoComplete="off"
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            data-form-type="other"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            label={t('mcp.env')}
            value={formatEnv(config.env)}
            onChange={(e) => onConfigChange({ env: parseEnv(e.target.value) })}
            rows={3}
            mono
            placeholder={'KEY1=value1\nKEY2=value2'}
          />
        </>
      )}

      {config.type !== 'stdio' && (
        <TextField
          label={t('mcp.url')}
          value={config.url || ''}
          onChange={(e) => onConfigChange({ url: e.target.value })}
          placeholder="http://localhost:8765/mcp"
        />
      )}

      {extraFields}

      <div className="flex flex-wrap items-center gap-2 min-w-0">
        {extraActions}
        <SettingsActions
          className="ml-auto"
          onSave={onSave}
          onCancel={onCancel}
          saveDisabled={!name.trim()}
          saving={saving}
        />
      </div>
    </SettingsSection>
  )
}
