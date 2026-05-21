export type ThemeMode = 'system' | 'light' | 'dark'
export type Locale = 'ru' | 'en'

export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' },
]

export { DEFAULT_LIGHT_THEME_ID, DEFAULT_DARK_THEME_ID, THEME_PRESETS } from './themes/index'
export { themes, getThemeById, getDefaultTheme, type ThemePreset } from './themes/index'
export type { Theme } from '@/types/theme'