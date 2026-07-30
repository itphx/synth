import { memo } from 'react'

export interface QualityBadgeProps {
  qa_pass: boolean
  qa_reason?: string
}

function QualityBadgeInner({ qa_pass, qa_reason }: QualityBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 shrink-0 rounded px-1 text-[10px] font-medium border ${
        qa_pass
          ? 'bg-green-500/10 text-green-600 border-green-500/20'
          : 'bg-red-500/10 text-red-600 border-red-500/20'
      }`}
      title={qa_reason || undefined}
    >
      {qa_pass ? '✓' : '✗'}
    </span>
  )
}

export const QualityBadge = memo(QualityBadgeInner)
