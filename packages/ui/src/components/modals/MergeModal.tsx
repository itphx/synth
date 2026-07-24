import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Icon } from '@/components/icon/Icon'
import { synthApi, type SessionData } from '@/lib/api/synthApi'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useChatStore } from '@/stores/chatStore'

export function MergeModal() {
  const { t } = useI18n()
  const {
    isMergeModalOpen,
    mergeModalSessionId,
    closeMergeModal,
  } = useUIStore()
  const { sessions } = useSessionsStore()
  const { setMessages } = useChatStore()
  const [sourceId, setSourceId] = useState('')
  const [fromSeq, setFromSeq] = useState('1')
  const [toSeq, setToSeq] = useState('')
  const [position, setPosition] = useState<'after' | 'before'>('after')
  const [summarize, setSummarize] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (isMergeModalOpen) {
      setSourceId('')
      setFromSeq('1')
      setToSeq('')
      setPosition('after')
      setSummarize(false)
      setError('')
    }
  }, [isMergeModalOpen])

  if (!isMergeModalOpen || !mergeModalSessionId) return null

  const handleMerge = async () => {
    if (!sourceId) { setError('Выберите сессию-источник'); return }
    const from = parseInt(fromSeq) || 1
    const to = parseInt(toSeq) || 9999
    setLoading(true)
    try {
      const result = await synthApi.mergeMessages(mergeModalSessionId, sourceId, {
        sourceRange: [from, to],
        position,
        summarize,
      })
      closeMergeModal()
      // Refresh messages
      const msgResult = await synthApi.getSessionMessages(mergeModalSessionId)
      setMessages(mergeModalSessionId, msgResult.messages)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const otherSessions = sessions.filter((s: SessionData) => s.id !== mergeModalSessionId)

  return (
    <Dialog open={isMergeModalOpen} onOpenChange={(open) => { if (!open) closeMergeModal() }}>
      <DialogContent className="max-w-md p-6 gap-4" showCloseButton={true}>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Icon name="file-copy" className="h-5 w-5" />
          {t('merge.title')}
        </h2>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">{t('merge.selectSession')}</label>
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            >
              <option value="">— {t('merge.selectSession')} —</option>
              {otherSessions.map((s: SessionData) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id} ({s.messages?.length || 0} msg)
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground block mb-1">{t('merge.range')}</label>
              <div className="flex gap-1 items-center">
                <input type="number" value={fromSeq} onChange={(e) => setFromSeq(e.target.value)}
                  className="w-16 rounded-lg border bg-background px-2 py-2 text-sm" placeholder="1" />
                <span className="text-muted-foreground">–</span>
                <input type="number" value={toSeq} onChange={(e) => setToSeq(e.target.value)}
                  className="w-16 rounded-lg border bg-background px-2 py-2 text-sm" placeholder="..." />
              </div>
            </div>
            <div className="flex-1">
              <label className="text-xs text-muted-foreground block mb-1">{t('merge.position')}</label>
              <select value={position} onChange={(e) => setPosition(e.target.value as 'after' | 'before')}
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm">
                <option value="after">{t('merge.position.after')}</option>
                <option value="before">{t('merge.position.before')}</option>
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={summarize} onChange={(e) => setSummarize(e.target.checked)} />
            {t('merge.summarize')}
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <button
            onClick={handleMerge}
            disabled={loading || !sourceId}
            className="w-full px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50 transition-colors"
          >
            {loading ? '...' : t('merge.copy')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
