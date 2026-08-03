import { useUIStore } from "../../stores/useUIStore"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"

export const ChatSettings = () => {
  const { t } = useI18n()
  const intermediateTextDisplay = useUIStore((s) => s.intermediateTextDisplay)
  const setIntermediateTextDisplay = useUIStore((s) => s.setIntermediateTextDisplay)

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold mb-1">{t('settings.category.chat')}</h2>
        <p className="text-sm text-muted-foreground">{t('chatSettings.intermediateTextDescription')}</p>
      </div>

      <div className="space-y-3">
        <label className="text-sm font-medium">{t('chatSettings.intermediateTextDisplay')}</label>
        <div className="flex gap-2" role="radiogroup" aria-label={t('chatSettings.intermediateTextDisplay')}>
          <button
            role="radio"
            aria-checked={intermediateTextDisplay !== 'bottom'}
            onClick={() => setIntermediateTextDisplay('inline')}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              intermediateTextDisplay !== 'bottom'
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
            )}
          >
            {t('chatSettings.intermediateTextInline')}
          </button>
          <button
            role="radio"
            aria-checked={intermediateTextDisplay === 'bottom'}
            onClick={() => setIntermediateTextDisplay('bottom')}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              intermediateTextDisplay === 'bottom'
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
            )}
          >
            {t('chatSettings.intermediateTextBottom')}
          </button>
        </div>
      </div>
    </div>
  )
}
