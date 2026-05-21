import React, { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { Icon } from '@/components/icon/Icon'

export const SummarizationTab: React.FC = () => {
  const { t } = useI18n()
  const [enabled, setEnabled] = useState(false)
  const [afterN, setAfterN] = useState(10)
  const [afterMinutes, setAfterMinutes] = useState(0)
  const [contextPercent, setContextPercent] = useState(0)

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-foreground">{t('rightPanel.summarization.enabled')}</span>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`relative h-5 w-9 rounded-full transition-colors ${
            enabled ? 'bg-primary' : 'bg-interactive'
          }`}
        >
          <div
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <div className="space-y-2">
        <NumberSetting
          label={t('rightPanel.summarization.afterN')}
          value={afterN}
          onChange={setAfterN}
          min={1}
          max={100}
        />
        <NumberSetting
          label={t('rightPanel.summarization.afterMinutes')}
          value={afterMinutes}
          onChange={setAfterMinutes}
          min={0}
          max={1440}
        />
        <NumberSetting
          label={t('rightPanel.summarization.contextPercent')}
          value={contextPercent}
          onChange={setContextPercent}
          min={0}
          max={100}
          suffix="%"
        />
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        {t('rightPanel.summarization.hint')}
      </p>
    </div>
  )
}

function NumberSetting({
  label,
  value,
  onChange,
  min,
  max,
  suffix = '',
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  suffix?: string
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        >
          <Icon name="subtract" className="h-3 w-3" />
        </button>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Math.min(max, Math.max(min, parseInt(e.target.value) || 0)))}
          className="w-12 rounded bg-interactive px-1 py-0.5 text-center text-xs text-foreground outline-none tabular-nums"
          min={min}
          max={max}
        />
        <span className="text-xs text-muted-foreground">{suffix}</span>
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        >
          <Icon name="add" className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}
