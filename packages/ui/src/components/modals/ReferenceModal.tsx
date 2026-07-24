import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Icon } from '@/components/icon/Icon'
import { synthApi, type SessionData } from '@/lib/api/synthApi'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'

export function ReferenceModal() {
  const { t } = useI18n()
  const {
    isReferenceModalOpen,
    referenceModalSessionId,
    closeReferenceModal,
  } = useUIStore()
  const { sessions } = useSessionsStore()
  const [sourceId, setSourceId] = useState('')
  const [label, setLabel] = useState('')
  const [autoSummarize, setAutoSummarize] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (isReferenceModalOpen) {
      setSourceId('')
      setLabel('')
      setAutoSummarize(true)
      setError('')
    }
  }, [isReferenceModalOpen])

  if (!isReferenceModalOpen || !referenceModalSessionId) return null

  const handleAdd = async () => {
    if (!sourceId) { setError('Выберите сессию-источник'); return }
    setLoading(true)
    try {
      await synthApi.addSessionReference(referenceModalSessionId, sourceId, {
        label: label || undefined,
        autoSummarize,
      })
      closeReferenceModal()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const otherSessions = sessions.filter((s: SessionData) => s.id !== referenceModalSessionId)

  return (
    <Dialog open={isReferenceModalOpen} onOpenChange={(open) => { if (!open) closeReferenceModal() }}>
      <DialogContent className="max-w-md p-6 gap-4" showCloseButton={true}>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Icon name="link" className="h-5 w-5" />
          {t('reference.title')}
        </h2>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">{t('reference.selectSession')}</label>
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            >
              <option value="">— {t('reference.selectSession')} —</option>
              {otherSessions.map((s: SessionData) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id} ({s.messages?.length || 0} msg)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">{t('reference.label')}</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('reference.labelPlaceholder')}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={autoSummarize}
              onChange={(e) => setAutoSummarize(e.target.checked)}
            />
            {t('reference.autoSummarize')}
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <button
            onClick={handleAdd}
            disabled={loading || !sourceId}
            className="w-full px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50 transition-colors"
          >
            {loading ? '...' : t('reference.add')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
