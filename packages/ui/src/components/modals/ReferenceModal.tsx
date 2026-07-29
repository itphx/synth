import { useState, useEffect, useRef, useMemo } from 'react'
import { useI18n } from '@/lib/i18n'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Icon } from '@/components/icon/Icon'
import { synthApi, type SessionData } from '@/lib/api/synthApi'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  } catch {
    return iso.slice(0, 10)
  }
}

export function ReferenceModal() {
  const { t } = useI18n()
  const {
    isReferenceModalOpen,
    referenceModalSessionId,
    closeReferenceModal,
  } = useUIStore()
  const { sessions } = useSessionsStore()
  const [query, setQuery] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [sourceId, setSourceId] = useState('')
  const [fromSeq, setFromSeq] = useState('1')
  const [toSeq, setToSeq] = useState('')
  const [label, setLabel] = useState('')
  const [autoSummarize, setAutoSummarize] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sourceSession, setSourceSession] = useState<SessionData | null>(null)
  const [loadingSession, setLoadingSession] = useState(false)
  const comboboxRef = useRef<HTMLDivElement>(null)

  const otherSessions = useMemo(
    () => sessions.filter((s: SessionData) => s.id !== referenceModalSessionId),
    [sessions, referenceModalSessionId]
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
    if (isReferenceModalOpen) {
      setQuery('')
      setSourceId('')
      setFromSeq('1')
      setToSeq('')
      setLabel('')
      setAutoSummarize(true)
      setError('')
      setSourceSession(null)
      setDropdownOpen(false)
    }
  }, [isReferenceModalOpen])

  // Load session details when sourceId changes
  useEffect(() => {
    if (!sourceId) {
      setSourceSession(null)
      return
    }
    let cancelled = false
    setLoadingSession(true)
    synthApi.getSession(sourceId).then((s) => {
      if (!cancelled) {
        setSourceSession(s)
        const msgCount = s.messages?.length || 0
        setToSeq(String(msgCount))
        setLoadingSession(false)
      }
    }).catch(() => {
      if (!cancelled) setLoadingSession(false)
    })
    return () => { cancelled = true }
  }, [sourceId])

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

  if (!isReferenceModalOpen || !referenceModalSessionId) return null

  const handleSelect = (id: string) => {
    setSourceId(id)
    const selected = otherSessions.find((s: SessionData) => s.id === id)
    setQuery(selected?.name || id)
    setDropdownOpen(false)
  }

  const handleAdd = async () => {
    if (!sourceId) { setError('Выберите сессию-источник'); return }
    const from = parseInt(fromSeq) || 1
    const to = parseInt(toSeq) || (sourceSession?.messages?.length || 1)
    setLoading(true)
    try {
      await synthApi.addSessionReference(referenceModalSessionId, sourceId, {
        label: label || undefined,
        messageRange: [from, to],
        autoSummarize,
      })
      closeReferenceModal()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={isReferenceModalOpen} onOpenChange={(open) => { if (!open) closeReferenceModal() }}>
      <DialogContent className="max-w-md p-6 gap-4" showCloseButton={true}>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Icon name="link" className="h-5 w-5" />
          {t('reference.title')}
        </h2>

        <div className="flex flex-col gap-3">
          {/* Searchable combobox */}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">{t('reference.selectSession')}</label>
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
                    }
                    setDropdownOpen(true)
                  }}
                  onFocus={() => setDropdownOpen(true)}
                  placeholder={t('reference.selectSession') + '...'}
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
              <Icon name="link" className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="text-xs truncate">
                <span className="text-muted-foreground">Сессия: </span>
                <span className="font-medium">{sourceSession.name || sourceSession.id}</span>
                <span className="text-muted-foreground">
                  {' '}({sourceSession.messages?.length || 0} сообщ., {formatDate(sourceSession.created_at)})
                </span>
              </div>
              {loadingSession && <Icon name="loader-2" className="h-3 w-3 animate-spin shrink-0" />}
            </div>
          )}

          {/* Message range */}
          {sourceId && (
            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t('reference.range')}</label>
              <div className="flex gap-1 items-center">
                <input
                  type="number"
                  value={fromSeq}
                  onChange={(e) => setFromSeq(e.target.value)}
                  className="w-20 rounded-lg border bg-background px-2 py-2 text-sm"
                  placeholder="1"
                  min={1}
                  max={sourceSession?.messages?.length || 9999}
                />
                <span className="text-muted-foreground">–</span>
                <input
                  type="number"
                  value={toSeq}
                  onChange={(e) => setToSeq(e.target.value)}
                  className="w-20 rounded-lg border bg-background px-2 py-2 text-sm"
                  placeholder={String(sourceSession?.messages?.length || '')}
                  min={1}
                  max={sourceSession?.messages?.length || 9999}
                />
              </div>
            </div>
          )}

          {/* Label */}
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
            className="w-full px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
          >
            <Icon name="link" className="h-4 w-4" />
            {loading ? '...' : t('reference.add')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
