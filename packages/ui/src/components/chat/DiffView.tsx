/**
 * Рендер unified diff'а (общий для карточки тула и превью в запросе
 * подтверждения). Строки `+`/`-`/пробел различаются классами `diff-added`/
 * `diff-removed`/`diff-header` (см. `styles/index.css`).
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header'
  text: string
}

export function parseDiff(diffText: string): DiffLine[] {
  const lines = diffText.split('\n')
  return lines.map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      return { type: 'header' as const, text: line }
    }
    if (line.startsWith('+')) return { type: 'add' as const, text: line }
    if (line.startsWith('-')) return { type: 'remove' as const, text: line }
    return { type: 'context' as const, text: line }
  })
}

export function DiffView({ diff }: { diff: string }) {
  const parsed = parseDiff(diff)
  return (
    <pre className="text-[0.6875rem] leading-relaxed overflow-x-auto font-mono m-0 p-0 bg-transparent">
      {parsed.map((line, i) => (
        <span
          key={i}
          className={
            line.type === 'add'
              ? 'diff-added block'
              : line.type === 'remove'
                ? 'diff-removed block'
                : line.type === 'header'
                  ? 'diff-header block'
                  : 'block opacity-70'
          }
        >
          {line.text || ' '}
        </span>
      ))}
    </pre>
  )
}
