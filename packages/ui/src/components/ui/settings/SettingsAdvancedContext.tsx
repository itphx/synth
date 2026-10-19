import React from 'react'

export interface SettingsAdvancedContextValue {
  /** Видны ли сейчас продвинутые секции (глобальный режим или локальное раскрытие). */
  visible: boolean
  /**
   * Регистрирует продвинутую секцию и возвращает функцию отмены регистрации.
   * Счётчик нужен `SettingsPanel`, чтобы показать «Показать дополнительные (N)».
   */
  registerAdvanced: () => () => void
}

const SettingsAdvancedContext = React.createContext<SettingsAdvancedContextValue>({
  // Вне панели (и в тестах секций) ничего не скрываем.
  visible: true,
  registerAdvanced: () => () => {},
})

export interface SettingsAdvancedProviderProps {
  value: SettingsAdvancedContextValue
  children: React.ReactNode
}

export function SettingsAdvancedProvider({ value, children }: SettingsAdvancedProviderProps) {
  return (
    <SettingsAdvancedContext.Provider value={value}>
      {children}
    </SettingsAdvancedContext.Provider>
  )
}

export function useSettingsAdvanced(): SettingsAdvancedContextValue {
  return React.useContext(SettingsAdvancedContext)
}
