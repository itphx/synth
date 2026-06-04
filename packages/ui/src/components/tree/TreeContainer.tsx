import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface TreeContainerProps {
  children: ReactNode
  className?: string
  loading?: boolean
  loadingText?: string
}

export function TreeContainer({ children, className, loading, loadingText }: TreeContainerProps) {
  return (
    <div className={cn('flex-1 overflow-y-auto py-1', className)}>
      {loading && (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {loadingText ?? 'Loading...'}
        </div>
      )}
      {children}
    </div>
  )
}
