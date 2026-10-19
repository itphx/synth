import React from 'react'

import { useDevice } from '@/hooks/useDevice'
import { useI18n } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { cn } from '@/lib/utils'
import { Button } from '../button'
import { Icon } from '@/components/icon/Icon'
import { SettingsAdvancedProvider, type SettingsAdvancedContextValue } from './SettingsAdvancedContext'

export interface SettingsPanelProps {
  title: string
  description?: string
  /**
   * Счётчики/подпись. Рендерится под описанием (`description`), а не под
   * заголовком. В отличие от `description`, остаётся видимым при сворачивании
   * шапки (стандарт ADR-072).
   */
  meta?: React.ReactNode
  actions?: React.ReactNode
  /**
   * На не-десктопе при прокрутке тела сворачивать описание шапки
   * (заголовок, `meta` и `actions` остаются). На десктопе описание видно всегда.
   */
  collapsibleHeader?: boolean
  className?: string
  children: React.ReactNode
}

const CONTENT_WIDTH = 'mx-auto w-full max-w-3xl min-w-0'

const HIGHLIGHT_CLASSES = ['ring-2', 'ring-ring', 'ring-offset-2', 'ring-offset-background']
const HIGHLIGHT_MS = 1800
const FOCUS_OFFSET_PX = 8

/**
 * ADR-072: стандартный каркас панели настроек.
 *
 * Гарантирует один вертикальный скролл, фиксированную шапку и отсутствие
 * горизонтального скролла: весь контент ограничен `max-w-3xl` и центрирован,
 * вложенные элементы получают `min-w-0`/`break-words`.
 *
 * Здесь же — локальное раскрытие продвинутых секций: при выключенном глобальном
 * режиме «Расширенные» в конце тела появляется кнопка «Показать дополнительные».
 */
export function SettingsPanel({
  title,
  description,
  meta,
  actions,
  collapsibleHeader = true,
  className,
  children,
}: SettingsPanelProps) {
  const { t } = useI18n()
  const { deviceType } = useDevice()
  const [collapsed, setCollapsed] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement>(null)

  const showAdvancedGlobally = useUIStore((state) => state.settingsShowAdvanced)
  const settingsFocus = useUIStore((state) => state.settingsFocus)
  const [reveal, setReveal] = React.useState(false)
  const [advancedCount, setAdvancedCount] = React.useState(0)

  const registerAdvanced = React.useCallback(() => {
    setAdvancedCount((count) => count + 1)
    return () => setAdvancedCount((count) => Math.max(0, count - 1))
  }, [])

  const advancedVisible = showAdvancedGlobally || reveal
  const advancedValue = React.useMemo<SettingsAdvancedContextValue>(
    () => ({ visible: advancedVisible, registerAdvanced }),
    [advancedVisible, registerAdvanced],
  )

  React.useEffect(() => {
    const el = bodyRef.current
    if (!el) return

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      // Допуск на дробные пиксели при UI-масштабе (layout может давать
      // остаток ~1–2px у самого дна скролла): у края фейд гарантированно снимается.
      const EDGE = 4
      const hasTop = scrollTop > EDGE
      const hasBottom = Math.ceil(scrollHeight - scrollTop - clientHeight) > EDGE
      if (hasTop && hasBottom) {
        el.setAttribute('data-scroll-shadow', 'top-bottom')
      } else if (hasTop) {
        el.setAttribute('data-scroll-shadow', 'top')
      } else if (hasBottom) {
        el.setAttribute('data-scroll-shadow', 'bottom')
      } else {
        el.removeAttribute('data-scroll-shadow')
      }
      setCollapsed(collapsibleHeader && deviceType !== 'desktop' && scrollTop > 8)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update)
      ro.observe(el)
      const content = el.firstElementChild
      if (content) ro.observe(content)
    }
    return () => {
      el.removeEventListener('scroll', update)
      ro?.disconnect()
    }
  }, [collapsibleHeader, deviceType])

  // Фокус из поиска: прокрутка к секции внутри собственного скролл-контейнера
  // и короткая подсветка. Если секция продвинутая и скрыта — сначала раскрываем.
  React.useEffect(() => {
    if (!settingsFocus?.sectionId) return
    const body = bodyRef.current
    if (!body) return

    const target = Array.from(
      body.querySelectorAll<HTMLElement>('[data-settings-section]'),
    ).find((el) => el.getAttribute('data-settings-section') === settingsFocus.sectionId)
    if (!target) {
      if (!advancedVisible) setReveal(true)
      return
    }

    const bodyRect = body.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const top = body.scrollTop + targetRect.top - bodyRect.top - FOCUS_OFFSET_PX
    if (typeof body.scrollTo === 'function') {
      body.scrollTo({ top, behavior: 'smooth' })
    } else {
      body.scrollTop = top
    }

    target.classList.add(...HIGHLIGHT_CLASSES)
    const timer = window.setTimeout(() => {
      target.classList.remove(...HIGHLIGHT_CLASSES)
    }, HIGHLIGHT_MS)
    return () => {
      window.clearTimeout(timer)
      target.classList.remove(...HIGHLIGHT_CLASSES)
    }
  }, [settingsFocus?.nonce, settingsFocus?.sectionId, advancedVisible])

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      <header className="shrink-0 mx-auto w-full max-w-3xl flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 min-w-0">
          <h2 className="text-lg font-semibold text-foreground min-w-0 break-words">{title}</h2>
          {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
        </div>
        {description && (
          <div
            className={cn(
              'grid grid-cols-1 overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
              collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
            )}
            data-testid="settings-header-description"
            aria-hidden={collapsed || undefined}
          >
            <p className="text-sm text-muted-foreground min-w-0 min-h-0 overflow-hidden break-words">{description}</p>
          </div>
        )}
        {meta && (
          <div
            className="text-sm text-muted-foreground min-w-0 break-words"
            data-testid="settings-header-meta"
          >
            {meta}
          </div>
        )}
      </header>

      <div
        ref={bodyRef}
        className={cn(
          'settings-scroll-container flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain transition-[margin] duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'mt-2' : 'mt-4',
        )}
      >
        <SettingsAdvancedProvider value={advancedValue}>
          <div className={cn('space-y-4', CONTENT_WIDTH)}>
            {children}
            {advancedCount > 0 && !showAdvancedGlobally && (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-expanded={reveal}
                  onClick={() => setReveal((value) => !value)}
                  data-testid="settings-advanced-reveal"
                >
                  <Icon name={reveal ? 'arrow-up-s' : 'arrow-down-s'} className="size-4" />
                  {reveal
                    ? t('settings.advanced.hide')
                    : `${t('settings.advanced.show')} (${advancedCount})`}
                </Button>
              </div>
            )}
          </div>
        </SettingsAdvancedProvider>
      </div>
    </div>
  )
}
