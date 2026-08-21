const LOG_LEVELS: Record<string, number | null> = {
  NONE: null,
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

const LEVEL_NAMES: Record<number | string, string> = {};
for (const [name, value] of Object.entries(LOG_LEVELS)) {
  LEVEL_NAMES[String(value)] = name;
  if (value !== null) LEVEL_NAMES[value] = name;
}
LEVEL_NAMES['null'] = 'NONE';

const DEFAULT_GROUPS: Record<string, string> = {
  OPENAI: 'INFO',
  ANTHROPIC: 'INFO',
  OLLAMA: 'INFO',
  MCP: 'INFO',
  ROUTES: 'WARNING',
  ORCHESTRATOR: 'INFO',
  CHAT_STREAM: 'WARNING',
  STORAGE: 'WARNING',
  DEBUG: 'DEBUG',
  WEBSOCKET: 'INFO',
};

let _groupOverrides: Record<string, string> = {};

export const LOG_LEVEL_NAMES = Object.keys(LOG_LEVELS);

function getLevelForGroup(group: string): number | null {
  const levelName = _groupOverrides[group] ?? DEFAULT_GROUPS[group] ?? 'INFO';
  return LOG_LEVELS[levelName] ?? null;
}

export function setLevelForGroup(group: string, levelName: string): void {
  if (!(levelName in LOG_LEVELS)) {
    throw new Error(`Недопустимый уровень: ${levelName}`);
  }
  _groupOverrides[group] = levelName;
}

export function getAllGroups(): Record<string, string> {
  return { ...DEFAULT_GROUPS, ..._groupOverrides };
}

export function setAllGroups(groups: Record<string, string>): void {
  _groupOverrides = {};
  for (const [group, level] of Object.entries(groups)) {
    if (!(level in LOG_LEVELS)) {
      throw new Error(`Недопустимый уровень для группы ${group}: ${level}`);
    }
    _groupOverrides[group] = level;
  }
}

export function resetGroupOverrides(): void {
  _groupOverrides = {};
}

function log(group: string, levelName: string, message: string): void {
  const level = LOG_LEVELS[levelName];
  if (level === null || level === undefined) return;

  const groupLevel = getLevelForGroup(group);
  if (groupLevel === null) return;
  if (level < groupLevel) return;

  const prefix = `[${group}]`;
  const line = `${prefix} ${message}`;

  switch (level) {
    case 10: console.debug(line); break;
    case 20: console.info(line); break;
    case 30: console.warn(line); break;
    case 40:
    case 50: console.error(line); break;
  }
}

export function debug(group: string, message: string): void {
  log(group, 'DEBUG', message);
}

export function info(group: string, message: string): void {
  log(group, 'INFO', message);
}

export function warning(group: string, message: string): void {
  log(group, 'WARNING', message);
}

export function error(group: string, message: string): void {
  log(group, 'ERROR', message);
}

export function critical(group: string, message: string): void {
  log(group, 'CRITICAL', message);
}
