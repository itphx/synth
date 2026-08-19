import { Icon } from '../icon/Icon'

interface ScrollToBottomButtonProps {
  visible: boolean
  onClick: () => void
  /** Позиция по горизонтали (left). Если не задана — кнопка в правом углу (right-6). */
  left?: number
}

export function ScrollToBottomButton({ visible, onClick, left }: ScrollToBottomButtonProps) {
  if (!visible) return null

  return (
    <button
      onClick={onClick}
      className={`absolute bottom-4 z-10 rounded-full bg-card border border-border shadow-md p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-all animate-in fade-in slide-in-from-bottom-2 ${
        left == null ? 'right-6' : ''
      }`}
      style={left != null ? { left } : undefined}
    >
      <Icon name="arrow-down" className="size-4" />
    </button>
  )
}
