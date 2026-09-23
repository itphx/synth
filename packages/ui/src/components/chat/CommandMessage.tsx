import { memo } from 'react'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
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
 * AD-046 §7.1: системная (локальная builtin) команда — нейтральный system-блок.
 * Команда и её вывод объединены в один блок (`> /name args` + результат), без
 * шапки агента, бейджа, статистики и retry; из действий — только «Копировать».
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
    <div className="flex flex-col items-start px-4 py-3 group">
      <div
        role="group"
        aria-label={t('chat.command.title')}
        className={cn(
          'max-w-[85%] w-full rounded-lg rounded-bl-sm border px-4 py-3',
          'bg-muted/30 border-border/40 text-foreground',
          message.disabled && 'opacity-50',
        )}
      >
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[0.6875rem] text-muted-foreground">
          <Icon name="terminal-box" className="size-3 shrink-0" />
          {header && <span className="truncate">{header}</span>}
        </div>

        {message.content && (
          <SecretMarkdown
            content={resolveI18nText(meta.i18n, message.content)}
            secrets={secrets}
            sessionId={sessionId}
          />
        )}

        <div className="message-actions mt-2 -mb-1.5 flex items-center gap-0.5 border-t border-border/30 pt-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={onCopy}
            title={t('chat.command.copy')}
            className="inline-flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
          >
            <Icon name="file-copy" className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

export const CommandMessage = memo(CommandMessageInner)
