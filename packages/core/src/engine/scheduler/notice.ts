import type { SynthEvent } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ContextConfig } from '../context/config.js';

/**
 * AD-051: готовит notice планировщика для cron-события: читает сессию, берёт её
 * язык (`session.settings.language`, fallback `ru`), загружает системный шаблон
 * `prompts/system/SCHEDULER.{lang}.md` и подставляет имя расписания в `{name}`
 * (fallback на `payload.scheduleId`).
 *
 * Возвращает `undefined` для не-cron событий и когда шаблон пуст/не найден —
 * вызывающий код тогда формирует сообщение без notice (поведение прежнее).
 */
export async function buildSchedulerNotice(
  sessionManager: SessionManager,
  contextConfig: ContextConfig,
  sessionId: string,
  event: SynthEvent,
): Promise<string | undefined> {
  if (event.source !== 'cron') return undefined;

  const session = await sessionManager.getSession(sessionId).catch(() => null);
  const language = session?.settings?.language ?? 'ru';

  const template = contextConfig.getSchedulerNotice(language);
  if (!template) return undefined;

  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as { name?: unknown; scheduleId?: unknown })
      : {};
  const name =
    typeof payload.name === 'string' && payload.name
      ? payload.name
      : typeof payload.scheduleId === 'string'
        ? payload.scheduleId
        : '';

  // Файл-ассет читается с завершающим переводом строки — обрезаем, иначе при
  // склейке с текстом задания (`notice + '\n\n' + text`) получалось бы три `\n`.
  return template.trimEnd().split('{name}').join(name);
}
