import type { ConfirmVariant } from '@/components/ui/confirm-dialog'

export type ConfirmAction = {
  title: string
  message?: string
  variant: ConfirmVariant
  onConfirm: () => void
}
