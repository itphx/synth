import type { Theme } from '@/types/theme';
import { presetThemes } from './presets';

export const DEFAULT_LIGHT_THEME_ID = 'synthesis-light';
export const DEFAULT_DARK_THEME_ID = 'synthesis-dark';

export const themes: Theme[] = presetThemes;

/** id записи темы без суффикса варианта: `nightowl-dark` → `nightowl`. */
export function themePrefixFromId(id: string): string {
  return id.replace(/-(light|dark)$/, '');
}

export function getThemeById(id: string): Theme | undefined {
  const resolvedId =
    id === 'app-light' ? DEFAULT_LIGHT_THEME_ID :
    id === 'app-dark' ? DEFAULT_DARK_THEME_ID :
    id;

  return themes.find(theme => theme.metadata.id === resolvedId);
}

export function getDefaultTheme(prefersDark: boolean): Theme {
  const variant: Theme['metadata']['variant'] = prefersDark ? 'dark' : 'light';

  const defaultId = prefersDark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
  const defaultTheme = getThemeById(defaultId);
  if (defaultTheme && defaultTheme.metadata.variant === variant) {
    return defaultTheme;
  }

  return themes.find((theme) => theme.metadata.variant === variant) ?? themes[0];
}

export type ThemePreset = {
  /** Префикс id темы без `-light`/`-dark` (например `nightowl`). */
  id: string
  /** Человекочитаемое имя для отображения. */
  name: string
  lightId: string | null
  darkId: string | null
}

export function getThemePresets(): ThemePreset[] {
  const grouped = new Map<string, { light?: Theme; dark?: Theme; name?: string }>()

  for (const theme of themes) {
    const id = themePrefixFromId(theme.metadata.id)
    const existing = grouped.get(id) ?? {}
    if (theme.metadata.variant === 'light') {
      existing.light = theme
    } else {
      existing.dark = theme
    }
    existing.name = existing.name ?? theme.metadata.name
    grouped.set(id, existing)
  }

  const presets: ThemePreset[] = []
  for (const [id, { light, dark, name }] of grouped) {
    presets.push({
      id,
      name: name ?? id,
      lightId: light?.metadata.id ?? null,
      darkId: dark?.metadata.id ?? null,
    })
  }

  return presets.sort((a, b) => a.name.localeCompare(b.name))
}

export const THEME_PRESETS = getThemePresets()
