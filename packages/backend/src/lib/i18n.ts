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
  'errors.notFound.messageIndex': 'Message not found at index',
  'errors.notFound.user': 'User not found',
  'errors.notFound.file': 'File not found',
  'errors.notFound.favicon': 'Favicon not found',
  'errors.notFound.route': 'Not found: {method} {path}',
  'errors.notFound.agentOverride': 'Override not found',
  'errors.notFound.identity': 'Linked identity not found',
  'errors.notFound.identityClaim': 'Confirmation code is invalid (unknown, expired, or already used)',

  // Validation errors
  'errors.validation.contentRequired': 'content is required',
  'errors.validation.nameRequired': 'name is required',
  'errors.validation.idRequired': 'id is required',
  'errors.validation.invalidAgentId': 'Agent ID may contain only Latin letters, digits, hyphen and underscore',
  'errors.validation.urlRequired': 'url is required',
  'errors.validation.invalidUrl': 'Invalid URL',
  'errors.validation.apiKeyRequired': 'api_key is required',
  'errors.validation.usernameRequired': 'username is required',
  'errors.validation.groupsRequired': 'groups is required',
  'errors.validation.expectedFilesArray': 'expected { files: string[] }',
  'errors.validation.claimCodeRequired': 'Confirmation code is required',
  'errors.validation.invalidUsername': 'Invalid username',

  // ADR-089: приём внешних событий
  'errors.validation.invalidEvent': 'Invalid event payload',
  'errors.validation.invalidBinding': 'Invalid binding payload',
  'errors.notFound.binding': 'Binding not found',
  'errors.validation.invalidRule': 'Invalid routing rule payload',
  'errors.notFound.rule': 'Routing rule not found',
  'errors.validation.unknownAgent': 'Unknown agent in routing rule',
  'errors.validation.invalidEventKey': 'Invalid event API key',
  'errors.validation.invalidEventKeyUpdate': 'Invalid event API key update',
  'errors.notFound.eventKey': 'Event API key not found',

  // ADR-052 (этап I): service-key
  'errors.validation.invalidServiceKey': 'Invalid service key payload',
  'errors.notFound.serviceKey': 'Service key not found',
  'errors.conflict.serviceKeyLabel': 'Service key label is already used',
  'errors.forbidden.scopeRequired': 'Insufficient permissions: required scope is missing',
  'errors.forbidden.projectForbidden': 'Project is not available for this service key',
  'errors.rateLimited.serviceKey': 'Service key rate limit exceeded',

  // ADR-052 (этап II): исходящие webhooks
  'errors.validation.invalidWebhook': 'Invalid webhook subscription payload',
  'errors.notFound.webhook': 'Webhook subscription not found',
  'errors.conflict.webhookLabel': 'Webhook label is already used',
  'errors.validation.webhookTargetForbidden': 'Webhook target URL is not allowed by security policy',
  'errors.unavailable.webhooksDisabled': 'Webhook delivery is disabled',

  // ADR-091/ADR-092: обслуживание инстанса (backup/restore/doctor/migrate)
  'errors.validation.invalidMaintenanceBody': 'Invalid maintenance request payload',
  'errors.validation.maintenanceConfirmRequired': 'Confirmation is required (confirm: true)',
  'errors.validation.invalidBackupName': 'Invalid backup archive name',
  'errors.validation.invalidRestoreArchive': 'Backup archive failed validation',
  'errors.notFound.backup': 'Backup archive not found',
  'errors.conflict.schemaTooNew': 'Instance data is newer than this Synth version; update Synth',
  'errors.payloadTooLarge': 'Uploaded file exceeds the allowed size',
  'errors.validation.invalidAuditLimit': 'Invalid limit value (an integer 1..500)',
  'errors.validation.invalidAuditOp': 'Unknown maintenance journal operation',
  'errors.validation.encryptedRestoreUnsupported':
    'The archive is encrypted — decryption is available only via the CLI (synth restore <archive.enc>); the key is not available to the server.',

  // Conflict errors
  'errors.conflict.usernameExists': 'A user with this username already exists',
  'errors.conflict.emailExists': 'A user with this email already exists',
  'errors.conflict.usernameTaken': 'Username is taken',
  'errors.conflict.emailTaken': 'Email is taken',
  'errors.conflict.eventKeyLabel': 'Event API key label is already used',
  'errors.conflict.identityClaim': 'This identity is already linked to another profile',

  // Other errors
  'errors.providerDisabled': 'Provider is disabled',
  'errors.connectionError': 'Connection error',
  'errors.faviconFetchError': 'Error fetching favicon',
  'errors.generic': 'Error',
  'errors.rateLimited.eventKey': 'Event API key rate limit exceeded',
  'errors.rateLimited.identityClaim': 'Too many identity confirmation attempts, try again later',
  'errors.unavailable.eventsDisabled': 'External event ingestion is disabled',

  // Auth
  'auth.unauthorized': 'Authentication required',
  'auth.forbidden': 'Access denied',
  'auth.invalidApiKey': 'Invalid API key',
  'auth.oidcDisabled': 'OIDC is disabled',
  'auth.oidcStateMismatch': 'OIDC state mismatch',
  'auth.oidcExchangeFailed': 'OIDC authentication failed',
  'auth.credentialsRequired': 'Enter username and password',
  'auth.oidcLoginFailed': 'Invalid username or password',
  'auth.spaLoginDisabled': 'Use single sign-on (SSO)',

  // Locales
  'locales.ru.nativeName': 'Russian',

  // Chat
  'errors.chat.queueFull': 'Queue is full (max {max} messages)',

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
  'errors.notFound.messageIndex': 'Сообщение не найдено по индексу',
  'errors.notFound.user': 'Пользователь не найден',
  'errors.notFound.file': 'Файл не найден',
  'errors.notFound.favicon': 'Favicon не найден',
  'errors.notFound.route': 'Не найдено: {method} {path}',
  'errors.notFound.agentOverride': 'Override не найден',
  'errors.notFound.identity': 'Привязанная идентичность не найдена',
  'errors.notFound.identityClaim': 'Код подтверждения недействителен (неизвестен, истёк или использован)',

  // Validation errors
  'errors.validation.contentRequired': 'content обязателен',
  'errors.validation.nameRequired': 'name обязателен',
  'errors.validation.idRequired': 'id обязателен',
  'errors.validation.invalidAgentId': 'ID агента может содержать только латиницу, цифры, дефис и подчёркивание',
  'errors.validation.urlRequired': 'URL не указан',
  'errors.validation.invalidUrl': 'Некорректный URL',
  'errors.validation.apiKeyRequired': 'api_key обязателен',
  'errors.validation.usernameRequired': 'username обязателен',
  'errors.validation.groupsRequired': 'groups обязательны',
  'errors.validation.expectedFilesArray': 'expected { files: string[] }',
  'errors.validation.claimCodeRequired': 'Укажите код подтверждения',
  'errors.validation.invalidUsername': 'Некорректное имя пользователя',

  // ADR-089: приём внешних событий
  'errors.validation.invalidEvent': 'Некорректное тело события',
  'errors.validation.invalidBinding': 'Некорректное тело биндинга',
  'errors.notFound.binding': 'Биндинг не найден',
  'errors.validation.invalidRule': 'Некорректное тело правила маршрутизации',
  'errors.notFound.rule': 'Правило маршрутизации не найдено',
  'errors.validation.unknownAgent': 'Неизвестный агент в правиле маршрутизации',
  'errors.validation.invalidEventKey': 'Неверный API-ключ события',
  'errors.validation.invalidEventKeyUpdate': 'Некорректное тело обновления API-ключа события',
  'errors.notFound.eventKey': 'API-ключ события не найден',

  // ADR-052 (этап I): service-key
  'errors.validation.invalidServiceKey': 'Некорректное тело service-key',
  'errors.notFound.serviceKey': 'Service-key не найден',
  'errors.conflict.serviceKeyLabel': 'Метка service-key уже используется',
  'errors.forbidden.scopeRequired': 'Недостаточно прав: отсутствует требуемый scope',
  'errors.forbidden.projectForbidden': 'Проект недоступен для этого service-key',
  'errors.rateLimited.serviceKey': 'Превышен лимит запросов по service-key',

  // ADR-052 (этап II): исходящие webhooks
  'errors.validation.invalidWebhook': 'Некорректное тело webhook-подписки',
  'errors.notFound.webhook': 'Webhook-подписка не найдена',
  'errors.conflict.webhookLabel': 'Метка webhook уже используется',
  'errors.validation.webhookTargetForbidden': 'Целевой URL webhook запрещён политикой безопасности',
  'errors.unavailable.webhooksDisabled': 'Доставка webhooks отключена',

  // ADR-091/ADR-092: обслуживание инстанса (backup/restore/doctor/migrate)
  'errors.validation.invalidMaintenanceBody': 'Некорректное тело запроса обслуживания',
  'errors.validation.maintenanceConfirmRequired': 'Требуется подтверждение (confirm: true)',
  'errors.validation.invalidBackupName': 'Некорректное имя архива',
  'errors.validation.invalidRestoreArchive': 'Архив не прошёл проверку',
  'errors.notFound.backup': 'Архив не найден',
  'errors.conflict.schemaTooNew': 'Данные новее версии Synth; обновите Synth',
  'errors.payloadTooLarge': 'Загруженный файл превышает допустимый размер',
  'errors.validation.invalidAuditLimit': 'Некорректное значение limit (целое 1..500)',
  'errors.validation.invalidAuditOp': 'Неизвестная операция журнала обслуживания',
  'errors.validation.encryptedRestoreUnsupported':
    'Архив зашифрован — расшифровка доступна только через CLI (synth restore <archive.enc>); ключ серверу недоступен.',

  // Conflict errors
  'errors.conflict.usernameExists': 'Пользователь с таким именем уже существует',
  'errors.conflict.emailExists': 'Пользователь с таким email уже существует',
  'errors.conflict.usernameTaken': 'Имя занято',
  'errors.conflict.emailTaken': 'Email занят',
  'errors.conflict.eventKeyLabel': 'Метка API-ключа события уже используется',
  'errors.conflict.identityClaim': 'Эта идентичность уже привязана к другому профилю',

  // Other errors
  'errors.providerDisabled': 'Провайдер отключён',
  'errors.connectionError': 'Ошибка подключения',
  'errors.faviconFetchError': 'Ошибка получения favicon',
  'errors.generic': 'Ошибка',
  'errors.rateLimited.eventKey': 'Превышен лимит запросов по API-ключу события',
  'errors.rateLimited.identityClaim': 'Слишком много попыток подтверждения идентичности, повторите позже',
  'errors.unavailable.eventsDisabled': 'Приём внешних событий отключён',

  // Auth
  'auth.unauthorized': 'Требуется аутентификация',
  'auth.forbidden': 'Доступ запрещён',
  'auth.invalidApiKey': 'Неверный API-ключ',
  'auth.oidcDisabled': 'OIDC отключён',
  'auth.oidcStateMismatch': 'Сбой проверки state в OIDC',
  'auth.oidcExchangeFailed': 'Не удалось пройти OIDC-аутентификацию',
  'auth.credentialsRequired': 'Введите логин и пароль',
  'auth.oidcLoginFailed': 'Неверный логин или пароль',
  'auth.spaLoginDisabled': 'Используйте единый вход (SSO)',

  // Locales
  'locales.ru.nativeName': 'Русский',

  // Chat
  'errors.chat.queueFull': 'Очередь переполнена (максимум {max} сообщений)',

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
