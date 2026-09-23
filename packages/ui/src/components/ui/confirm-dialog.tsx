import { Icon } from '@/components/icon/Icon'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useI18n } from '@/lib/i18n'
import type { IconName } from '@/components/icon/icons'

export type ConfirmVariant = 'danger' | 'warning' | 'default'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: ConfirmVariant
  icon?: IconName
  onConfirm: () => void
}

const variantConfig: Record<ConfirmVariant, { icon: IconName; buttonClass: string }> = {
  danger: { icon: 'delete-bin', buttonClass: 'bg-destructive text-destructive-foreground hover:bg-destructive/90' },
  warning: { icon: 'alert-triangle', buttonClass: 'bg-status-warning text-background hover:bg-status-warning/90' },
  default: { icon: 'alert', buttonClass: 'bg-primary text-primary-foreground hover:bg-primary/90' },
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  icon,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useI18n()
  const config = variantConfig[variant]
  const resolvedIcon = icon ?? config.icon

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="p-0 gap-0 max-w-sm">
        <div className="p-6">
          <div className="flex items-start gap-3 mb-4">
            <Icon name={resolvedIcon} className="size-5 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <h3 className="font-semibold text-sm text-foreground">{title}</h3>
              {message && (
                <p className="text-sm text-muted-foreground mt-1">{message}</p>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-muted-foreground text-muted-foreground hover:bg-interactive-hover transition-colors"
            >
              {cancelLabel ?? t('common.cancel')}
            </button>
            <button
              onClick={() => { onConfirm(); onOpenChange(false) }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${config.buttonClass}`}
            >
              {confirmLabel ?? t('common.confirm')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
