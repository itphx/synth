import { memo } from 'react'

export interface QualityBadgeProps {
  qa_pass: boolean
  qa_reason?: string
}

function QualityBadgeInner({ qa_pass, qa_reason }: QualityBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 shrink-0 rounded px-1 text-[0.625rem] font-medium border ${
        qa_pass
          ? 'bg-status-success/10 text-status-success border-status-success/20'
          : 'bg-status-error/10 text-status-error border-status-error/20'
      }`}
      title={qa_reason || undefined}
    >
      {qa_pass ? '✓' : '✗'}
    </span>
  )
}

export const QualityBadge = memo(QualityBadgeInner)
