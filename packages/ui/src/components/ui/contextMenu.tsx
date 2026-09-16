import React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Icon } from '@/components/icon/Icon'
import type { IconName } from '@/components/icon/icons'
import { cn } from '@/lib/utils'

export interface ContextMenuItem {
  label: string
  icon?: IconName
  onClick: () => void
  destructive?: boolean
  disabled?: boolean
}

type ContextMenuEntry = ContextMenuItem | 'separator'

interface ContextMenuProps {
  trigger: React.ReactNode
  items: ContextMenuEntry[]
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  trigger,
  items,
  align = 'end',
  sideOffset = 4,
  open,
  onOpenChange,
}) => {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        {trigger}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(
            'z-50 min-w-[11.25rem] rounded-lg border border-border bg-popover p-1 shadow-lg',
          )}
        >
          {items.map((item, index) => {
            if (item === 'separator') {
              return (
                <div
                  key={`sep-${index}`}
                  className="my-1 border-t border-border/30"
                />
              )
            }
            return (
              <PopoverPrimitive.Close key={item.label + index} asChild>
                <button
                  onClick={item.onClick}
                  disabled={item.disabled}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left outline-none transition-colors',
                    '[&>svg]:size-3.5',
                    item.destructive
                      ? 'text-status-error hover:bg-status-error/10 focus:bg-status-error/10'
                      : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus:bg-interactive-hover/50 focus:text-foreground',
                    item.disabled && 'opacity-50 pointer-events-none',
                  )}
                >
                  {item.icon && <Icon name={item.icon} />}
                  <span>{item.label}</span>
                </button>
              </PopoverPrimitive.Close>
            )
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

export const ContextMenuSep = () => 'separator'
