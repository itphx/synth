import * as React from "react"
import { Select as BaseSelect } from "@base-ui/react/select"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/icon/Icon"

type SelectRootProps = {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** Позволяет `Select.Value` резолвить label выбранного элемента вместо сырого value. */
  items?: ReadonlyArray<{ label: React.ReactNode; value: string }>
  children: React.ReactNode
}

function Select({ value, defaultValue, onValueChange, items, children }: SelectRootProps) {
  return (
    <BaseSelect.Root value={value} defaultValue={defaultValue} onValueChange={onValueChange as (value: string | null) => void} items={items}>
      {children}
    </BaseSelect.Root>
  )
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Trigger> & { size?: "sm" | "default" | "lg" }) {
  return (
    <BaseSelect.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 aria-invalid:border-destructive flex w-fit items-center justify-between gap-2 rounded-lg border bg-background px-2 py-1.5 text-sm whitespace-nowrap shadow-none outline-none focus-visible:outline-none hover:bg-interactive-hover data-[popup-open]:bg-interactive-active focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=lg]:h-10 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children ?? <BaseSelect.Icon><Icon name="arrow-down-s" className="size-4 opacity-50" /></BaseSelect.Icon>}
    </BaseSelect.Trigger>
  )
}

function SelectValue({
  placeholder,
  ...props
}: React.ComponentProps<typeof BaseSelect.Value> & { placeholder?: React.ReactNode }) {
  return (
    <BaseSelect.Value data-slot="select-value" placeholder={placeholder} {...props} />
  )
}

function SelectContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Popup>) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner sideOffset={4} collisionPadding={8} className="z-[120]">
        <BaseSelect.Popup
          data-slot="select-content"
          className={cn(
            "z-[120] max-h-60 min-w-[8rem] overflow-hidden rounded-xl bg-popover text-popover-foreground p-1 ring-1 ring-foreground/10 shadow-lg",
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
            className
          )}
          {...props}
        >
          <div>{children}</div>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Item>) {
  return (
    <BaseSelect.Item
      data-slot="select-item"
      className={cn(
        "data-[highlighted]:bg-interactive-hover relative flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <BaseSelect.ItemIndicator>
          <Icon name="check" className="size-4" />
        </BaseSelect.ItemIndicator>
      </span>
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
    </BaseSelect.Item>
  )
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }