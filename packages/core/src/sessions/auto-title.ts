import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDefaultTitle } from '@itphx/synth-shared';
import type { Message, Session, TokenUsage } from '@itphx/synth-shared';
import { autoTitleConfigSchema } from '@itphx/synth-shared/config';
import type { AutoTitleConfig } from '@itphx/synth-shared/config';
import type { SessionManager } from './manager.js';
import type { BaseProvider, LLMMessage } from '../providers/base.js';
import { isUserDialogueMessage } from './user-messages.js';
import { warning } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Предел длины LLM-заголовка: длиннее — считаем ответ непригодным. */
const MAX_LLM_TITLE_LENGTH = 100;
/** Предел длины фоллбек-заголовка из текста реплики. */
const MAX_FALLBACK_TITLE_LENGTH = 60;
/** Предел длины исходного сообщения, попадающего в промпт заголовка. */
const MAX_MESSAGE_CHARS = 2000;
/** Предел длины одной реплики в блоке «Recent conversation». */
const MAX_CONVERSATION_LINE_CHARS = 1000;
/** Общий бюджет промпта заголовка по диалогу (символы). */
const MAX_CONVERSATION_CHARS = 8000;
/**
 * Минимальная длина «содержательного» остатка реплики после вырезания
 * приветствия: короче — считаем смолтком (chatter), а не задачей.
 */
const MIN_MEANINGFUL_CHARS = 3;

/**
 * Лексикон приветствий/смолтка (RU + EN).
 *
 * Совпадение само по себе **не** делает реплику «пустой»: смолтком считается
 * только сообщение, у которого после вырезания приветствия не остаётся
 * содержательного текста (см. `isLowSignalMessage`). Поэтому «привет, почини
 * баг с авторизацией» — это сигнал задачи, а «привет» — нет.
 *
 * Лексикон хранится **словами/фразами**, а не регулярками с `\b`: в JS `\b`
 * работает только по ASCII, поэтому кириллица (и любые не-ASCII буквы) под
 * такой границей не матчились бы вовсе.
 */
const GREETING_PHRASES: ReadonlySet<string> = new Set([
  // RU
  'привет', 'приветик', 'приветики', 'приветца', 'приветствую', 'приветствуйте',
  'здравствуй', 'здравствуйте',
  'добрый день', 'добрый вечер', 'доброе утро',
  'хай', 'салют',
  'как дела', 'как ты', 'что нового',
  'спасибо', 'спасибочки', 'благодарю', 'спс',
  'ок', 'окей', 'ясно', 'понятно', 'понял', 'хорошо', 'ладно', 'ага', 'угу',
  // EN
  'hello', 'hi', 'hey', 'how are you', 'whats up',
  'thanks', 'thank you', 'ok', 'okay', 'yes', 'no problem',
]);

/** Максимальная длина приветственной фразы в словах. */
const MAX_GREETING_PHRASE_WORDS = 3;

/**
 * Разбить текст на слова (буквы/цифры/underscore, без апострофов) —
 * Unicode-aware: кириллица и латиница одинаково «слова».
 */
function splitWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Убрать из списка слов приветственные фразы (сначала — самая длинная).
 * Остаток — содержательная часть реплики.
 */
function stripGreetingPhrases(words: string[]): string[] {
  const rest: string[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    const maxLen = Math.min(MAX_GREETING_PHRASE_WORDS, words.length - i);
    for (let len = maxLen; len >= 1; len -= 1) {
      if (GREETING_PHRASES.has(words.slice(i, i + len).join(' '))) {
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      rest.push(words[i]!);
      i += 1;
    }
  }
  return rest;
}

/**
 * Снять простую markdown-разметку со строки (заголовки, списки, цитаты,
 * ссылки, код, выделение) — фоллбек-заголовок не должен содержать `#`/`**`.
 */
function stripMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Первая непустая строка текста без markdown-разметки, обрезанная до 60
 * символов. Пусто — `null` (заголовок из текста построить не из чего).
 */
function titleLineFromContent(content: string): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripMarkdown(rawLine);
    if (!line) continue;
    return line.length > MAX_FALLBACK_TITLE_LENGTH
      ? line.slice(0, MAX_FALLBACK_TITLE_LENGTH).trimEnd()
      : line;
  }
  return null;
}

/**
 * Есть ли в сообщении вложение (ADR-115): медиа-часть (`image`/`audio`/
 * `video`/`file`) либо ссылка на blob-объект (`blobPath`).
 */
function messageHasAttachments(message: Message): boolean {
  for (const part of message.parts ?? []) {
    if (!part) continue;
    if (
      part.type === 'image'
      || part.type === 'audio'
      || part.type === 'video'
      || part.type === 'file'
    ) {
      return true;
    }
    const data = part.data as { blobPath?: unknown } | null | undefined;
    if (data && typeof data === 'object' && typeof data.blobPath === 'string' && data.blobPath) {
      return true;
    }
  }
  return false;
}

/**
 * Признак «реплика не задаёт задачу» (chatter): пустой текст, приветствие
 * или короткий смолток.
 *
 * - вложение — всегда **сигнал** задачи (`false`);
 * - пустой/пробельный текст — `true`;
 * - нормализованный текст не короче `minSignalChars` — **сигнал** (`false`);
 * - совпадение с лексиконом приветствий, после которого не остаётся
 *   содержательного текста — `true` (chatter);
 * - иначе — `false` (fail-open к именованию: лучше назвать, чем не назвать).
 */
export function isLowSignalMessage(
  content: string,
  hasAttachments: boolean,
  cfg: Pick<AutoTitleConfig, 'minSignalChars'>,
): boolean {
  if (hasAttachments) return false;
  const normalized = (content ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  if (normalized.length >= cfg.minSignalChars) return false;
  // Приветствия/смолток вырезаем по словам: после них не остаётся ничего
  // содержательного — реплика не задаёт задачу (chatter).
  const rest = stripGreetingPhrases(splitWords(normalized));
  const meaningful = rest.join('').replace(/[^\p{L}\p{N}]/gu, '');
  return meaningful.length < MIN_MEANINGFUL_CHARS;
}

/**
 * План авто-заголовка по состоянию сессии.
 *
 * - `message` — назвать по **первому** сообщению пользователя;
 * - `conversation` — назвать по диалогу (первый запрос + недавние реплики).
 */
export interface AutoTitlePlan {
  mode: 'message' | 'conversation';
}

/**
 * Нужен ли авто-заголовок сессии и в каком режиме.
 *
 * Правило попыток (N — число диалоговых реплик пользователя):
 * - N=1 и сообщение-«chatter» → `null` (LLM не зовём, ждём следующую реплику);
 * - N=1 и есть сигнал задачи → `{ mode: 'message' }`;
 * - N=2..`maxAttempts` → `{ mode: 'conversation' }`;
 * - N > `maxAttempts` → `null` (только ручная регенерация).
 *
 * Счётчик выводится из истории — состояние нигде не персистится (переживает
 * рестарт, идемпотентно).
 */
export function shouldAutoTitle(
  session: Session,
  cfg: AutoTitleConfig,
  opts?: { force?: boolean },
): AutoTitlePlan | null {
  if (session.parentId) return null;
  if (!cfg.enabled) return null;

  const userMsgs = session.messages.filter(isUserDialogueMessage);
  if (userMsgs.length === 0) return null;

  // Ручная регенерация: заголовок перетирается (force), даже если он задан.
  if (opts?.force) return { mode: 'conversation' };

  if (!isDefaultTitle(session.title)) return null;

  const first = userMsgs[0]!;
  if (userMsgs.length === 1 && (first.content ?? '').trimStart().startsWith('/')) {
    // Slash-команда — не диалог, имя по ней не строим.
    return null;
  }

  if (userMsgs.length === 1) {
    if (cfg.deferOnChatter && isLowSignalMessage(first.content ?? '', messageHasAttachments(first), cfg)) {
      return null;
    }
    return { mode: 'message' };
  }

  if (userMsgs.length <= cfg.maxAttempts) return { mode: 'conversation' };
  return null;
}

/**
 * Промпт генерации заголовка по языку сессии: TITLE.{lang}.md → TITLE.ru.md
 * (легаси-дефолт). Промпт — локализуемый ассет (как роли), не системное сообщение.
 */
function loadTitlePrompt(language?: string): string {
  const lang = language === 'en' ? 'en' : 'ru';
  const paths = [
    join(__dirname, '..', 'engine', 'context', 'prompts', 'roles', `TITLE.${lang}.md`),
    join(__dirname, '..', 'engine', 'agents', 'definitions', 'title.txt'),
    join(__dirname, '..', '..', 'prompts', 'roles', `TITLE.${lang}.md`),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, 'utf-8');
    }
  }
  if (lang === 'en') {
    return 'Generate a short title (3-7 words) for this conversation. Return only the title, no explanations.';
  }
  return 'Сгенерируй краткий заголовок (3-7 слов) для этого диалога. Верни только заголовок, без пояснений.';
}

/** Опции вызова авто-заголовка. */
export interface AutoTitleOptions {
  /** Конфигурация секции `session.autoTitle` (дефолт — дефолты схемы). */
  config?: AutoTitleConfig;
  /** Ручная регенерация: заголовок перетирается, даже если он задан. */
  force?: boolean;
  /** ADR-102: колбэк usage LLM-заголовка (aux-вызов) — для счётчиков/аналитики. */
  onUsage?: (usage: TokenUsage, meta: { provider?: string; model?: string }) => void | Promise<void>;
}

/**
 * In-flight guard: параллельный второй вызов по той же сессии не должен
 * звать LLM и не должен перетирать заголовок (гонка двух ходов).
 */
const inFlightSessions = new Set<string>();

/** Содержимое промпта для режима «первое сообщение». */
function buildMessagePrompt(content: string, language?: string): string {
  const text = content.slice(0, MAX_MESSAGE_CHARS);
  return language === 'en'
    ? `Here is the first message of the conversation:\n\n<message>\n${text}\n</message>\n\nReply with the title only.`
    : `Вот первое сообщение диалога:\n\n<message>\n${text}\n</message>\n\nОтветь только заголовком.`;
}

/**
 * Содержимое промпта для режима «по диалогу»: исходный запрос + недавние
 * реплики. Бюджет — 8000 символов, обрезка сохраняет **конец** (свежие реплики).
 */
function buildConversationPrompt(session: Session, firstUser: Message): string {
  const original = firstUser.content.slice(0, MAX_MESSAGE_CHARS);
  const lines: string[] = [];
  for (const message of session.messages) {
    if (isUserDialogueMessage(message)) {
      lines.push(`User: ${(message.content ?? '').slice(0, MAX_CONVERSATION_LINE_CHARS)}`);
      continue;
    }
    if (message.role === 'assistant' && message.origin === 'local') {
      lines.push(`Assistant: ${(message.content ?? '').slice(0, MAX_CONVERSATION_LINE_CHARS)}`);
    }
  }
  const content = `Original request:\n${original}\n\nRecent conversation:\n${lines.join('\n')}`;
  return content.length > MAX_CONVERSATION_CHARS
    ? content.slice(content.length - MAX_CONVERSATION_CHARS)
    : content;
}

/**
 * Авто-заголовок сессии.
 *
 * Единая точка вызова (оркестратор): план считает `shouldAutoTitle`, LLM
 * зовётся только когда есть сигнал задачи, фоллбек — из текста реплики с
 * сигналом. Заголовок по умолчанию не перетирается (`renameSessionIfDefault`),
 * при `force` — перетирается (ручная регенерация).
 */
export async function autoTitleSession(
  session: Session,
  manager: SessionManager,
  provider: BaseProvider,
  opts: AutoTitleOptions = {},
): Promise<string | null> {
  const cfg = opts.config ?? autoTitleConfigSchema.parse({});
  const plan = shouldAutoTitle(session, cfg, { force: opts.force === true });
  if (!plan) return null;

  if (inFlightSessions.has(session.id)) return null;
  inFlightSessions.add(session.id);
  try {
    const userMsgs = session.messages.filter(isUserDialogueMessage);
    const firstUser = userMsgs[0]!;

    const userContent = plan.mode === 'message'
      ? buildMessagePrompt(firstUser.content ?? '', session.settings.language)
      : buildConversationPrompt(session, firstUser);

    const messages: LLMMessage[] = [
      {
        id: '',
        role: 'user',
        content: userContent,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
      },
    ];

    // LLM-заголовок; при ошибке/пустом/слишком длинном ответе — фоллбек ниже.
    // Содержимое сообщений в журнал не попадает (только причина).
    let title: string | null = null;
    try {
      const response = await provider.chat(
        messages,
        loadTitlePrompt(session.settings.language),
        undefined,
        false,
        undefined,
      );

      // ADR-102: usage заголовка — aux (сообщением не становится).
      if (response.usage) {
        try {
          await opts.onUsage?.(response.usage, {
            ...(provider.name ? { provider: provider.name } : {}),
            ...(response.model ?? provider.model ? { model: response.model ?? provider.model } : {}),
          });
        } catch {
          // aux-учёт best-effort: заголовок важнее
        }
      }

      let text = (response.content || '').trim();
      text = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0)
        || '';

      text = text.replace(/^["']|["']$/g, '').trim();
      if (!text) {
        warning('AUTO-TITLE', 'модель вернула пустой заголовок — фоллбек из текста реплики');
      } else if (text.length > MAX_LLM_TITLE_LENGTH) {
        warning(
          'AUTO-TITLE',
          `заголовок модели длиннее ${MAX_LLM_TITLE_LENGTH} символов — фоллбек из текста реплики`,
        );
      } else {
        title = text;
      }
    } catch (err) {
      warning(
        'AUTO-TITLE',
        `генерация заголовка не удалась (${err instanceof Error ? err.message : String(err)}) — фоллбек из текста реплики`,
      );
    }

    // Фоллбек: первая реплика пользователя **с сигналом задачи** (приветствие
    // заголовком не становится). Нет такой реплики — заголовок не меняем.
    title ??= fallbackTitleFromDialogue(userMsgs, cfg);
    if (!title) return null;

    const saved = opts.force
      ? await manager.renameSession(session.id, title)
      : await manager.renameSessionIfDefault(session.id, title);
    return saved ? title : null;
  } catch (err) {
    warning(
      'AUTO-TITLE',
      `авто-заголовок не сформирован: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    inFlightSessions.delete(session.id);
  }
}

/**
 * Фоллбек-заголовок из диалога: первая по порядку реплика пользователя **с
 * сигналом задачи** и её первая непустая строка (без markdown, ≤ 60 символов).
 */
function fallbackTitleFromDialogue(
  userMsgs: Message[],
  cfg: Pick<AutoTitleConfig, 'minSignalChars'>,
): string | null {
  for (const message of userMsgs) {
    if (isLowSignalMessage(message.content ?? '', messageHasAttachments(message), cfg)) continue;
    const line = titleLineFromContent(message.content ?? '');
    if (line) return line;
  }
  return null;
}
