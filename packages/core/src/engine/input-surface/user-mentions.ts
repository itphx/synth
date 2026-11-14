/**
 * PROP-126 §2.1: `@user` — граница «агенту / пользователю».
 *
 * Первое упоминание пользователя (вне code-блоков) делит сообщение на две
 * части:
 *
 * ```text
 * Исправь баг X @alice проверь исправление.
 * └── агенту ──┘ └──── пользователю ────┘
 * ```
 *
 * - часть **до** первого `@user` идёт агенту (обычная очередь, ход);
 * - часть **от** первого `@user` до конца — пользователю: она сохраняется в
 *   историю как user-directed сообщение (`metadata.userDirected = true`),
 *   публикует `message.mentioned` и **не** запускает ход.
 *
 * Правила (PROP-126 §2.1):
 *
 * 1. Упоминать можно только пользователей с доступом к сессии — участников
 *    сессии/проекта (`deriveSessionParticipants`). Недоступный/неизвестный
 *    пользователь — `400 VALIDATION_ERROR` (без частичной доставки).
 * 2. В user-directed хвосте распознаются **только** `@user`-упоминания:
 *    `@agent`, `$`, `#` и `!` там — обычный текст.
 * 3. Несколько `@user` в хвосте — все получают уведомление и бейдж; сообщение
 *    одно, не по одному на каждого.
 * 4. Self-mention допускается, но уведомление себе не отправляется.
 *
 * Модуль **чистый** (без I/O), кроме `resolveMentionableUsers`, который
 * читает профили через `ProfileStore` (username/displayName участников).
 */

import type {
  InputMention,
  MentionKind,
  ProfileData,
  ProfileStore,
  SessionParticipant,
} from '@itphx/synth-shared';

import { parseInput } from './parser.js';

/** Виды упоминаний, допустимые в явном payload `mentions` (PROP-126 §2). */
const MENTION_KINDS: readonly MentionKind[] = ['file', 'agent', 'user'];

/**
 * Пользователь, доступного для упоминания (участник сессии/проекта).
 *
 * Набор **выводится** из участников (`deriveSessionParticipants`) — общий
 * список пользователей инстанса не раскрывается (PROP-126 §2).
 */
export interface MentionableUser {
  /** id пользователя (тот же id, что у владельца сессии/участника проекта). */
  userId: string;
  /** username — для совпадения по `@name`. */
  username?: string;
  /** Отображаемое имя — для совпадения по `@Name`. */
  displayName?: string;
}

/** Результат валидации явного payload `mentions` (PROP-126 §2). */
export interface ExplicitMentionsResult {
  /** Упоминания пользователей из payload (id уже разрешён в пользователя). */
  userMentions: InputMention[];
  /** id пользователей, которых нельзя упомянуть (недоступны/неизвестны). */
  invalidUserIds: string[];
  /** `true` — payload невалиден по форме (не массив/поле/span). */
  malformed: boolean;
}

/** Результат разбора `@user`: разбиение сообщения на части. */
export interface UserMentionSplit {
  /**
   * Упоминания пользователей (всегда `kind: 'user'`) в порядке появления.
   * Span'ы — индексы **в тексте user-хвоста**.
   */
  mentions: InputMention[];
  /** Текст агентской части (до первого `@user`); пусто — агент не запускается. */
  agentText: string;
  /** Текст пользовательского хвоста (от первого `@user`); `undefined` — хвоста нет. */
  userText?: string;
  /** id пользователей, которых нельзя упомянуть (доставка не выполняется). */
  invalidUserIds: string[];
}

/**
 * Участники сессии/проекта → пользователи, доступные для упоминания.
 *
 * Профиль участника ищется по трём признакам (по порядку):
 * `profile.id === userId` → `identity.externalId === userId` (auth-идентичность,
 * ADR-140) → `profile.username === userId` (standalone: id пользователя =
 * username). Профили, не соответствующие участнику, **не** используются —
 * общий список пользователей инстанса не раскрывается.
 */
export async function resolveMentionableUsers(
  participants: readonly SessionParticipant[],
  profilesStore?: ProfileStore,
): Promise<MentionableUser[]> {
  const users: MentionableUser[] = [];
  let profiles: ProfileData[] = [];
  if (profilesStore) {
    try {
      profiles = await profilesStore.listProfiles();
    } catch {
      // Профили недоступны — упоминание по username/displayName не работает,
      // но упоминание по id участника остаётся возможным.
      profiles = [];
    }
  }

  for (const participant of participants) {
    const userId = participant.userId;
    if (!userId) continue;
    const profile = profiles.find((candidate) => profileMatchesUser(candidate, userId));
    const user: MentionableUser = { userId };
    if (profile) {
      if (profile.username) user.username = profile.username;
      if (profile.displayName) user.displayName = profile.displayName;
    }
    users.push(user);
  }

  return users;
}

/** Профиль соответствует пользователю (по id, auth-идентичности или username). */
function profileMatchesUser(profile: ProfileData, userId: string): boolean {
  if (profile.id === userId) return true;
  if ((profile.identities ?? []).some((identity) => identity.externalId === userId)) return true;
  return profile.username === userId;
}

/**
 * Индекс пользователей для сопоставления токена `@name`.
 *
 * Два уровня: точное совпадение (`userId`/`username`/`displayName`) и, если
 * точного нет, — регистронезависимое. Два уровня нужны, чтобы `@Alice` не
 * перебивал точное совпадение с `@alice` другого участника.
 */
function buildUserIndex(users: readonly MentionableUser[]): {
  exact: Map<string, MentionableUser>;
  loose: Map<string, MentionableUser>;
} {
  const exact = new Map<string, MentionableUser>();
  const loose = new Map<string, MentionableUser>();
  for (const user of users) {
    const keys = [user.userId, user.username, user.displayName].filter(
      (key): key is string => typeof key === 'string' && key.length > 0,
    );
    for (const key of keys) {
      if (!exact.has(key)) exact.set(key, user);
      const lower = key.toLowerCase();
      if (!loose.has(lower)) loose.set(lower, user);
    }
  }
  return { exact, loose };
}

/** Пользователь по токену упоминания (`null` — не пользователь). */
function matchUser(index: { exact: Map<string, MentionableUser>; loose: Map<string, MentionableUser> }, token: string): MentionableUser | undefined {
  return index.exact.get(token) ?? index.loose.get(token.toLowerCase());
}

/**
 * Валидация явного payload `mentions` (PROP-126 §2 «Payload»).
 *
 * `kind: 'user'` → id обязан соответствовать доступному участнику, иначе
 * пользователь попадает в `invalidUserIds` (роут отвечает `400
 * VALIDATION_ERROR` — без частичной доставки). Виды `file`/`agent` в этом
 * срезе не разрешаются (задача — только `@user`), но проверяются по форме.
 */
export function validateExplicitMentions(
  value: unknown,
  users: readonly MentionableUser[],
): ExplicitMentionsResult {
  const result: ExplicitMentionsResult = {
    userMentions: [],
    invalidUserIds: [],
    malformed: false,
  };
  if (value === undefined || value === null) return result;
  if (!Array.isArray(value)) {
    result.malformed = true;
    return result;
  }

  const index = buildUserIndex(users);
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      result.malformed = true;
      continue;
    }
    const raw = item as { kind?: unknown; id?: unknown; label?: unknown; span?: unknown };
    const kind = raw.kind;
    if (typeof kind !== 'string' || !MENTION_KINDS.includes(kind as MentionKind)) {
      result.malformed = true;
      continue;
    }
    if (typeof raw.id !== 'string' || raw.id.trim() === '') {
      result.malformed = true;
      continue;
    }
    const label = typeof raw.label === 'string' ? raw.label : raw.id;
    const span = normalizeSpan(raw.span);
    if (raw.span !== undefined && raw.span !== null && !span) {
      result.malformed = true;
      continue;
    }
    if (kind !== 'user') continue;
    const user = matchUser(index, raw.id);
    if (!user) {
      if (!result.invalidUserIds.includes(raw.id)) result.invalidUserIds.push(raw.id);
      continue;
    }
    if (!span) continue;
    result.userMentions.push({
      kind: 'user',
      id: user.userId,
      label,
      span,
    });
  }

  return result;
}

/** Span из payload: целые `start`/`end`, `0 <= start <= end`. */
function normalizeSpan(value: unknown): { start: number; end: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as { start?: unknown; end?: unknown };
  if (!Number.isInteger(raw.start) || !Number.isInteger(raw.end)) return undefined;
  const start = raw.start as number;
  const end = raw.end as number;
  if (start < 0 || end < start) return undefined;
  return { start, end };
}

/**
 * Разбор `@user`-упоминаний и разбиение сообщения на части.
 *
 * @param text исходный текст сообщения (уже обрезанный по краям)
 * @param users доступные для упоминания пользователи (участники сессии/проекта)
 * @param explicit результат валидации явного payload `mentions`
 */
export function resolveUserMentionSplit(input: {
  text: string;
  users: readonly MentionableUser[];
  explicit?: ExplicitMentionsResult;
}): UserMentionSplit {
  const { text, users } = input;
  const invalidUserIds = input.explicit?.invalidUserIds ?? [];
  const index = buildUserIndex(users);

  // 1. Упоминания пользователей, набранные в тексте (общий лексер).
  const parsed = parseInput(text);
  const textMentions: InputMention[] = [];
  for (const mention of parsed.mentions) {
    const user = matchUser(index, mention.id);
    if (!user) continue;
    textMentions.push({
      kind: 'user',
      id: user.userId,
      label: mention.label,
      span: { start: mention.span.start, end: mention.span.end },
    });
  }

  // 2. Явные упоминания клиента — дополняют текстовые (по id пользователя
  //    текстовое выигрывает: его span — из исходного текста).
  const explicitMentions = input.explicit?.userMentions ?? [];
  const merged = new Map<string, InputMention>();
  for (const mention of textMentions) merged.set(mention.id, mention);
  for (const mention of explicitMentions) {
    if (merged.has(mention.id)) continue;
    merged.set(mention.id, mention);
  }
  const mentions = [...merged.values()].sort((a, b) => a.span.start - b.span.start);

  const first = mentions[0];
  if (!first) {
    // `@user` нет — поведение прежнее: всё сообщение идёт агенту.
    return { mentions: [], agentText: text, userText: undefined, invalidUserIds };
  }

  // 3. Граница — первое упоминание пользователя. Текст до него — агенту,
  //    текст от него — пользователю (вместе с самим токеном `@user`).
  const boundary = first.span.start;
  const agentText = text.slice(0, boundary).trim();
  const userText = text.slice(boundary);
  const tailMentions = mentions.map((mention) => ({
    ...mention,
    span: {
      start: mention.span.start - boundary,
      end: mention.span.end - boundary,
    },
  }));

  return { mentions: tailMentions, agentText, userText, invalidUserIds };
}

/**
 * Признак user-directed сообщения (PROP-126 §2.1).
 *
 * Сообщение адресовано человеку, а не агенту: оно **не** гасит ход (у него
 * нет флага `disabled`) и исключается из LLM-контекста текущего хода, если
 * оно новее сообщения-триггера.
 */
export function isUserDirectedMessage(message: { metadata?: Record<string, unknown> }): boolean {
  return message.metadata?.userDirected === true;
}
