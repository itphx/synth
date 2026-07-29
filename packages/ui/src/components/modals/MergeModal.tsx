import { useState, useEffect, useRef, useMemo } from 'react'
import { useI18n } from '@/lib/i18n'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Icon } from '@/components/icon/Icon'
import { synthApi, type SessionData } from '@/lib/api/synthApi'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useChatStore } from '@/stores/chatStore'
import type { MessageData } from '@/stores/chatStore'

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  } catch {
    return iso.slice(0, 10)
  }
}

/** Оборачиваем длинный контент в превью */
function previewContent(content: string, maxLen = 100): string {
  const oneLine = content.replace(/\n/g, ' ').trim()
  if (oneLine.length <= maxLen) return oneLine
  return oneLine.slice(0, maxLen) + '…'
}

export function MergeModal() {
  const { t } = useI18n()
  const {
    isMergeModalOpen,
    mergeModalSessionId,
    closeMergeModal,
  } = useUIStore()
  const { sessions } = useSessionsStore()
  const { setMessages } = useChatStore()
  const [query, setQuery] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [sourceId, setSourceId] = useState('')
  const [fromSeq, setFromSeq] = useState('1')
  const [toSeq, setToSeq] = useState('')
  const [position, setPosition] = useState<'after' | 'before'>('after')
  const [summarize, setSummarize] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sourceSession, setSourceSession] = useState<SessionData | null>(null)
  const [sourceMessages, setSourceMessages] = useState<MessageData[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [selectedSeqs, setSelectedSeqs] = useState<Set<number>>(new Set())
  const comboboxRef = useRef<HTMLDivElement>(null)

  const otherSessions = useMemo(
    () => sessions.filter((s: SessionData) => s.id !== mergeModalSessionId),
    [sessions, mergeModalSessionId]
  )

  const filteredSessions = useMemo(() => {
    if (!query.trim()) return otherSessions
    const q = query.toLowerCase()
    return otherSessions.filter(
      (s: SessionData) =>
        (s.name?.toLowerCase().includes(q)) ||
        s.id.toLowerCase().includes(q)
    )
  }, [otherSessions, query])

  useEffect(() => {
    if (isMergeModalOpen) {
      setQuery('')
      setSourceId('')
      setFromSeq('1')
      setToSeq('')
      setPosition('after')
      setSummarize(false)
      setError('')
      setSourceSession(null)
      setSourceMessages([])
      setSelectedSeqs(new Set())
      setDropdownOpen(false)
    }
  }, [isMergeModalOpen])

  // Load session info + messages when sourceId changes
  useEffect(() => {
    if (!sourceId) {
      setSourceSession(null)
      setSourceMessages([])
      setSelectedSeqs(new Set())
      return
    }
    let cancelled = false
    setLoadingMessages(true)

    Promise.all([
      synthApi.getSession(sourceId),
      synthApi.getSessionMessages(sourceId),
    ]).then(([session, msgResp]) => {
      if (!cancelled) {
        setSourceSession(session)
        const msgs = (msgResp.messages || [])
          .filter((m: MessageData) => !m.hidden && !m.disabled)
          .sort((a: MessageData, b: MessageData) => (a.seq ?? 0) - (b.seq ?? 0))
        setSourceMessages(msgs)
        const msgCount = session.messages?.length || msgs.length
        setToSeq(String(msgCount))
        // Select all by default
        setSelectedSeqs(new Set(msgs.map((m: MessageData) => m.seq ?? 0)))
        setLoadingMessages(false)
      }
    }).catch(() => {
      if (!cancelled) setLoadingMessages(false)
    })
    return () => { cancelled = true }
  }, [sourceId])

  // Sync selectedSeqs → fromSeq/toSeq
  useEffect(() => {
    if (selectedSeqs.size === 0) return
    const sorted = [...selectedSeqs].sort((a, b) => a - b)
    setFromSeq(String(sorted[0]))
    setToSeq(String(sorted[sorted.length - 1]))
  }, [selectedSeqs])

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (comboboxRef.current && !comboboxRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  if (!isMergeModalOpen || !mergeModalSessionId) return null

  const handleSelect = (id: string) => {
    setSourceId(id)
    const selected = otherSessions.find((s: SessionData) => s.id === id)
    setQuery(selected?.name || id)
    setDropdownOpen(false)
  }

  const toggleSeq = (seq: number) => {
    setSelectedSeqs(prev => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }

  const isAllSelected = sourceMessages.length > 0 && selectedSeqs.size === sourceMessages.length
  const toggleAll = () => {
    if (isAllSelected) {
      setSelectedSeqs(new Set())
    } else {
      setSelectedSeqs(new Set(sourceMessages.map((m: MessageData) => m.seq ?? 0)))
    }
  }

  const handleMerge = async () => {
    if (!sourceId) { setError('Выберите сессию-источник'); return }
    const from = parseInt(fromSeq) || 1
    const to = parseInt(toSeq) || (sourceSession?.messages?.length || 9999)
    setLoading(true)
    try {
      await synthApi.mergeMessages(mergeModalSessionId, sourceId, {
        sourceRange: [from, to],
        position,
        summarize,
      })
      closeMergeModal()
      const msgResult = await synthApi.getSessionMessages(mergeModalSessionId)
      setMessages(mergeModalSessionId, msgResult.messages)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={isMergeModalOpen} onOpenChange={(open) => { if (!open) closeMergeModal() }}>
      <DialogContent className="max-w-md p-6 gap-4" showCloseButton={true}>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Icon name="links-line" className="h-5 w-5" />
          {t('merge.title')}
        </h2>

        <div className="flex flex-col gap-3">
          {/* Searchable combobox */}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">{t('merge.selectSession')}</label>
            <div ref={comboboxRef} className="relative">
              <div className="relative">
                <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    if (!sourceId || e.target.value !== (otherSessions.find(s => s.id === sourceId)?.name || sourceId)) {
                      setSourceId('')
                      setSourceSession(null)
                      setSourceMessages([])
                      setSelectedSeqs(new Set())
                    }
                    setDropdownOpen(true)
                  }}
                  onFocus={() => setDropdownOpen(true)}
                  placeholder={t('merge.selectSession') + '...'}
                  className="w-full rounded-lg border bg-background pl-9 pr-3 py-2 text-sm"
                />
              </div>
              {dropdownOpen && filteredSessions.length > 0 && (
                <div className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto rounded-lg border bg-popover shadow-lg">
                  {filteredSessions.map((s: SessionData) => {
                    const msgCount = s.messages?.length || 0
                    const date = formatDate(s.created_at)
                    const isSelected = s.id === sourceId
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => handleSelect(s.id)}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center justify-between gap-2 ${isSelected ? 'bg-accent' : ''}`}
                      >
                        <span className="truncate flex-1">{s.name || s.id}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {msgCount} msg, {date}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {dropdownOpen && query && filteredSessions.length === 0 && (
                <div className="absolute z-20 mt-1 w-full rounded-lg border bg-popover shadow-lg px-3 py-2 text-sm text-muted-foreground">
                  Сессии не найдены
                </div>
              )}
            </div>
          </div>

          {/* Session preview */}
          {sourceSession && (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
              <Icon name="links-line" className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="text-xs truncate">
                <span className="text-muted-foreground">Источник: </span>
                <span className="font-medium">{sourceSession.name || sourceSession.id}</span>
                <span className="text-muted-foreground">
                  {' '}({sourceSession.messages?.length || 0} сообщ., {formatDate(sourceSession.created_at)})
                </span>
              </div>
              {loadingMessages && <Icon name="loader-2" className="h-3 w-3 animate-spin shrink-0" />}
            </div>
          )}

          {/* Visual message selector */}
          {sourceId && sourceMessages.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-muted-foreground">Сообщения ({selectedSeqs.size}/{sourceMessages.length})</label>
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-primary hover:underline"
                >
                  {isAllSelected ? 'Снять всё' : 'Выбрать всё'}
                </button>
              </div>
              <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
                {sourceMessages.map((msg: MessageData) => {
                  const seq = msg.seq ?? 0
                  const checked = selectedSeqs.has(seq)
                  const roleLabel = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '🔧'
                  return (
                    <label
                      key={seq}
                      className={`flex items-start gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-accent/50 ${checked ? 'bg-accent/30' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSeq(seq)}
                        className="mt-0.5 shrink-0"
                      />
                      <span className="text-muted-foreground shrink-0">#{seq}</span>
                      <span className="shrink-0">{roleLabel}</span>
                      <span className="truncate text-muted-foreground">
                        {previewContent(msg.content)}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {/* Numeric range (fallback) */}
          {sourceId && (
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground block mb-1">{t('merge.range')}</label>
                <div className="flex gap-1 items-center">
                  <input type="number" value={fromSeq} onChange={(e) => setFromSeq(e.target.value)}
                    className="w-16 rounded-lg border bg-background px-2 py-2 text-sm" placeholder="1" min={1} />
                  <span className="text-muted-foreground">–</span>
                  <input type="number" value={toSeq} onChange={(e) => setToSeq(e.target.value)}
                    className="w-16 rounded-lg border bg-background px-2 py-2 text-sm" placeholder="..." min={1} />
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
          )}

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={summarize} onChange={(e) => setSummarize(e.target.checked)} />
            {t('merge.summarize')}
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <button
            onClick={handleMerge}
            disabled={loading || !sourceId}
            className="w-full px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
          >
            <Icon name="external-link" className="h-4 w-4" />
            {loading ? '...' : t('merge.copy')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
