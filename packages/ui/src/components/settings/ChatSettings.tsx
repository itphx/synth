import { useEffect, useMemo, useRef, useState } from 'react'
import { useUIStore, type ChatDensity, type ChatViewMode } from "../../stores/useUIStore"
import { useI18n } from "@/lib/i18n"
import { profileService } from '@/lib/api/profileService'
import { CHAT_SCALE_DEFAULT, applyChatScale, normalizeChatScale } from '@/lib/uiScale'
import {
  SegmentedControl,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  SettingsItem,
  useSettingsDraft,
  type SegmentedControlOption,
} from '../ui/settings'
import { ChatScaleControl } from './UiScaleControl'

type IntermediateTextDisplay = 'inline' | 'bottom'

/** Черновик панели «Чат»: все настройки сохраняются одной кнопкой Save. */
interface ChatSettingsDraft {
  chatViewMode: ChatViewMode
  intermediateTextDisplay: IntermediateTextDisplay
  chatDensity: ChatDensity
  /** Масштаб области чата (множитель поверх общего масштаба UI). */
  chatScale: number
}

const CHAT_SETTINGS_DEFAULTS: ChatSettingsDraft = {
  chatViewMode: 'detailed',
  intermediateTextDisplay: 'inline',
  chatDensity: 'normal',
  chatScale: CHAT_SCALE_DEFAULT,
}

export const ChatSettings = () => {
  const { t } = useI18n()
  const chatViewMode = useUIStore((s) => s.chatViewMode)
  const setChatViewMode = useUIStore((s) => s.setChatViewMode)
  const intermediateTextDisplay = useUIStore((s) => s.intermediateTextDisplay)
  const setIntermediateTextDisplay = useUIStore((s) => s.setIntermediateTextDisplay)
  const chatDensity = useUIStore((s) => s.chatDensity)
  const setChatDensity = useUIStore((s) => s.setChatDensity)
  const chatScale = useUIStore((s) => s.chatScale)
  const setChatScale = useUIStore((s) => s.setChatScale)

  // Сохранённый масштаб на момент открытия панели: к нему откатываются
  // Cancel и закрытие окна (live-preview масштаба не персистится).
  // Черновик сравнивается именно с ним, а не со стором: предпросмотр пишет
  // значение в `useUIStore`, иначе Save/Cancel сразу становились бы неактивны.
  const [savedChatScale, setSavedChatScale] = useState(chatScale)
  const savedChatScaleRef = useRef(savedChatScale)

  // Объект значения мемоизирован: `useSettingsDraft` синхронизирует черновик по
  // идентичности `value`, новая ссылка на каждом рендере зациклила бы эффект.
  const value = useMemo<ChatSettingsDraft>(
    () => ({
      chatViewMode: chatViewMode === 'feed' ? 'feed' : 'detailed',
      intermediateTextDisplay: intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline',
      chatDensity: chatDensity === 'compact' ? 'compact' : 'normal',
      chatScale: normalizeChatScale(savedChatScale),
    }),
    [chatViewMode, intermediateTextDisplay, chatDensity, savedChatScale],
  )

  // ADR-072 (фидбек): без автосохранения — выбор меняет черновик, стор
  // обновляется и персистится только по кнопке Save.
  const draft = useSettingsDraft<ChatSettingsDraft>({
    value,
    defaultValue: CHAT_SETTINGS_DEFAULTS,
    onSave: async (next) => {
      const viewMode: ChatViewMode = next.chatViewMode === 'feed' ? 'feed' : 'detailed'
      const display: IntermediateTextDisplay =
        next.intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline'
      const density: ChatDensity = next.chatDensity === 'compact' ? 'compact' : 'normal'
      const scale = normalizeChatScale(next.chatScale)
      setChatViewMode(viewMode)
      setIntermediateTextDisplay(display)
      setChatDensity(density)
      // `setChatScale` применяет `--chat-scale`, пишет localStorage и стор.
      setChatScale(scale)
      setSavedChatScale(scale)
      savedChatScaleRef.current = scale
      // Личный выбор уезжает в профиль (managed, best-effort): ошибки глушит
      // `profileService.syncToProfile`, локальный persist не затрагивается.
      void profileService.syncChatViewModeToProfile(viewMode)
      void profileService.syncChatDensityToProfile(density)
      void profileService.syncChatScaleToProfile(scale)
      return { ...next, chatScale: scale }
    },
  })

  // Размонтирование без Save (= закрытие окна) откатывает предпросмотр масштаба.
  useEffect(() => () => {
    const restored = savedChatScaleRef.current
    applyChatScale(restored)
    useUIStore.setState({ chatScale: restored })
  }, [])

  const current: ChatSettingsDraft = draft.draft ?? CHAT_SETTINGS_DEFAULTS
  const viewMode: ChatViewMode = current.chatViewMode === 'feed' ? 'feed' : 'detailed'
  const display: IntermediateTextDisplay =
    current.intermediateTextDisplay === 'bottom' ? 'bottom' : 'inline'
  const density: ChatDensity = current.chatDensity === 'compact' ? 'compact' : 'normal'

  const handleChatScaleChange = (value: number) => {
    const scale = normalizeChatScale(value)
    draft.update({ chatScale: scale })
    // Live-preview: меняется только лента сообщений, общий масштаб не трогаем.
    applyChatScale(scale)
    useUIStore.setState({ chatScale: scale })
  }

  const handleCancel = () => {
    draft.revert()
    const restored = savedChatScaleRef.current
    applyChatScale(restored)
    useUIStore.setState({ chatScale: restored })
  }

  const handleReset = () => {
    draft.resetToDefault()
    applyChatScale(CHAT_SCALE_DEFAULT)
    useUIStore.setState({ chatScale: CHAT_SCALE_DEFAULT })
  }

  const viewModeOptions: SegmentedControlOption<ChatViewMode>[] = [
    { value: 'detailed', label: t('chatSettings.viewModeDetailed') },
    { value: 'feed', label: t('chatSettings.viewModeFeed') },
  ]
  const options: SegmentedControlOption<IntermediateTextDisplay>[] = [
    { value: 'inline', label: t('chatSettings.intermediateTextInline') },
    { value: 'bottom', label: t('chatSettings.intermediateTextBottom') },
  ]
  const densityOptions: SegmentedControlOption<ChatDensity>[] = [
    { value: 'normal', label: t('chatSettings.densityNormal') },
    { value: 'compact', label: t('chatSettings.densityCompact') },
  ]

  return (
    <SettingsPanel
      title={t('settings.category.chat')}
      description={t('chatSettings.description')}
    >
      {/* Вид важнее плотности — первой секцией панели. */}
      <SettingsSection
        id="chat-view-mode"
        title={t('chatSettings.viewMode')}
        description={t('chatSettings.viewModeDescription')}
      >
        <SettingsItem>
          <SegmentedControl<ChatViewMode>
            value={viewMode}
            options={viewModeOptions}
            onChange={(value) => draft.update({ chatViewMode: value })}
            ariaLabel={t('chatSettings.viewMode')}
          />
        </SettingsItem>
      </SettingsSection>

      <SettingsSection
        id="chat-density"
        title={t('chatSettings.density')}
        description={t('chatSettings.densityDescription')}
      >
        <SettingsItem>
          <SegmentedControl<ChatDensity>
            value={density}
            options={densityOptions}
            onChange={(value) => draft.update({ chatDensity: value })}
            ariaLabel={t('chatSettings.density')}
          />
        </SettingsItem>
      </SettingsSection>

      <SettingsSection
        id="chat-scale"
        title={t('chatSettings.chatScale.label')}
        tooltip={t('settings.help.chat.section.chat-scale')}
      >
        <SettingsItem>
          <ChatScaleControl value={current.chatScale} onChange={handleChatScaleChange} />
        </SettingsItem>
      </SettingsSection>

      <SettingsSection
        id="chat-intermediate-text"
        title={t('chatSettings.intermediateTextDisplay')}
      >
        <SettingsItem>
          <SegmentedControl<IntermediateTextDisplay>
            value={display}
            options={options}
            onChange={(value) => draft.update({ intermediateTextDisplay: value })}
            ariaLabel={t('chatSettings.intermediateTextDisplay')}
          />
        </SettingsItem>
      </SettingsSection>

      <SettingsActions
        align="start"
        onSave={() => void draft.save()}
        onCancel={handleCancel}
        onReset={handleReset}
        saving={draft.saving}
        saveDisabled={!draft.dirty}
        cancelDisabled={!draft.dirty}
        isDefault={draft.isDefault}
        saveTestId="chat-save"
        cancelTestId="chat-cancel"
        resetTestId="chat-reset"
      />
    </SettingsPanel>
  )
}
