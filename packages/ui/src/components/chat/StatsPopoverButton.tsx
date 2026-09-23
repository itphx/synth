import { forwardRef, useState, type ReactNode } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface StatsPopoverButtonProps {
  /** Содержимое поповера — строка статистики (MessageStats или live-сегменты стрима). */
  children: ReactNode
}

/**
 * AD-070 §2.6: кнопка «Статистика ответа» с поповером. Общая для готовых
 * сообщений (`MessageActions`) и live-стрима (`StreamingPlaceholder`), чтобы
 * разметка кнопки и поповера не дублировалась.
 */
export function StatsPopoverButton({ children }: StatsPopoverButtonProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <StatsButton title={t('chat.messageStats.toggle')} active={open} />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        sideOffset={12}
        align="start"
        className="min-h-[34px] w-max max-w-[calc(100vw-2rem)] overflow-x-auto px-2 py-0 flex items-center"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

const StatsButton = forwardRef<HTMLButtonElement, { onClick?: () => void; title: string; active?: boolean }>(
  function StatsButton({ onClick, title, active }, ref) {
    return (
      <button
        ref={ref}
        onClick={onClick}
        title={title}
        className={cn(
          'inline-flex items-center justify-center rounded p-1 transition-colors',
          active
            ? 'text-primary bg-primary/10'
            : 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover',
        )}
      >
        <Icon name="chart-line" className="size-3.5" />
      </button>
    )
  },
)
