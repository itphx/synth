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
            'z-50 min-w-[180px] rounded-lg border border-sidebar-border bg-background p-1 shadow-lg',
          )}
        >
          {items.map((item, index) => {
            if (item === 'separator') {
              return (
                <div
                  key={`sep-${index}`}
                  className="my-1 h-px bg-border"
                />
              )
            }
            return (
              <PopoverPrimitive.Close key={item.label + index} asChild>
                <button
                  onClick={item.onClick}
                  disabled={item.disabled}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors',
                    '[&>svg]:h-4 [&>svg]:w-4',
                    item.destructive
                      ? 'text-status-error hover:bg-status-error/10 focus:bg-status-error/10'
                      : 'text-foreground hover:bg-interactive-hover focus:bg-interactive-focus',
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
