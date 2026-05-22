import type { Theme } from '@/types/theme';
import { presetThemes } from './presets';
import { withPrColors } from './prColors';
import flexokiLightRaw from './flexoki-light.json';
import flexokiDarkRaw from './flexoki-dark.json';
import synthLightRaw from './fields-of-the-shire-light.json';
import synthDarkRaw from './fields-of-the-shire-dark.json';

export const flexokiLightTheme = withPrColors(flexokiLightRaw as Theme);
export const flexokiDarkTheme = withPrColors(flexokiDarkRaw as Theme);
export const synthLightTheme = withPrColors(synthLightRaw as Theme);
export const synthDarkTheme = withPrColors(synthDarkRaw as Theme);

export const DEFAULT_LIGHT_THEME_ID = 'flexoki-light' as const;
export const DEFAULT_DARK_THEME_ID = 'flexoki-dark' as const;

export const themes: Theme[] = [
  synthLightTheme,
  synthDarkTheme,
  flexokiLightTheme,
  flexokiDarkTheme,
  ...presetThemes.filter(
    (theme) => theme.metadata.id !== 'synth-light' && theme.metadata.id !== 'synth-dark',
  ),
];

export function getThemeById(id: string): Theme | undefined {
  const resolvedId =
    id === 'app-light' ? 'flexoki-light' :
    id === 'app-dark' ? 'flexoki-dark' :
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

  return themes.find((theme) => theme.metadata.variant === variant) ?? themes[0] ?? flexokiLightTheme;
}

export type ThemePreset = {
  name: string
  lightId: string | null
  darkId: string | null
}

export function getThemePresets(): ThemePreset[] {
  const grouped = new Map<string, { light?: Theme; dark?: Theme }>()

  for (const theme of themes) {
    const name = theme.metadata.name
    const existing = grouped.get(name) ?? {}
    if (theme.metadata.variant === 'light') {
      existing.light = theme
    } else {
      existing.dark = theme
    }
    grouped.set(name, existing)
  }

  const presets: ThemePreset[] = []
  for (const [name, { light, dark }] of grouped) {
    presets.push({
      name,
      lightId: light?.metadata.id ?? null,
      darkId: dark?.metadata.id ?? null,
    })
  }

  return presets.sort((a, b) => a.name.localeCompare(b.name))
}

export const THEME_PRESETS = getThemePresets()