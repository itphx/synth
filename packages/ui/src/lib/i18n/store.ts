import { create } from 'zustand';

import { dict as enDict } from './messages/en';
import { pluralCategory, type PluralCategory } from './plural';
import { DEFAULT_LOCALE, type Locale, writeStoredLocale, detectInitialLocale } from './runtime';

export type I18nParams = Record<string, string | number | boolean | null | undefined>;
export type I18nKey = string;
export type I18nDictionary = Record<I18nKey, string>;

type I18nState = {
  locale: Locale;
  dictionary: I18nDictionary;
  loadingLocale: Locale | null;
  setLocale: (locale: Locale) => void;
};

const dictionaries = new Map<Locale, I18nDictionary>([['en', enDict]]);

async function loadDictionary(locale: Locale): Promise<I18nDictionary> {
  const cached = dictionaries.get(locale);
  if (cached) {
    return cached;
  }

  const mod = locale === 'ru'
    ? await import('./messages/ru') as { dict: I18nDictionary }
    : { dict: enDict };
  dictionaries.set(locale, mod.dict);
  return mod.dict;
}

export const useI18nStore = create<I18nState>()((set, get) => ({
  locale: DEFAULT_LOCALE,
  dictionary: enDict,
  loadingLocale: null,
  setLocale: (locale) => {
    const current = get();
    const cached = dictionaries.get(locale);
    if (current.locale === locale && current.loadingLocale !== locale && cached) {
      return;
    }

    writeStoredLocale(locale);

    set({
      locale,
      dictionary: cached ?? current.dictionary,
      loadingLocale: cached ? null : locale,
    });

    if (cached) {
      return;
    }

    void loadDictionary(locale).then((dictionary) => {
      if (get().locale !== locale) {
        return;
      }
      set({ dictionary, loadingLocale: null });
    }).catch((error) => {
      console.error(`[i18n] failed to load locale ${locale}`, error);
      if (get().locale === locale) {
        set({ dictionary: enDict, loadingLocale: null });
      }
    });
  },
}));

export function initializeLocale(): void {
  const locale = detectInitialLocale();
  useI18nStore.getState().setLocale(locale);
}

/** Порядок fallback, если нужной категории нет в шаблоне. */
const PLURAL_FALLBACK_ORDER: PluralCategory[] = ['other', 'many', 'one', 'few', 'zero', 'two'];

type ParamNode = { kind: 'param'; name: string };
type PluralNode = {
  kind: 'plural';
  name: string;
  forms: Partial<Record<PluralCategory, string>>;
};

/** Индекс закрывающей `}` для блока, начинающегося с `{` на позиции start. */
function findBalancedEnd(template: string, start: number): number {
  let depth = 0;
  for (let i = start; i < template.length; i++) {
    const ch = template[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Индекс первого символа char на нулевом уровне вложенности `{}`. */
function indexOfTopLevel(text: string, char: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    } else if (ch === char && depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Разбирает часть после `name, plural,` в набор форм `{ category {...} ... }`. */
function parsePluralForms(text: string): Partial<Record<PluralCategory, string>> | null {
  const forms: Partial<Record<PluralCategory, string>> = {};
  let i = 0;

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) {
      i++;
    }
    if (i >= text.length) {
      break;
    }

    let word = '';
    while (i < text.length && /[a-zA-Z_]/.test(text[i]!)) {
      word += text[i];
      i++;
    }
    if (!word) {
      return null;
    }

    while (i < text.length && /\s/.test(text[i]!)) {
      i++;
    }
    if (text[i] !== '{') {
      return null;
    }

    const end = findBalancedEnd(text, i);
    if (end === -1) {
      return null;
    }

    forms[word as PluralCategory] = text.slice(i + 1, end);
    i = end + 1;
  }

  return forms;
}

/** Разбирает содержимое `{...}`: плейсхолдер `{name}` или plural-блок. */
function parsePlaceholder(inner: string): ParamNode | PluralNode {
  const firstComma = indexOfTopLevel(inner, ',');
  if (firstComma !== -1) {
    const name = inner.slice(0, firstComma).trim();
    const rest = inner.slice(firstComma + 1);
    const secondComma = indexOfTopLevel(rest, ',');
    if (name && secondComma !== -1) {
      const keyword = rest.slice(0, secondComma).trim();
      if (keyword === 'plural') {
        const forms = parsePluralForms(rest.slice(secondComma + 1));
        if (forms) {
          return { kind: 'plural', name, forms };
        }
      }
    }
  }

  return { kind: 'param', name: inner.trim() };
}

function selectPluralForm(
  forms: Partial<Record<PluralCategory, string>>,
  category: PluralCategory,
): string {
  const direct = forms[category];
  if (direct !== undefined) {
    return direct;
  }
  for (const fallback of PLURAL_FALLBACK_ORDER) {
    const form = forms[fallback];
    if (form !== undefined) {
      return form;
    }
  }
  return '';
}

/**
 * Рекурсивный рендер шаблона: `{name}` — интерполяция; `{name, plural, ...}` —
 * выбор формы по pluralCategory; `#` внутри выбранной формы — число.
 * Неизвестный плейсхолдер остаётся как есть (как раньше).
 */
function renderTemplate(
  template: string,
  params: I18nParams,
  locale: Locale,
  hashValue?: string,
): string {
  let out = '';
  let i = 0;

  while (i < template.length) {
    const ch = template[i]!;

    if (ch === '{') {
      const end = findBalancedEnd(template, i);
      if (end === -1) {
        out += ch;
        i++;
        continue;
      }

      const inner = template.slice(i + 1, end);
      const placeholder = template.slice(i, end + 1);
      const node = parsePlaceholder(inner);

      if (node.kind === 'plural') {
        const raw = params[node.name];
        if (raw === null || raw === undefined) {
          // Параметра нет — оставляем блок как есть (как для `{name}`).
          out += placeholder;
        } else {
          const category = pluralCategory(locale, Number(raw));
          const form = selectPluralForm(node.forms, category);
          out += renderTemplate(form, params, locale, String(raw));
        }
      } else {
        const value = params[node.name];
        out += value === null || value === undefined ? placeholder : String(value);
      }

      i = end + 1;
      continue;
    }

    if (ch === '#' && hashValue !== undefined) {
      out += hashValue;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

export function formatMessage(
  dictionary: I18nDictionary,
  key: I18nKey,
  params?: I18nParams,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const template = dictionary[key] ?? enDict[key as keyof typeof enDict] ?? key;
  if (!params) {
    return template;
  }

  return renderTemplate(template, params, locale);
}