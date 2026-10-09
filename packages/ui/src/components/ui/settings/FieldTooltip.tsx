import { Icon } from '@/components/icon/Icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export interface FieldTooltipProps {
  /** Текст подсказки; отображается в Radix Tooltip и как aria-label. */
  text: string
}

/**
 * AD-072/AD-089: иконка-подсказка (ⓘ) рядом с лейблом поля. Содержимое —
 * в Radix `Tooltip`; доступно и с клавиатуры (`tabIndex`).
 */
export function FieldTooltip({ text }: FieldTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="img"
          aria-label={text}
          data-testid="settings-field-tooltip"
          className="inline-flex shrink-0 items-center justify-center rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="information" className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}
