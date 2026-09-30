import { memo } from 'react'
import { Notice } from './Notice'
import { SecretMarkdown } from './SecretPlaceholder'
import { useI18n, useResolveI18n } from '@/lib/i18n'
import type { MessageData } from '@/stores/chatStore'

interface CommandMessageProps {
  message: MessageData
  onCopy: () => void
  /** Сессия — для аудита раскрытия секретов в выводе команды. */
  sessionId?: string
}

/**
 * Шапка команды в стиле shell-промпта: `> /name args`.
 * Пустые аргументы не оставляют хвостового пробела.
 */
export function commandHeader(name: string, args?: string): string {
  const cmd = `/${name}`
  return args ? `> ${cmd} ${args}` : `> ${cmd}`
}

/**
 * AD-046 §7.1: системная (локальная builtin) команда — нейтральный system-блок
 * (`Notice` variant `command`). Команда и её вывод объединены в один блок
 * (`> /name args` + результат), без шапки агента, бейджа, статистики и retry;
 * из действий — только «Копировать».
 */
function CommandMessageInner({ message, onCopy, sessionId }: CommandMessageProps) {
  const { t } = useI18n()
  const resolveI18nText = useResolveI18n()
  const meta = (message.metadata ?? {}) as Record<string, unknown>
  const name = typeof meta.commandName === 'string' ? meta.commandName : ''
  const args = typeof meta.commandArgs === 'string' ? meta.commandArgs : ''
  const secrets = meta.secrets as Record<string, string> | undefined
  const header = name ? commandHeader(name, args) : ''

  return (
    <Notice
      variant="command"
      label={header || undefined}
      ariaLabel={t('chat.command.title')}
      onCopy={onCopy}
      disabled={message.disabled}
    >
      {message.content && (
        <SecretMarkdown
          content={resolveI18nText(meta.i18n, message.content)}
          secrets={secrets}
          sessionId={sessionId}
        />
      )}
    </Notice>
  )
}

export const CommandMessage = memo(CommandMessageInner)
