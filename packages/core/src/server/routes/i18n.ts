import { Hono } from 'hono';

const TRANSLATIONS: Record<string, Record<string, string>> = {
  ru: {
    'app.title': 'Synth',
    'app.description': 'Персональный AI-ассистент',
    'nav.sessions': 'Сессии',
    'nav.projects': 'Проекты',
    'nav.settings': 'Настройки',
    'chat.placeholder': 'Введите сообщение...',
    'chat.send': 'Отправить',
    'chat.cancel': 'Отменить',
    'chat.newSession': 'Новая сессия',
    'chat.agentHint': 'Роль агента',
    'chat.providerHint': 'Провайдер',
    'chat.modelHint': 'Модель',
    'auth.login': 'Войти',
    'auth.logout': 'Выйти',
    'auth.apiKey': 'API-ключ',
    'auth.apiKeyHint': 'Введите ваш API-ключ',
    'errors.notFound.session': 'Сессия не найдена',
    'errors.notFound.project': 'Проект не найден',
    'errors.notFound.provider': 'Провайдер не найден',
    'errors.notFound.model': 'Модель не найдена',
    'errors.notFound.route': 'Маршрут не найден: {method} {path}',
    'errors.validation.nameRequired': 'Имя обязательно',
    'errors.validation.contentRequired': 'Контент обязателен',
    'errors.validation.apiKeyRequired': 'API-ключ обязателен',
    'errors.validation.urlRequired': 'URL обязателен',
    'errors.validation.invalidUrl': 'Некорректный URL',
    'errors.validation.apiKeyFormat': 'Некорректный формат API-ключа',
    'errors.providerDisabled': 'Провайдер отключён',
    'errors.connectionError': 'Ошибка подключения к провайдеру',
    'errors.notFound.favicon': 'Favicon не найден',
    'errors.faviconFetchError': 'Ошибка загрузки favicon',
    'errors.chat.queueFull': 'Очередь сообщений заполнена (макс. {max})',
  },
  en: {
    'app.title': 'Synth',
    'app.description': 'Personal AI Assistant',
    'nav.sessions': 'Sessions',
    'nav.projects': 'Projects',
    'nav.settings': 'Settings',
    'chat.placeholder': 'Type a message...',
    'chat.send': 'Send',
    'chat.cancel': 'Cancel',
    'chat.newSession': 'New Session',
    'chat.agentHint': 'Agent role',
    'chat.providerHint': 'Provider',
    'chat.modelHint': 'Model',
    'auth.login': 'Login',
    'auth.logout': 'Logout',
    'auth.apiKey': 'API Key',
    'auth.apiKeyHint': 'Enter your API key',
    'errors.notFound.session': 'Session not found',
    'errors.notFound.project': 'Project not found',
    'errors.notFound.provider': 'Provider not found',
    'errors.notFound.model': 'Model not found',
    'errors.notFound.route': 'Route not found: {method} {path}',
    'errors.validation.nameRequired': 'Name is required',
    'errors.validation.contentRequired': 'Content is required',
    'errors.validation.apiKeyRequired': 'API key is required',
    'errors.validation.urlRequired': 'URL is required',
    'errors.validation.invalidUrl': 'Invalid URL',
    'errors.validation.apiKeyFormat': 'Invalid API key format',
    'errors.providerDisabled': 'Provider is disabled',
    'errors.connectionError': 'Provider connection error',
    'errors.notFound.favicon': 'Favicon not found',
    'errors.faviconFetchError': 'Failed to fetch favicon',
    'errors.chat.queueFull': 'Message queue is full (max {max})',
  },
};

export function createI18nRoutes(): Hono {
  const app = new Hono();

  app.get('/current', (c) => {
    const header = c.req.header('Accept-Language');
    const lang = header?.split(',')[0]?.trim()?.slice(0, 2) === 'en' ? 'en' : 'ru';
    return c.json({ language: lang, locale: lang });
  });

  app.get('/translations/ru', (c) => c.json(TRANSLATIONS.ru));
  app.get('/translations/en', (c) => c.json(TRANSLATIONS.en));

  return app;
}
