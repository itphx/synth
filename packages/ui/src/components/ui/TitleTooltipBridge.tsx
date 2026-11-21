import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

type Tip = { text: string; x: number; top: number; bottom: number; lines?: TipLine[] }
type Pos = { left: number; top: number; maxWidth?: number }

/**
 * Строка подсказки с признаком «второстепенная» (провайдер, окно контекста,
 * описание роли — приглушённый цвет).
 */
export interface TipLine {
  text: string
  muted?: boolean
}

const ATTR = 'data-title-tip'
/** JSON-строки подсказки: `[{ text, muted? }]` — стилизация частей без HTML. */
const LINES_ATTR = 'data-title-tip-lines'

/**
 * Разбор `data-title-tip-lines`. Невалидный JSON/пустые строки — просто без
 * строк (подсказка показывается плоским текстом, как раньше).
 */
function readLines(el: Element): TipLine[] | null {
  const raw = el.getAttribute(LINES_ATTR)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const lines: TipLine[] = []
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      const text = (entry as { text?: unknown }).text
      if (typeof text !== 'string' || !text.trim()) continue
      const muted = (entry as { muted?: unknown }).muted === true
      lines.push({ text, ...(muted ? { muted: true } : {}) })
    }
    return lines.length > 0 ? lines : null
  } catch {
    return null
  }
}
const DELAY_MS = 600
const MARGIN = 8
const GAP = 6
const SKIP_TAGS = new Set(['IFRAME', 'SVG', 'TITLE'])

function Tooltip({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Pos | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Измеряем после кадра, а не в layout-эффекте: иначе чтение layout сразу после
    // коммита DOM форсирует синхронный reflow (Forced reflow violation).
    const frame = requestAnimationFrame(() => {
      const w = el.offsetWidth
      const h = el.offsetHeight
      const vw = window.innerWidth
      const vh = window.innerHeight
      let top: number
      if (h <= tip.top - MARGIN) {
        top = tip.top - GAP - h
      } else if (h <= vh - tip.bottom - MARGIN) {
        top = tip.bottom + GAP
      } else {
        top = Math.max(MARGIN, tip.top - GAP - h)
      }
      if (vw < w + MARGIN * 2) {
        setPos({ left: MARGIN, top, maxWidth: vw - MARGIN * 2 })
        return
      }
      const left = Math.min(Math.max(tip.x - w / 2, MARGIN), vw - w - MARGIN)
      setPos({ left, top })
    })
    return () => cancelAnimationFrame(frame)
  }, [tip])

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className={cn(
        'pointer-events-none fixed z-50 max-w-xs rounded-md border border-border bg-sidebar px-3 py-1.5 text-xs text-foreground shadow-lg whitespace-pre-line',
      )}
      style={{
        left: pos?.left,
        top: pos?.top,
        maxWidth: pos?.maxWidth,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {tip.lines ? (
        <span className="flex flex-col gap-0.5">
          {tip.lines.map((line, index) => (
            <span key={index} className={line.muted ? 'text-muted-foreground' : undefined}>
              {line.text}
            </span>
          ))}
        </span>
      ) : (
        tip.text
      )}
    </div>,
    document.body,
  )
}

export function TitleTooltipBridge() {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    // На устройствах без hover (тач) нативные title-подсказки не работают —
    // не вешаем глобальные capture-слушатели и не делаем лишнюю работу.
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return

    let current: Element | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let frame: number | null = null
    let shown = false
    let ancestors: Array<{ el: Element; title: string }> = []

    const restoreAncestors = () => {
      for (let i = ancestors.length - 1; i >= 0; i--) ancestors[i]!.el.setAttribute('title', ancestors[i]!.title)
      ancestors = []
    }

    const suppressAncestors = (el: Element) => {
      let p = el.parentElement
      while (p) {
        const t = p.getAttribute('title')
        if (t) { ancestors.push({ el: p, title: t }); p.removeAttribute('title') }
        p = p.parentElement
      }
    }

    const cancelFrame = () => {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null }
    }

    const hide = () => {
      // Ничего не показано и не запланировано — не пишем в DOM и не ре-рендерим.
      if (!timer && !current) return
      if (timer) { clearTimeout(timer); timer = null }
      cancelFrame()
      if (current) {
        const text = current.getAttribute(ATTR)
        if (text) current.setAttribute('title', text)
        current.removeAttribute(ATTR)
        current = null
      }
      restoreAncestors()
      if (shown) {
        shown = false
        setTip(null)
      }
    }

    const show = (el: Element) => {
      const text = el.getAttribute('title') ?? el.getAttribute(ATTR) ?? ''
      if (!text.trim()) return
      if (!el.hasAttribute(ATTR)) {
        el.setAttribute(ATTR, text)
        el.removeAttribute('title')
      }
      // Строки с акцентом (JSON-массив `{text, muted}`): позволяют приглушить
      // второстепенные части (провайдер, окно контекста, описание роли), сохранив
      // порядок строк. Без атрибута — прежний плоский текст.
      const lines = readLines(el)
      suppressAncestors(el)
      current = el
      timer = setTimeout(() => {
        timer = null
        if (current !== el || !el.isConnected) return
        // Координаты читаем после кадра, а не синхронно в обработчике события.
        frame = requestAnimationFrame(() => {
          frame = null
          if (current !== el || !el.isConnected) return
          const r = el.getBoundingClientRect()
          shown = true
          setTip({ text, x: r.left + r.width / 2, top: r.top, bottom: r.bottom, ...(lines ? { lines } : {}) })
        })
      }, DELAY_MS)
    }

    const onOver = (e: Event) => {
      const t = e.target as Element | null
      if (!t || t.nodeType !== 1) return
      if (SKIP_TAGS.has(t.tagName)) return
      const el = t.closest?.('[title]') ?? null
      if (!el) {
        if (current && current.contains(t)) return
        if (current) hide()
        return
      }
      if (el === current) return
      hide()
      show(el)
    }

    const onOut = (e: Event) => {
      const t = e.target as Element | null
      if (!t || t.nodeType !== 1) return
      const el = t.closest?.(`[${ATTR}]`)
      if (!el) return
      const rel = (e as MouseEvent).relatedTarget as Element | null
      if (rel && el.contains(rel)) return
      hide()
    }

    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onOut, true)
    document.addEventListener('mousedown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onOut, true)
      document.removeEventListener('mousedown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      hide()
    }
  }, [])

  if (!tip) return null
  return <Tooltip tip={tip} />
}
