import { z } from 'zod';

/**
 * AD-029: Гранулярные permissions.
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
  rules: z.record(z.string(), permissionRuleSchema).default({}),
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
}
