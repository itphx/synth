import React, {
  useEffect,
  useMemo,
  useCallback,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import type { Theme, ThemeMode } from '@/types/theme';
import type { DesktopSettings } from '@/lib/desktop';
import { isDesktopLocalOriginActive, isTauriShell, isVSCodeRuntime } from '@/lib/desktop';
import { isHuaweiBrowser } from '@/lib/device';
import { setDesktopWindowTheme } from '@/lib/desktopNative';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  themes,
  getThemeById,
  getDefaultTheme,
} from '@/lib/theme/themes';
import { ThemeSystemContext, type ThemeContextValue } from './theme-system-context';
import { useUIStore } from '@/stores/useUIStore';

type ThemePreferences = {
  themeMode: ThemeMode;
  theme: string;
  lightThemeId: string;
  darkThemeId: string;
};

type ThemeSyncPayload = {
  themeMode?: unknown;
  theme?: unknown;
  lightThemeId?: unknown;
  darkThemeId?: unknown;
};

const DEFAULT_THEME_ID = 'flexoki'
const DEFAULT_LIGHT_ID = `${DEFAULT_THEME_ID}-light`
const DEFAULT_DARK_ID = `${DEFAULT_THEME_ID}-dark`

function deriveThemeIds(themeName: string): { lightThemeId: string; darkThemeId: string } {
  return {
    lightThemeId: `${themeName}-light`,
    darkThemeId: `${themeName}-dark`,
  }
}

function readStorePrefs(): { theme: string; themeMode: ThemeMode } | null {
  try {
    const state = useUIStore.getState()
    return { theme: state.theme, themeMode: state.themeMode }
  } catch {
    return null
  }
}

const getSystemPreference = (): boolean => {
  if (typeof window === 'undefined') {
    return true;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const fallbackThemeForVariant = (variant: 'light' | 'dark'): Theme =>
  getDefaultTheme(variant === 'dark');

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

const suppressTransitionsForThemeSwitch = () => {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  root.classList.add('oc-theme-switching');

  const frame = window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      root.classList.remove('oc-theme-switching');
    });
  });

  return () => {
    window.cancelAnimationFrame(frame);
    root.classList.remove('oc-theme-switching');
  };
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const getNested = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), value);

const isValidCustomTheme = (value: unknown): value is Theme => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const requiredPaths = [
    ['metadata', 'id'],
    ['metadata', 'name'],
    ['metadata', 'variant'],
    ['colors', 'primary', 'base'],
    ['colors', 'primary', 'foreground'],
    ['colors', 'surface', 'background'],
    ['colors', 'surface', 'foreground'],
    ['colors', 'surface', 'muted'],
    ['colors', 'surface', 'mutedForeground'],
    ['colors', 'surface', 'elevated'],
    ['colors', 'surface', 'elevatedForeground'],
    ['colors', 'surface', 'subtle'],
    ['colors', 'interactive', 'border'],
    ['colors', 'interactive', 'selection'],
    ['colors', 'interactive', 'selectionForeground'],
    ['colors', 'interactive', 'focusRing'],
    ['colors', 'interactive', 'hover'],
    ['colors', 'status', 'error'],
    ['colors', 'status', 'errorForeground'],
    ['colors', 'status', 'errorBackground'],
    ['colors', 'status', 'errorBorder'],
    ['colors', 'status', 'warning'],
    ['colors', 'status', 'warningForeground'],
    ['colors', 'status', 'warningBackground'],
    ['colors', 'status', 'warningBorder'],
    ['colors', 'status', 'success'],
    ['colors', 'status', 'successForeground'],
    ['colors', 'status', 'successBackground'],
    ['colors', 'status', 'successBorder'],
    ['colors', 'status', 'info'],
    ['colors', 'status', 'infoForeground'],
    ['colors', 'status', 'infoBackground'],
    ['colors', 'status', 'infoBorder'],
    ['colors', 'syntax', 'base', 'background'],
    ['colors', 'syntax', 'base', 'foreground'],
    ['colors', 'syntax', 'base', 'keyword'],
    ['colors', 'syntax', 'base', 'string'],
    ['colors', 'syntax', 'base', 'number'],
    ['colors', 'syntax', 'base', 'function'],
    ['colors', 'syntax', 'base', 'variable'],
    ['colors', 'syntax', 'base', 'type'],
    ['colors', 'syntax', 'base', 'comment'],
    ['colors', 'syntax', 'base', 'operator'],
    ['colors', 'syntax', 'highlights', 'diffAdded'],
    ['colors', 'syntax', 'highlights', 'diffRemoved'],
    ['colors', 'syntax', 'highlights', 'lineNumber'],
  ];

  for (const path of requiredPaths) {
    if (!isNonEmptyString(getNested(value, path))) {
      return false;
    }
  }

  const variant = getNested(value, ['metadata', 'variant']);
  return variant === 'light' || variant === 'dark';
};

const buildInitialPreferences = (defaultThemeName?: string): ThemePreferences => {
  let theme: string = DEFAULT_THEME_ID
  let lightThemeId: string = DEFAULT_LIGHT_ID
  let darkThemeId: string = DEFAULT_DARK_ID
  let themeMode: ThemeMode = 'system'

  const storePrefs = readStorePrefs()
  if (storePrefs) {
    theme = storePrefs.theme
    themeMode = storePrefs.themeMode
    const derived = deriveThemeIds(theme)
    lightThemeId = derived.lightThemeId
    darkThemeId = derived.darkThemeId
  } else if (typeof window !== 'undefined') {
    const storedMode = localStorage.getItem('themeMode')
    const storedTheme = localStorage.getItem('theme')
    const legacyUseSystem = localStorage.getItem('useSystemTheme')
    const legacyThemeId = localStorage.getItem('selectedThemeId')
    const legacyVariant = localStorage.getItem('selectedThemeVariant')

    if (storedMode === 'light' || storedMode === 'dark' || storedMode === 'system') {
      themeMode = storedMode
    } else if (legacyUseSystem !== null) {
      const useSystem = legacyUseSystem === 'true'
      if (useSystem) {
        themeMode = 'system'
      } else if (legacyThemeId) {
        const legacyTheme = getThemeById(legacyThemeId)
        if (legacyTheme) {
          themeMode = legacyTheme.metadata.variant === 'dark' ? 'dark' : 'light'
        }
      }
    } else if (legacyVariant === 'light' || legacyVariant === 'dark') {
      themeMode = legacyVariant
    }

    if (typeof storedTheme === 'string' && storedTheme.trim().length > 0) {
      theme = storedTheme.trim()
      const derived = deriveThemeIds(theme)
      lightThemeId = derived.lightThemeId
      darkThemeId = derived.darkThemeId
    }
  }

  if (defaultThemeName) {
    theme = defaultThemeName
    const derived = deriveThemeIds(theme)
    lightThemeId = derived.lightThemeId
    darkThemeId = derived.darkThemeId
  }

  return {
    themeMode,
    theme,
    lightThemeId,
    darkThemeId,
  }
}

interface ThemeSystemProviderProps {
  children: React.ReactNode;
  defaultThemeId?: string;
}

export function ThemeSystemProvider({ children, defaultThemeId }: ThemeSystemProviderProps) {
  const cssGenerator = useMemo(() => new CSSVariableGenerator(), []);
  const [preferences, setPreferences] = useState<ThemePreferences>(() => buildInitialPreferences(defaultThemeId));
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => getSystemPreference());
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [customThemesLoading, setCustomThemesLoading] = useState(false);
  const [vscodeTheme, setVSCodeTheme] = useState<Theme | null>(() => {
    if (typeof window === 'undefined' || !isVSCodeRuntime()) {
      return null;
    }
    const existing = (window as unknown as { __SYNTH_VSCODE_THEME__?: Theme }).__SYNTH_VSCODE_THEME__;
    return existing || null;
  });
  const isVSCode = useMemo(() => isVSCodeRuntime(), []);
  const isLocalDesktopOrigin = useMemo(() => isDesktopLocalOriginActive(), []);
  const isDesktopShell = useMemo(() => isTauriShell(), []);

  const availableThemes = useMemo(() => {
    const merged: Theme[] = [];
    const seen = new Set<string>();

    const add = (theme: Theme) => {
      const id = theme.metadata.id;
      if (seen.has(id)) return;
      seen.add(id);
      merged.push(theme);
    };

    if (isVSCode && vscodeTheme) {
      add(vscodeTheme);
    }

    // Custom themes first so they can override built-ins with the same id.
    customThemes.forEach(add);
    themes.forEach(add);

    return merged;
  }, [customThemes, isVSCode, vscodeTheme]);

  const getThemeByIdFromAvailable = useCallback(
    (themeId: string): Theme | undefined => availableThemes.find((theme) => theme.metadata.id === themeId),
    [availableThemes],
  );

  const ensureThemeById = useCallback(
    (themeId: string, variant: 'light' | 'dark'): Theme => {
      const theme = getThemeByIdFromAvailable(themeId);
      if (theme && theme.metadata.variant === variant) {
        return theme;
      }

      const fallback = availableThemes.find((candidate) => candidate.metadata.variant === variant);
      return fallback ?? fallbackThemeForVariant(variant);
    },
    [availableThemes, getThemeByIdFromAvailable],
  );

  const currentTheme = useMemo(() => {
    if (isVSCode && vscodeTheme) {
      return vscodeTheme;
    }
    if (preferences.themeMode === 'light') {
      return ensureThemeById(preferences.lightThemeId, 'light');
    }
    if (preferences.themeMode === 'dark') {
      return ensureThemeById(preferences.darkThemeId, 'dark');
    }
    return systemPrefersDark
      ? ensureThemeById(preferences.darkThemeId, 'dark')
      : ensureThemeById(preferences.lightThemeId, 'light');
  }, [ensureThemeById, isVSCode, preferences, systemPrefersDark, vscodeTheme]);

  useEffect(() => {
    let prevStoreTheme: string | undefined
    let prevStoreMode: ThemeMode | undefined

    const unsub = useUIStore.subscribe((state, prev) => {
      if (state.theme === prev.theme && state.themeMode === prev.themeMode) {
        return
      }
      if (state.theme === prevStoreTheme && state.themeMode === prevStoreMode) {
        return
      }
      prevStoreTheme = state.theme
      prevStoreMode = state.themeMode

      const derived = deriveThemeIds(state.theme)
      setPreferences({
        themeMode: state.themeMode,
        theme: state.theme,
        lightThemeId: derived.lightThemeId,
        darkThemeId: derived.darkThemeId,
      })
    })

    return () => unsub()
  }, [])

  const reloadCustomThemes = useCallback(async () => {
    if (typeof window === 'undefined' || isVSCode) {
      return;
    }

    setCustomThemesLoading(true);
    try {
      const res = await fetch('/api/config/themes', {
        method: 'GET',
        credentials: isLocalDesktopOrigin ? 'omit' : 'include',
        headers: {
          Accept: 'application/json',
        },
      });

      if (res.status === 401) {
        // UI auth gate will handle prompting; avoid noisy retries here.
        return;
      }

      if (!res.ok) {
        return;
      }

      const payload = await res.json();
      const incoming = Array.isArray(payload?.themes) ? payload.themes : [];
      const normalized = incoming.filter(isValidCustomTheme);
      setCustomThemes(normalized);
    } catch {
      // ignore
    } finally {
      setCustomThemesLoading(false);
    }
  }, [isLocalDesktopOrigin, isVSCode]);

  useEffect(() => {
    void reloadCustomThemes();
  }, [reloadCustomThemes]);

  useEffect(() => {
    if (!isVSCode) {
      return;
    }

    const applyVSCodeTheme = (theme: Theme) => {
      setVSCodeTheme(theme);
    };

    const handleThemeEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ theme?: Theme }>).detail;
      if (detail?.theme) {
        applyVSCodeTheme(detail.theme);
      }
    };

    const existing = (window as unknown as { __SYNTH_VSCODE_THEME__?: Theme }).__SYNTH_VSCODE_THEME__;
    if (existing) {
      applyVSCodeTheme(existing);
    }

    window.addEventListener('synth:vscode-theme', handleThemeEvent as EventListener);
    return () => window.removeEventListener('synth:vscode-theme', handleThemeEvent as EventListener);
  }, [isVSCode]);

  const updateBrowserChrome = useCallback((theme: Theme) => {
    if (typeof document === 'undefined') {
      return;
    }
    const chromeColor = theme.colors.surface.background;

    document.body.style.backgroundColor = chromeColor;

    let metaThemeColor = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement;
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.setAttribute('content', chromeColor);

    const mediaQuery =
      theme.metadata.variant === 'dark'
        ? '(prefers-color-scheme: dark)'
        : '(prefers-color-scheme: light)';
    let metaThemeColorMedia = document.querySelector(
      `meta[name="theme-color"][media="${mediaQuery}"]`,
    ) as HTMLMetaElement;
    if (!metaThemeColorMedia) {
      metaThemeColorMedia = document.createElement('meta');
      metaThemeColorMedia.setAttribute('name', 'theme-color');
      metaThemeColorMedia.setAttribute('media', mediaQuery);
      document.head.appendChild(metaThemeColorMedia);
    }
    metaThemeColorMedia.setAttribute('content', chromeColor);

    // color-scheme — зеркало темы приложения со значением only: отключает
    // принудительное авто-затемнение (Huawei EMUI Auto Dark Theme) и держит
    // нативные контролы/скроллбары в правильной схеме.
    // Huawei Browser: класс huawei выставляется pre-paint-скриптом; его ночной
    // режим игнорирует only light, поэтому объявляем страницу dark всегда —
    // сама тема приложения при этом не меняется.
    const isHuawei =
      document.documentElement.classList.contains('huawei') || isHuaweiBrowser();
    const colorScheme = isHuawei
      ? 'dark'
      : theme.metadata.variant === 'dark'
        ? 'only dark'
        : 'only light';
    let metaColorScheme = document.querySelector('meta[name="color-scheme"]') as HTMLMetaElement | null;
    if (!metaColorScheme) {
      metaColorScheme = document.createElement('meta');
      metaColorScheme.setAttribute('name', 'color-scheme');
      document.head.appendChild(metaColorScheme);
    }
    metaColorScheme.setAttribute('content', colorScheme);
  }, []);

  const applyVSCodeRuntimeClass = useCallback((enabled: boolean) => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.classList.toggle('vscode-runtime', enabled);
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const restoreTransitions = suppressTransitionsForThemeSwitch();
    cssGenerator.apply(currentTheme);
    applyVSCodeRuntimeClass(isVSCode);
    updateBrowserChrome(currentTheme);

    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(currentTheme.metadata.variant);

    return restoreTransitions;
  }, [applyVSCodeRuntimeClass, cssGenerator, currentTheme, isVSCode, updateBrowserChrome]);

  useEffect(() => {
    if (preferences.themeMode !== 'system' || typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [preferences.themeMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    localStorage.setItem('themeMode', preferences.themeMode)
    localStorage.setItem('theme', preferences.theme)
    localStorage.setItem('useSystemTheme', String(preferences.themeMode === 'system'))
    localStorage.setItem('selectedThemeId', currentTheme.metadata.id)
    localStorage.setItem(
      'selectedThemeVariant',
      currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
    )

    // Splash screen (packages/web/index.html) runs before the theme CSS vars load.
    // Persist just enough to theme it on next boot.
    const lightTheme = ensureThemeById(preferences.lightThemeId, 'light');
    const darkTheme = ensureThemeById(preferences.darkThemeId, 'dark');

    localStorage.setItem('splashBgLight', lightTheme.colors.surface.background);
    localStorage.setItem('splashFgLight', lightTheme.colors.surface.foreground);
    localStorage.setItem('splashBgDark', darkTheme.colors.surface.background);
    localStorage.setItem('splashFgDark', darkTheme.colors.surface.foreground);
  }, [preferences, currentTheme, ensureThemeById]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key !== 'themeMode' && event.key !== 'theme' && event.key !== 'lightThemeId' && event.key !== 'darkThemeId') {
        return;
      }

      setPreferences((prev) => {
        const nextModeRaw = localStorage.getItem('themeMode');
        const nextMode: ThemeMode =
          nextModeRaw === 'light' || nextModeRaw === 'dark' || nextModeRaw === 'system'
            ? nextModeRaw
            : prev.themeMode;

        const nextThemeRaw = localStorage.getItem('theme');
        let nextTheme = prev.theme;
        let nextLight = prev.lightThemeId;
        let nextDark = prev.darkThemeId;

        if (typeof nextThemeRaw === 'string' && nextThemeRaw.trim().length > 0) {
          nextTheme = nextThemeRaw.trim()
          const derived = deriveThemeIds(nextTheme)
          nextLight = derived.lightThemeId
          nextDark = derived.darkThemeId
        }

        if (nextMode === prev.themeMode && nextTheme === prev.theme) {
          return prev;
        }

        return {
          themeMode: nextMode,
          theme: nextTheme,
          lightThemeId: nextLight,
          darkThemeId: nextDark,
        };
      });
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const applyIncomingThemeSync = useCallback((payload: ThemeSyncPayload) => {
    const mode = payload.themeMode as ThemeMode | undefined
    const themeName = payload.theme as string | undefined

    if (!themeName && !mode) {
      return
    }

    suppressTransitionsForThemeSwitch()
    flushSync(() => {
      setPreferences((prev) => {
        const nextTheme = (typeof themeName === 'string' && themeName.trim().length > 0)
          ? themeName.trim()
          : prev.theme
        const derived = deriveThemeIds(nextTheme)

        if (mode !== 'light' && mode !== 'dark' && mode !== 'system') {
          // Only theme changed
          if (nextTheme === prev.theme) {
            return prev
          }
          return {
            ...prev,
            theme: nextTheme,
            lightThemeId: derived.lightThemeId,
            darkThemeId: derived.darkThemeId,
          }
        }

        // mode also changed
        if (nextTheme === prev.theme && mode === prev.themeMode) {
          return prev
        }

        return {
          themeMode: mode,
          theme: nextTheme,
          lightThemeId: derived.lightThemeId,
          darkThemeId: derived.darkThemeId,
        }
      })
    })
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const scopedWindow = window as unknown as {
      __synthApplyThemeSync?: (payload: ThemeSyncPayload) => void;
    };

    scopedWindow.__synthApplyThemeSync = applyIncomingThemeSync;

    return () => {
      if (scopedWindow.__synthApplyThemeSync === applyIncomingThemeSync) {
        delete scopedWindow.__synthApplyThemeSync;
      }
    };
  }, [applyIncomingThemeSync]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as {
        type?: unknown;
        payload?: ThemeSyncPayload;
      };

      if (data?.type !== 'synth:theme-sync' || !data.payload) {
        return;
      }

      applyIncomingThemeSync(data.payload);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [applyIncomingThemeSync]);

  useEffect(() => {
    const lightTheme = ensureThemeById(preferences.lightThemeId, 'light');
    const darkTheme = ensureThemeById(preferences.darkThemeId, 'dark');

    void updateDesktopSettings({
      themeId: currentTheme.metadata.id,
      themeVariant: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
      useSystemTheme: preferences.themeMode === 'system',
      lightThemeId: preferences.lightThemeId,
      darkThemeId: preferences.darkThemeId,
      splashBgLight: lightTheme.colors.surface.background,
      splashFgLight: lightTheme.colors.surface.foreground,
      splashBgDark: darkTheme.colors.surface.background,
      splashFgDark: darkTheme.colors.surface.foreground,
    });
  }, [currentTheme.metadata.id, currentTheme.metadata.variant, ensureThemeById, preferences.themeMode, preferences.lightThemeId, preferences.darkThemeId]);

  useEffect(() => {
    if (!isDesktopShell) {
      return;
    }

    void (async () => {
      await setDesktopWindowTheme(preferences.themeMode, currentTheme.metadata.variant);
    })();
  }, [currentTheme.metadata.variant, isDesktopShell, preferences.themeMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleSettingsSynced = (event: Event) => {
      const detail = (event as CustomEvent<DesktopSettings>).detail;
      if (!detail) {
        return;
      }

      setPreferences((prev) => {
        let nextMode = prev.themeMode;
        if (detail.useSystemTheme === true) {
          nextMode = 'system';
        } else if (detail.useSystemTheme === false) {
          if (detail.themeVariant === 'dark' || detail.themeVariant === 'light') {
            nextMode = detail.themeVariant;
          }
        }

        let nextTheme = prev.theme;
        if (typeof detail.lightThemeId === 'string' && detail.lightThemeId.length > 0) {
          nextTheme = detail.lightThemeId.replace(/-light$/, '').replace(/-dark$/, '')
        }

        const derived = deriveThemeIds(nextTheme)
        const same =
          nextMode === prev.themeMode &&
          nextTheme === prev.theme;

        if (same) {
          return prev;
        }

        return {
          themeMode: nextMode,
          theme: nextTheme,
          lightThemeId: derived.lightThemeId,
          darkThemeId: derived.darkThemeId,
        };
      });
    };

    window.addEventListener('synth:settings-synced', handleSettingsSynced);
    return () => window.removeEventListener('synth:settings-synced', handleSettingsSynced);
  }, []);

  const setTheme = useCallback(
    (themeId: string) => {
      const theme = availableThemes.find((candidate) => candidate.metadata.id === themeId)
      if (!theme) {
        return
      }

      const themeName = theme.metadata.name.toLowerCase().replace(/\s+/g, '-')
      const derived = deriveThemeIds(themeName)

      setPreferences((prev) => {
        if (prev.theme === themeName && prev.themeMode !== 'system') {
          return prev
        }
        return {
          ...prev,
          theme: themeName,
          lightThemeId: derived.lightThemeId,
          darkThemeId: derived.darkThemeId,
        }
      })
    },
    [availableThemes],
  )

  const setThemePreference = useCallback(
    (themeId: string) => {
      const theme = availableThemes.find((candidate) => candidate.metadata.id === themeId)
      if (!theme) {
        return
      }

      const themeName = theme.metadata.name.toLowerCase().replace(/\s+/g, '-')
      const derived = deriveThemeIds(themeName)

      setPreferences((prev) => {
        if (prev.theme === themeName) {
          return prev
        }
        return {
          ...prev,
          theme: themeName,
          lightThemeId: derived.lightThemeId,
          darkThemeId: derived.darkThemeId,
        }
      })
    },
    [availableThemes],
  )

  const setThemeModeHandler = useCallback((mode: ThemeMode) => {
    setPreferences((prev) => {
      if (prev.themeMode === mode) {
        return prev;
      }
      return {
        ...prev,
        themeMode: mode,
      };
    });
  }, []);

  const setSystemPreferenceHandler = useCallback(
    (use: boolean) => {
      if (use) {
        setPreferences((prev) => {
          if (prev.themeMode === 'system') {
            return prev;
          }
          return {
            ...prev,
            themeMode: 'system',
          };
        });
        return;
      }

      const fallbackMode: ThemeMode =
        currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
      setPreferences((prev) => {
        if (prev.themeMode === fallbackMode) {
          return prev;
        }
        return {
          ...prev,
          themeMode: fallbackMode,
        };
      });
    },
    [currentTheme.metadata.variant],
  );

  const value: ThemeContextValue = {
    currentTheme,
    availableThemes,
    setTheme,
    customThemesLoading,
    reloadCustomThemes,
    isSystemPreference: preferences.themeMode === 'system',
    setSystemPreference: setSystemPreferenceHandler,
    themeMode: preferences.themeMode,
    setThemeMode: setThemeModeHandler,
    theme: preferences.theme,
    setThemePreference,
  };

  return (
    <ThemeSystemContext.Provider value={value}>
      {children}
    </ThemeSystemContext.Provider>
  );
}
