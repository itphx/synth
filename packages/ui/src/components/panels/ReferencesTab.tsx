import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { synthApi } from '@/lib/api/synthApi'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/useUIStore'

interface Reference {
  sessionId: string
  label: string
  messageRange: [number, number]
  autoSummary?: string
  createdAt: string
}

interface ReferencesTabProps {
  sessionId: string
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
  } catch {
    return iso
  }
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

export function ReferencesTab({ sessionId }: ReferencesTabProps) {
  const { t } = useI18n()
  const [refs, setRefs] = useState<Reference[]>([])
  const [sessionNames, setSessionNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const { setMessages } = useChatStore()
  const openTab = useUIStore((s) => s.openTab)

  const load = async () => {
    setLoading(true)
    try {
      const result = await synthApi.getSessionReferences(sessionId)
      const references = result.references || []
      setRefs(references)

      // Fetch names for all referenced sessions in parallel
      const names: Record<string, string> = {}
      await Promise.all(
        references.map(async (ref) => {
          try {
            const session = await synthApi.getSession(ref.sessionId)
            names[ref.sessionId] = session.name || ref.sessionId
          } catch {
            names[ref.sessionId] = ref.sessionId
          }
        }),
      )
      setSessionNames(names)
    } catch {
      setRefs([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [sessionId])

  const handleOpen = (refSessionId: string) => {
    openTab({
      id: `chat-${refSessionId}`,
      type: 'chat',
      title: sessionNames[refSessionId] || refSessionId,
      data: { sessionId: refSessionId },
    })
  }

  const handleRemove = async (e: React.MouseEvent, refSessionId: string) => {
    e.stopPropagation()
    await synthApi.removeSessionReference(sessionId, refSessionId)
    setRefs((prev) => prev.filter((r) => r.sessionId !== refSessionId))
    const msgResult = await synthApi.getSessionMessages(sessionId)
    setMessages(sessionId, msgResult.messages)
  }

  if (loading) {
    return <div className="p-4 text-xs text-muted-foreground text-center">...</div>
  }

  if (refs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <Icon name="link" className="h-6 w-6 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{t('reference.empty')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      {refs.map((ref) => {
        const name =
          ref.label || sessionNames[ref.sessionId] || shortId(ref.sessionId)
        return (
          <div
            key={ref.sessionId}
            onClick={() => handleOpen(ref.sessionId)}
            className="flex items-start gap-2 p-2 rounded-lg border border-border/50 bg-card text-xs group cursor-pointer hover:border-blue-500/30 hover:bg-accent/50 transition-colors"
          >
            <Icon
              name="link"
              className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{name}</div>
              <div className="text-muted-foreground">
                {t('reference.range')}: {ref.messageRange?.[0]}–{ref.messageRange?.[1]}
              </div>
              {ref.autoSummary && (
                <p className="text-muted-foreground mt-0.5 line-clamp-2 italic">
                  «{ref.autoSummary}»
                </p>
              )}
              <div className="text-muted-foreground text-[0.625rem] mt-1">
                {t('reference.attached')}: {formatDate(ref.createdAt)}
              </div>
            </div>
            <button
              onClick={(e) => handleRemove(e, ref.sessionId)}
              title={t('reference.remove')}
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive p-0.5 transition-all shrink-0"
            >
              <Icon name="close" className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
