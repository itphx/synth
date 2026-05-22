import type { QueuedMessage } from '../../stores/chatStore';

interface QueueChipsProps {
  pending: QueuedMessage[];
  onClear: () => void;
  onReturn: () => void;
}

export function QueueChips({ pending, onClear, onReturn }: QueueChipsProps) {
  if (pending.length === 0) return null;

  return (
    <div className="px-4 pb-2 space-y-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <span>В очереди: {pending.length}</span>
        <button
          onClick={onClear}
          className="hover:text-destructive px-1"
          title="Очистить очередь"
        >
          ✕
        </button>
      </div>
      <div className="space-y-1">
        {pending.map((msg, i) => (
          <div
            key={i}
            className="flex items-center gap-2 px-2 py-1 bg-muted/30 rounded text-xs border border-border/20"
          >
            <span className="text-muted-foreground shrink-0">
              {msg.agentRole ? `@${msg.agentRole}` : `#${i + 1}`}
            </span>
            <span className="truncate flex-1">
              {msg.content.slice(0, 100)}{msg.content.length > 100 ? '...' : ''}
            </span>
            <button
              onClick={onReturn}
              className="text-muted-foreground hover:text-foreground shrink-0 px-1"
              title="Вернуть в поле ввода"
            >
              ↩
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
