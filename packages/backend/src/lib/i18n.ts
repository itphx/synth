import type { Context } from 'hono';

type Locale = 'en' | 'ru';
type Dictionary = Record<string, string>;

const en: Dictionary = {
  // Not found errors
  'errors.notFound.session': 'Session not found',
  'errors.notFound.project': 'Project not found',
  'errors.notFound.provider': 'Provider not found',
  'errors.notFound.model': 'Model not found',
  'errors.notFound.agent': 'Agent not found',
  'errors.notFound.message': 'Message not found',
  'errors.notFound.user': 'User not found',
  'errors.notFound.file': 'File not found',
  'errors.notFound.favicon': 'Favicon not found',
  'errors.notFound.route': 'Not found: {method} {path}',
  'errors.notFound.agentOverride': 'Override not found',

  // Validation errors
  'errors.validation.contentRequired': 'content is required',
  'errors.validation.nameRequired': 'name is required',
  'errors.validation.idRequired': 'id is required',
  'errors.validation.urlRequired': 'url is required',
  'errors.validation.invalidUrl': 'Invalid URL',
  'errors.validation.apiKeyRequired': 'api_key is required',
  'errors.validation.usernameRequired': 'username is required',
  'errors.validation.groupsRequired': 'groups is required',
  'errors.validation.expectedFilesArray': 'expected { files: string[] }',

  // Conflict errors
  'errors.conflict.usernameExists': 'A user with this username already exists',
  'errors.conflict.emailExists': 'A user with this email already exists',
  'errors.conflict.usernameTaken': 'Username is taken',
  'errors.conflict.emailTaken': 'Email is taken',

  // Other errors
  'errors.providerDisabled': 'Provider is disabled',
  'errors.connectionError': 'Connection error',
  'errors.faviconFetchError': 'Error fetching favicon',
  'errors.generic': 'Error',

  // Auth
  'auth.unauthorized': 'Authentication required',
  'auth.forbidden': 'Access denied',
  'auth.invalidApiKey': 'Invalid API key',

  // Locales
  'locales.ru.nativeName': 'Russian',

  // Stub
  'stub.llmNotConnected': '[Stub] You said: "{content}". LLM engine is not connected yet.',
};

const ru: Dictionary = {
  // Not found errors
  'errors.notFound.session': 'Сессия не найдена',
  'errors.notFound.project': 'Проект не найден',
  'errors.notFound.provider': 'Провайдер не найден',
  'errors.notFound.model': 'Модель не найдена',
  'errors.notFound.agent': 'Агент не найден',
  'errors.notFound.message': 'Сообщение не найдено',
  'errors.notFound.user': 'Пользователь не найден',
  'errors.notFound.file': 'Файл не найден',
  'errors.notFound.favicon': 'Favicon не найден',
  'errors.notFound.route': 'Не найдено: {method} {path}',
  'errors.notFound.agentOverride': 'Override не найден',

  // Validation errors
  'errors.validation.contentRequired': 'content обязателен',
  'errors.validation.nameRequired': 'name обязателен',
  'errors.validation.idRequired': 'id обязателен',
  'errors.validation.urlRequired': 'URL не указан',
  'errors.validation.invalidUrl': 'Некорректный URL',
  'errors.validation.apiKeyRequired': 'api_key обязателен',
  'errors.validation.usernameRequired': 'username обязателен',
  'errors.validation.groupsRequired': 'groups обязательны',
  'errors.validation.expectedFilesArray': 'expected { files: string[] }',

  // Conflict errors
  'errors.conflict.usernameExists': 'Пользователь с таким именем уже существует',
  'errors.conflict.emailExists': 'Пользователь с таким email уже существует',
  'errors.conflict.usernameTaken': 'Имя занято',
  'errors.conflict.emailTaken': 'Email занят',

  // Other errors
  'errors.providerDisabled': 'Провайдер отключён',
  'errors.connectionError': 'Ошибка подключения',
  'errors.faviconFetchError': 'Ошибка получения favicon',
  'errors.generic': 'Ошибка',

  // Auth
  'auth.unauthorized': 'Требуется аутентификация',
  'auth.forbidden': 'Доступ запрещён',
  'auth.invalidApiKey': 'Неверный API-ключ',

  // Locales
  'locales.ru.nativeName': 'Русский',

  // Stub
  'stub.llmNotConnected': '[Заглушка] Вы сказали: "{content}". LLM-движок ещё не подключён.',
};

const dictionaries: Record<Locale, Dictionary> = { en, ru };

function resolveLocale(c?: Context): Locale {
  if (!c) return 'ru';
  const header = c.req.header('Accept-Language');
  if (header) {
    const first = header.split(',')[0]?.trim().slice(0, 2);
    if (first === 'en') return 'en';
  }
  return 'ru';
}

function formatMessage(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const val = params[key];
    return val !== undefined ? String(val) : `{${key}}`;
  });
}

export function t(key: string, params?: Record<string, string | number>, c?: Context): string {
  const locale = resolveLocale(c);
  const dict = dictionaries[locale];
  const template = dict[key];
  if (!template) {
    // Fallback: try English, then return key
    const enTemplate = dictionaries.en[key];
    return formatMessage(enTemplate || key, params);
  }
  return formatMessage(template, params);
}

export function getLocale(c?: Context): Locale {
  return resolveLocale(c);
}

export function getTranslations(locale: Locale): Dictionary {
  return { ...dictionaries[locale] };
}
