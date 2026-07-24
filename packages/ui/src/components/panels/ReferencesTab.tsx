import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { synthApi } from '@/lib/api/synthApi'
import { useChatStore } from '@/stores/chatStore'

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

export function ReferencesTab({ sessionId }: ReferencesTabProps) {
  const { t } = useI18n()
  const [refs, setRefs] = useState<Reference[]>([])
  const [loading, setLoading] = useState(false)
  const { setMessages } = useChatStore()

  const load = async () => {
    setLoading(true)
    try {
      const result = await synthApi.getSessionReferences(sessionId)
      setRefs(result.references || [])
    } catch {
      setRefs([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [sessionId])

  const handleRemove = async (refSessionId: string) => {
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
      {refs.map((ref) => (
        <div key={ref.sessionId} className="flex items-start gap-2 p-2 rounded-lg border border-border/50 bg-card text-xs group">
          <Icon name="link" className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{ref.label || ref.sessionId}</div>
            <div className="text-muted-foreground">
              {t('reference.source')}: <span className="font-mono text-[10px]">{ref.sessionId}</span>
            </div>
            <div className="text-muted-foreground">
              {t('reference.range')}: {ref.messageRange?.[0]}–{ref.messageRange?.[1]}
            </div>
            {ref.autoSummary && (
              <p className="text-muted-foreground mt-0.5 line-clamp-2">{ref.autoSummary}</p>
            )}
          </div>
          <button
            onClick={() => handleRemove(ref.sessionId)}
            title={t('reference.remove')}
            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive p-0.5 transition-all"
          >
            <Icon name="close" className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
