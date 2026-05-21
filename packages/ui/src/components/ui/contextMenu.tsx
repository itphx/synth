import React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
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
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  trigger,
  items,
  align = 'end',
  sideOffset = 4,
}) => {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={sideOffset}
          className={cn(
            'z-50 min-w-[180px] rounded-lg border border-sidebar-border bg-background p-1 shadow-lg',
            'animate-in fade-in-0 zoom-in-95 duration-100',
          )}
        >
          {items.map((item, index) => {
            if (item === 'separator') {
              return (
                <DropdownMenu.Separator
                  key={`sep-${index}`}
                  className="my-1 h-px bg-border"
                />
              )
            }
            return (
              <DropdownMenu.Item
                key={item.label + index}
                onClick={item.onClick}
                disabled={item.disabled}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors',
                  '[&>svg]:h-4 [&>svg]:w-4',
                  item.destructive
                    ? 'text-status-error focus:bg-status-error/10 focus:text-status-error'
                    : 'text-foreground hover:bg-interactive-hover focus:bg-interactive-focus',
                  item.disabled && 'opacity-50 pointer-events-none',
                )}
              >
                {item.icon && <Icon name={item.icon} />}
                <span>{item.label}</span>
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export const ContextMenuSep = () => 'separator'