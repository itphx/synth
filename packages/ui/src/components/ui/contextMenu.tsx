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
            'z-50 min-w-[11.25rem] rounded-xl bg-popover text-popover-foreground p-1 ring-1 ring-foreground/10 shadow-lg',
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
                  // Radix Popover порталит контент в body, но React-события всё равно
                  // всплывают по дереву компонентов до родителя-триггера (например,
                  // строки дерева). Без stopPropagation клик по пункту меню вызывал
                  // onClick строки: на мобильном это закрывало левый дровер (openTab
                  // сбрасывает mobileLeftOpen), на десктопе — открывало вкладку сессии.
                  onClick={(e) => { e.stopPropagation(); item.onClick() }}
                  disabled={item.disabled}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-left outline-none transition-colors',
                    '[&>svg]:size-3.5',
                    item.destructive
                      ? 'text-status-error hover:bg-status-error/15 focus:bg-status-error/15'
                      : 'text-popover-foreground hover:bg-interactive-hover focus:bg-interactive-hover',
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
