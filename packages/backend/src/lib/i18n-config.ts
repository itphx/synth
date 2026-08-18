import { pickLocalized } from '@itphx/synth-shared';

export type Lang = 'en' | 'ru';

let _defaultLang: Lang = (process.env.SYNTH_DEFAULT_LANGUAGE?.slice(0, 2) === 'en' ? 'en' : 'ru');

export function getDefaultLang(): Lang {
  return _defaultLang;
}

export function setDefaultLang(lang: Lang): void {
  _defaultLang = lang;
}

export function resolveDisplayName(record: Record<string, string>, override?: string | null): string {
  if (override != null) return override;
  return pickLocalized(record, getDefaultLang()) || '';
}

export function resolveDescription(record: Record<string, string>, override?: string | null): string | undefined {
  if (override != null) return override;
  return pickLocalized(record, getDefaultLang()) || undefined;
}
