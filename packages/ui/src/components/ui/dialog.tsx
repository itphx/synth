import * as React from "react"
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/icon/Icon"
import { useI18n } from "@/lib/i18n"

let openDialogCount = 0

type AsChildProps = { asChild?: boolean }

function Dialog({ ...props }: React.ComponentProps<typeof BaseDialog.Root>) {
  return <BaseDialog.Root {...props} />
}

function DialogClose({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof BaseDialog.Close> & AsChildProps) {
  return (
    <BaseDialog.Close data-slot="dialog-close" {...props}>
      {asChild && React.isValidElement(children) ? children : children}
    </BaseDialog.Close>
  )
}

const DialogOverlay = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Backdrop>
>(({ className, ...props }, ref) => {
  React.useEffect(() => {
    openDialogCount += 1
    document.documentElement.classList.add("dialog-open")
    return () => {
      openDialogCount = Math.max(0, openDialogCount - 1)
      if (openDialogCount === 0) {
        document.documentElement.classList.remove("dialog-open")
      }
    }
  }, [])

  return (
    <BaseDialog.Backdrop
      ref={ref as React.Ref<HTMLDivElement>}
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/70 backdrop-blur-sm",
        "transition-opacity duration-150 ease-out",
        "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
        className
      )}
      {...props}
    />
  )
})
DialogOverlay.displayName = "DialogOverlay"

type DialogContentProps = Omit<React.ComponentProps<typeof BaseDialog.Popup>, "children"> & {
  showCloseButton?: boolean
  children?: React.ReactNode
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogContentProps) {
  const { t } = useI18n()
  return (
    <BaseDialog.Portal>
      <DialogOverlay />
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none p-4">
        <BaseDialog.Popup
          data-slot="dialog-content"
          className={cn(
            "relative pointer-events-auto bg-background text-foreground flex flex-col w-full max-w-lg max-h-full gap-4 rounded-xl border p-6 shadow-none overflow-y-auto origin-center",
            "transition-all duration-150 ease-out",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]",
            className
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <BaseDialog.Close
              data-slot="dialog-close"
              className="absolute top-2 right-2 rounded-lg p-1.5 opacity-70 transition-opacity hover:opacity-100 hover:bg-interactive-hover text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <Icon name="close" className="size-4" />
              <span className="sr-only">{t('common.close')}</span>
            </BaseDialog.Close>
          )}
        </BaseDialog.Popup>
      </div>
    </BaseDialog.Portal>
  )
}

export { Dialog, DialogClose, DialogContent, DialogOverlay }