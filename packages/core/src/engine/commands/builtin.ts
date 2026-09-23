import type { CommandSummary } from '@itphx/synth-shared';
import { t as sm } from '../system-messages.js';

/**
 * AD-046 §7.2: встроенные продуктовые команды Фазы 2. `/compact` и `/review`
 * отложены (решение Фазы 2).
 */
export const BUILTIN_COMMAND_NAMES = ['help', 'skills', 'commands', 'summary'] as const;
export type BuiltinCommandName = (typeof BUILTIN_COMMAND_NAMES)[number];

export function isBuiltinCommand(name: string): name is BuiltinCommandName {
  return (BUILTIN_COMMAND_NAMES as readonly string[]).includes(name);
}

/** Сводки встроенных команд для `list()`/`/help`. */
export const BUILTIN_COMMANDS: CommandSummary[] = [
  { name: 'help', kind: 'builtin', description: 'Справка по командам и скиллам', available: true },
  { name: 'skills', kind: 'builtin', description: 'Список доступных скиллов', available: true },
  { name: 'commands', kind: 'builtin', description: 'Список всех команд', available: true },
  { name: 'summary', kind: 'builtin', description: 'Запустить ручную суммаризацию диалога', available: true },
];

/** `/help` — статическая справка (без RAG). */
export function renderHelp(): string {
  const lines = [sm('command.help'), '', ...BUILTIN_COMMANDS.map((c) => `- /${c.name} — ${c.description}`)];
  return lines.join('\n');
}

/** `/skills` — список доступных скиллов. */
export function renderSkillsList(skills: readonly { commandName: string; description: string; available: boolean }[]): string {
  if (skills.length === 0) return sm('command.skills_empty');
  const lines = skills.map((s) => `- /${s.commandName}${s.available ? '' : ' (unavailable)'}: ${s.description}`);
  return lines.join('\n');
}

/** `/commands` — итоговый список команд. */
export function renderCommandsList(commands: readonly CommandSummary[]): string {
  if (commands.length === 0) return sm('command.list_empty');
  const lines = commands.map((c) => {
    const markers: string[] = [c.kind];
    if (!c.available && c.unavailableReason) markers.push(c.unavailableReason);
    return `- /${c.name} (${markers.join(', ')}): ${c.description}`;
  });
  return lines.join('\n');
}
