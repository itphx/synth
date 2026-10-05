import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { CURRENCY_OPTIONS, currencySymbol, normalizeCurrency, type Currency } from '@/lib/currency'

interface CurrencyPickerProps {
  /** Валюта модели; может отсутствовать — тогда показывается валюта провайдера/доллар. */
  value?: string
  onChange: (currency: Currency) => void
}

/** Компактная кнопка валюты с поповером выбора (RUB/USD/CNY). */
export function CurrencyPicker({ value, onChange }: CurrencyPickerProps) {
  const { t } = useI18n()
  const active = normalizeCurrency(value)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('admin.models.currency')}
          title={t('admin.models.currency')}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border text-[0.625rem] leading-none text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {currencySymbol(value)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1">
        {CURRENCY_OPTIONS.map((currency) => (
          <button
            key={currency}
            type="button"
            onClick={() => onChange(currency)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground',
            )}
          >
            <span className="w-3 text-center">{currencySymbol(currency)}</span>
            <span className="flex-1">{t(`admin.models.currency.${currency}`)}</span>
            {active === currency && <Icon name="check" className="size-3.5" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
