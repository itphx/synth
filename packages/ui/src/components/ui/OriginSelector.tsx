import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import type { EntityOrigin } from '@/lib/api/synthApi'
import { cn } from '@/lib/utils'

/**
 * Селектор «где создать» (гибридный режим): Локально / На сервере.
 * offline — сервер недоступен: показывается только «Локально», выбор заблокирован;
 * disabled — полная блокировка (origin продиктован контекстом, например выбран
 * remote-проект, в котором локальная сессия невозможна).
 */
export function OriginSelector({
  value,
  onChange,
  offline,
  disabled,
  className,
}: {
  value: EntityOrigin
  onChange: (v: EntityOrigin) => void
  offline?: boolean
  disabled?: boolean
  className?: string
}) {
  const { t } = useI18n()
  const shownValue = offline ? ('local' as EntityOrigin) : value
  const locked = offline || disabled
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-[0.65rem] text-muted-foreground">{t('hybrid.createWhere')}</span>
      <Select value={shownValue} onValueChange={(v) => onChange((v || 'local') as EntityOrigin)}>
        <SelectTrigger size="sm" disabled={locked} className="w-full text-xs border-0 bg-interactive rounded">
          <span className="truncate flex-1 text-left">
            {shownValue === 'remote' ? t('hybrid.createRemote') : t('hybrid.createLocal')}
          </span>
          <Icon name="arrow-down-s" className="size-3.5 opacity-50 shrink-0" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="local">{t('hybrid.createLocal')}</SelectItem>
          {!offline && <SelectItem value="remote">{t('hybrid.createRemote')}</SelectItem>}
        </SelectContent>
      </Select>
      {offline && <span className="text-[0.65rem] text-destructive">{t('hybrid.offlineShort')}</span>}
    </div>
  )
}
