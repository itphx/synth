import { Icon } from '../icon/Icon'

interface ScrollToBottomButtonProps {
  visible: boolean
  onClick: () => void
}

export function ScrollToBottomButton({ visible, onClick }: ScrollToBottomButtonProps) {
  if (!visible) return null

  return (
    <button
      onClick={onClick}
      className="absolute bottom-4 right-6 z-10 rounded-full bg-card border border-border shadow-md p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-all animate-in fade-in slide-in-from-bottom-2"
    >
      <Icon name="arrow-down" className="size-4" />
    </button>
  )
}
