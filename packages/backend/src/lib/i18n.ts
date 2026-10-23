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
  'errors.validation.invalidRoleFile': 'Role file name must be a plain file name without paths and ".."',
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

  // ADR-101 (Э6): пайплайны проекта, прогоны, шаблоны инстанса
  'errors.notFound.pipeline': 'Pipeline not found',
  'errors.notFound.pipelineRun': 'Pipeline run not found',
  'errors.notFound.pipelineTemplate': 'Pipeline template not found',
  'errors.validation.invalidPipelineBody': 'Invalid pipeline request payload',
  'errors.validation.invalidPipelineSpec': 'Invalid pipeline specification',
  'errors.validation.projectIdRequired': 'projectId is required',
  'errors.conflict.pipelineNotPublished': 'The pipeline has no published version',
  'errors.conflict.pipelineInvalidState': 'The run is not waiting for a human decision',
  'errors.conflict.pipelineNothingToPublish': 'There is no draft to publish',
  'errors.conflict.pipelineRunFinished': 'The run is already finished',
  'errors.conflict.pipelineTemplateUnsupported': 'The template cannot be instantiated as a pipeline',

  // ADR-102: отчёты аналитики (только чтение)
  'errors.validation.invalidAnalyticsPeriod': 'Invalid period: expected a date in YYYY-MM-DD (UTC)',
  'errors.validation.invalidAnalyticsRange': 'Period start is later than period end',
  'errors.validation.invalidAnalyticsGroupBy': 'Invalid grouping axis (groupBy)',
  'errors.validation.invalidAnalyticsOption': 'Invalid report parameter (report/format)',
  'errors.forbidden.analytics': 'Insufficient permissions for this report',

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
  'errors.unavailable.restartUnsupported':
    'Restart is unavailable: the instance runs without a supervisor (SYNTH_RESTART_MODE=disabled).',

  // ADR-091 (этап 2): перенос проекта (экспорт/импорт)
  'errors.validation.projectImportBody': 'Invalid project import request (multipart archive file is required)',
  'errors.validation.invalidProjectArchive': 'Project archive is invalid or corrupted',
  'errors.validation.projectArchiveChecksum': 'Project archive checksum mismatch',
  'errors.validation.projectWorkspaceRestore': 'Failed to restore the project workspace',
  'errors.conflict.projectNameInUse': 'A project with this name already exists',

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
  'errors.chat.steerLimitExceeded':
    'Steering limit reached (max {max} injected messages per turn)',
  'errors.chat.steerInterruptUnsupported':
    'Interrupt mode is not supported yet — use "steer" or "queue"',
  // PROP-108 Ф3: подтверждение не принято (нет гранта / повторный ответ / чужой ход).
  'errors.chat.approvalDenied': 'Approval was not accepted: {reason}',

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
  'errors.validation.invalidRoleFile': 'Имя файла роли должно быть именем файла без путей и «..»',
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

  // ADR-101 (Э6): пайплайны проекта, прогоны, шаблоны инстанса
  'errors.notFound.pipeline': 'Пайплайн не найден',
  'errors.notFound.pipelineRun': 'Прогон пайплайна не найден',
  'errors.notFound.pipelineTemplate': 'Шаблон пайплайна не найден',
  'errors.validation.invalidPipelineBody': 'Некорректное тело запроса пайплайна',
  'errors.validation.invalidPipelineSpec': 'Некорректная спецификация пайплайна',
  'errors.validation.projectIdRequired': 'Не указан projectId',
  'errors.conflict.pipelineNotPublished': 'У пайплайна нет опубликованной версии',
  'errors.conflict.pipelineInvalidState': 'Прогон не ожидает решения человека',
  'errors.conflict.pipelineNothingToPublish': 'Нет черновика для публикации',
  'errors.conflict.pipelineRunFinished': 'Прогон уже завершён',
  'errors.conflict.pipelineTemplateUnsupported': 'Шаблон нельзя инстанцировать в пайплайн',

  // ADR-102: отчёты аналитики (только чтение)
  'errors.validation.invalidAnalyticsPeriod': 'Некорректный период: ожидается дата YYYY-MM-DD (UTC)',
  'errors.validation.invalidAnalyticsRange': 'Начало периода позже конца периода',
  'errors.validation.invalidAnalyticsGroupBy': 'Некорректная ось группировки (groupBy)',
  'errors.validation.invalidAnalyticsOption': 'Некорректный параметр отчёта (report/format)',
  'errors.forbidden.analytics': 'Недостаточно прав для отчёта',

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
  'errors.unavailable.restartUnsupported':
    'Рестарт недоступен: инстанс запущен без супервизора (SYNTH_RESTART_MODE=disabled).',

  // ADR-091 (этап 2): перенос проекта (экспорт/импорт)
  'errors.validation.projectImportBody': 'Некорректный запрос импорта проекта (нужен multipart-файл архива)',
  'errors.validation.invalidProjectArchive': 'Архив проекта недействителен или повреждён',
  'errors.validation.projectArchiveChecksum': 'Контрольная сумма архива проекта не совпадает',
  'errors.validation.projectWorkspaceRestore': 'Не удалось восстановить рабочий каталог проекта',
  'errors.conflict.projectNameInUse': 'Проект с таким именем уже существует',

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
  'errors.chat.steerLimitExceeded':
    'Достигнут лимит вмешательств в ход (максимум {max} сообщений на ход)',
  'errors.chat.steerInterruptUnsupported':
    'Режим «прерывание хода» пока не поддерживается — используйте «вмешаться» или «в очередь»',
  // PROP-108 Ф3: подтверждение не принято (нет гранта / повторный ответ / чужой ход).
  'errors.chat.approvalDenied': 'Подтверждение не принято: {reason}',

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
