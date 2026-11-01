import { z } from 'zod';

/**
 * ADR-029: Гранулярные permissions.
 * Модель OpenCode: allow/deny/ask для каждого тула + glob-паттерны для файлов.
 */

export const PERMISSION_ACTIONS = ['allow', 'deny', 'ask'] as const;

export const permissionActionSchema = z.enum(PERMISSION_ACTIONS);

export type PermissionAction = z.infer<typeof permissionActionSchema>;

/**
 * Значение правила:
 * - строка — действие для имени тула / группы / '*'
 * - объект — файловые glob-паттерны → действие (для read/edit/external_directory и
 *   для тул-специфичных файловых правил, например `write_file: {"*.env": "deny"}`)
 */
export const permissionRuleSchema = z.union([
  permissionActionSchema,
  z.record(z.string(), permissionActionSchema),
]);

export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export const permissionConfigSchema = z.object({
  rules: z.record(z.string(), permissionRuleSchema).prefault({}),
  askTimeoutMs: z.number().int().min(0).default(30_000),
});

export type PermissionConfig = z.infer<typeof permissionConfigSchema>;

/** Результат проверки одного tool_call. */
export interface PermissionDecision {
  action: PermissionAction;
  /** Человекочитаемое пояснение (причина deny/ask или источник allow). */
  reason: string;
  /** Ключ правила, которое сработало (имя тула, группа, паттерн или '*'). */
  matchedRule?: string;
  /** Идентификатор локализованного сообщения (deny-protected-path и т.д.). */
  messageId?: string;
  /** Параметры подстановки в сообщение ({{path}}, {{dir}}, {{command}}). */
  params?: Record<string, string>;
  /**
   * ADR-070 §2.9.1: тул недоступен не по жёсткому запрету, а из-за текущего
   * режима (`mode`), роли агента (`role`), отсутствия внешней программы
   * окружения (`dependency`), не заданного рабочего каталога проекта
   * (`workspace`) или недоступного хранилища (`storage`, ADR-098 W5 —
   * деградированный read-only режим). Отличие от `deny`-политики: доступ
   * открывается переключением режима / делегированием / установкой программы /
   * заданием workspace / восстановлением хранилища, поэтому модель получает
   * соответствующую подсказку (messageId).
   */
  unavailable?: { reason: 'mode' | 'role' | 'dependency' | 'workspace' | 'storage' };
}

/**
 * Превью изменений в запросе подтверждения (ADR-029, аддитивно).
 *
 * Пользователь подтверждает запись — он должен видеть, ЧТО именно изменится,
 * а не только сырые аргументы вызова. Превью — unified diff по файлам, которые
 * тул собирается изменить.
 *
 * Поле **необязательное**: превью считается «по возможности» — бинарный или
 * слишком большой файл, сбой расчёта → превью просто отсутствует, а запрос
 * подтверждения работает как прежде.
 */
export interface PermissionPreviewFile {
  /** Путь файла (как его ввёл агент). */
  path: string;
  /** Unified diff: строки `+` (добавлено), `-` (удалено), пробел (контекст). */
  diff: string;
  /** Сколько строк добавлено. */
  additions: number;
  /** Сколько строк удалено. */
  deletions: number;
}

/** Превью изменений по всем файлам запроса подтверждения. */
export interface PermissionPreview {
  /** Изменяемые файлы (по одному на файл). */
  files: PermissionPreviewFile[];
}

/**
 * Доступность MCP-инструмента по режимам сессии (plan / act).
 * Используется в настройках сессии: mcpToolSettings[serverName].tools[toolName]
 * или .default для всех инструментов сервера.
 */
export interface McpToolAvailability {
  plan: boolean;
  act: boolean;
}

/** Настройки доступности инструментов одного MCP-сервера по режимам. */
export interface McpServerToolSettings {
  /** Дефолт для всех инструментов сервера. */
  default?: McpToolAvailability;
  /** Точечная настройка по имени инструмента (без префикса сервера). */
  tools?: Record<string, McpToolAvailability>;
}
