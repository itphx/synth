/**
 * ADR-115 §«Провайдеры и gateway»: гидратация вложений сообщений.
 *
 * В истории сессии вложение — это **ссылка** на blob (`part.data.blobPath`),
 * байтов в сообщении нет (том, ADR-116). Провайдеру же нужны сами байты в
 * base64, поэтому прямо перед сборкой запроса ссылки превращаются в
 * `LLMAttachment[]` (`mime` + `name?` + `base64`).
 *
 * Правила:
 *  - сообщения сопоставляются с исходной историей **по индексу** (порядок
 *    тот же, что отфильтровал `sessionMessagesToLlm`);
 *  - вложения собираются **только** из реплик пользователя (`MessageRole.USER`):
 *    медиа в assistant-сообщении — исходящее (для шлюзов/UI через
 *    `stream.done.attachments`), в контекст провайдера оно не идёт — часть
 *    провайдеров (OpenAI) вложения ассистента отвергает. Такие части
 *    пропускаются полностью: без LLM-вложения, без `derive`, без блока
 *    «не доставлено» и без `debug.attachmentsDropped` (в лимит объёма тоже
 *    не попадают);
 *  - вложения, модальность которых модель **точно** не принимает, не
 *    отправляются: в лог уходит сводка, а на сообщении остаётся пометка
 *    `reason: 'modality'`. Модальности модели неизвестны (`options.modalities`
 *    не задан — справочника в ядре нет, каталог провайдера их не сообщил) —
 *    фильтра нет: вложения отправляются как есть, ошибку непринятого типа
 *    вернёт провайдер (тихая потеря вложения недопустима);
 *  - ADR-115 §«Модели обработки по модальностям»: если модальность не принята,
 *    но задан `options.derive` (aux-модель семейства), вложение уходит ей, а в
 *    `content` сообщения дописывается текстовый результат (`[image: name]` +
 *    текст). Байты модели сессии при этом не отправляются; ошибка/пустой
 *    результат aux-вызова → прежний путь (`reason: 'modality'` + путь в
 *    workspace). Модель сессии не меняется — она вообще не участвует в aux-
 *    вызове. **Модальности неизвестны, но aux-модель назначена** — derive тоже
 *    пробуем (сравнивать не с чем, и провайдер может молча выкинуть тип —
 *    например, Anthropic не принимает audio): успех — текст вместо байтов,
 *    неудача — прежнее поведение (нативно, решает провайдер). При **известной
 *    поддерживаемой** модальности derive не вызывается никогда;
 *  - ADR-115: `video`-модальность доставляет **только кадры** — аудиодорожка
 *    файла модели не доходит. Если модель принимает `video`, но не `audio`, а
 *    задан `options.deriveVideoAudio` (aux-модель аудио), дорожка расшифровывается
 *    и текст дописывается блоком `[video-audio: <name>]` рядом с видео; само
 *    видео уходит нативно. Не задано/не удалось — прежнее поведение;
 *  - суммарный объём base64 ограничен (`MAX_ATTACHMENT_BASE64_BYTES`): при
 *    превышении отбрасываются **самые старые** вложения (с начала истории), а
 *    на сообщении остаётся пометка `reason: 'limit'` — промпт не ломается.
 *    Гидратация идёт тремя фазами: A — решения по метаданным (модальность,
 *    транспорт, `derive`, `compress`), без чтения байтов; B — бюджет base64 от
 *    самых новых к старым по оценке `ceil(size/3)*4`; C — чтение и кодирование
 *    только выбранных. Так на длинной медиа-истории в памяти не оказываются
 *    все вложения сразу;
 *  - ошибка чтения объекта → вложение помечается `reason: 'unavailable'` и
 *    пропускается (в `content` уже есть плейсхолдер `[image: …]`), ход не падает;
 *  - ADR-115 §«Приватность»: в blob лежит **оригинал**, а провайдеру уходят
 *    очищенные байты — `stripMetadata` (JPEG/PNG) применяется здесь, на границе
 *    отправки; остальные форматы идут как есть;
 *  - каждое отброшенное вложение видно **модели**: к `content` LLM-сообщения
 *    дописывается один блок `[ATTACHMENTS NOT DELIVERED]` со списком (только в
 *    LLM-сообщение, сохранённая история сессии не меняется) — иначе модель
 *    видит лишь плейсхолдер и пытается искать файл на диске. Текст блока —
 *    шаблон `prompts/system/ATTACHMENTS_DROPPED.{lang}.md` (`options.noticeTemplate`);
 *    шаблона нет — короткая техническая строка на английском (канал LLM, ADR-041);
 *  - если `options.materialize` умеет положить файл в рабочий каталог проекта,
 *    в строке появляется `; path: <путь>`: модель может прочитать файл
 *    инструментами (ADR-115, «решение 2026-10-27»);
 *  - входные `messages` не мутируются — возвращаются новые объекты.
 */

import type { Readable } from 'node:stream';
import {
  attachmentsConfigSchema,
  MessageRole,
  type AttachmentFamily,
  type AttachmentModality,
  type MediaPartData,
  type Message,
} from '@itphx/synth-shared';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import {
  attachmentModalityOf,
  type LLMAttachment,
  type LLMMessage,
} from '../../providers/base.js';
import { AttachmentService } from './service.js';
import { stripMetadata } from './strip-metadata.js';

/** Предел суммарного base64-объёма вложений в одном запросе (20 МиБ). */
export const MAX_ATTACHMENT_BASE64_BYTES = 20 * 1024 * 1024;

/** Метаданные вложения, нужные гидратации (без байтов). */
export interface HydrateAttachmentMeta {
  mime: string;
  size: number;
  sha256: string;
  name?: string;
  /** Ширина/высота кадра из sidecar (ADR-115: порог сжатия по размерам). */
  width?: number;
  height?: number;
  /** Длительность медиа (мс) из sidecar. */
  durationMs?: number;
}

/** Порты чтения вложений (в продакшне — поверх `AttachmentService`). */
export interface HydrateDeps {
  resolve(blobPath: string): Promise<HydrateAttachmentMeta | null>;
  read(blobPath: string): Promise<Buffer | null>;
}

/** Причина отброса вложения. */
export type AttachmentDropReason = 'limit' | 'modality' | 'unavailable';

/** Ссылка на отброшенное вложение для материализации в workspace. */
export interface DroppedAttachmentRef {
  name?: string;
  mime: string;
  blobPath: string;
  reason: AttachmentDropReason;
}

/** Опции гидратации. */
export interface HydrateOptions {
  /**
   * Модальности модели из её конфига (`ModelConfig.modalities`). Не задано
   * (или пусто) — модальности неизвестны, фильтра нет: отправляются все
   * поддержанные типы.
   */
  modalities?: readonly AttachmentModality[];
  /**
   * ADR-115: может ли провайдер хода принять вложение с таким MIME нативно
   * (`supportsNativeAudio` / `supportsNativeVideo`). Аудио-контейнеры и видео
   * зависят от протокола: RouterAI принимает `video_url`, официальный
   * OpenAI/Anthropic — нет (там видео идёт кадрами через aux). Предикат `false`
   * → aux/derive или явный drop, без тихой потери.
   */
  canDeliverNative?: (mime: string) => boolean;
  /** Предел суммарного base64 (по умолчанию `MAX_ATTACHMENT_BASE64_BYTES`). */
  maxTotalBase64Bytes?: number;
  /** Лог предупреждений (по умолчанию — молча). */
  log?: (message: string) => void;
  /**
   * ADR-115: шаблон блока «вложения не доставлены» из
   * `prompts/system/ATTACHMENTS_DROPPED.{lang}.md` (`{items}` — список строк
   * `- {name} ({mime}) — {reason}`; `{model}`/`{modalities}` — текущая модель и
   * её модальности). Пусто/не задан — короткая техническая строка на английском
   * (канал LLM, ADR-041).
   */
  noticeTemplate?: string;
  /**
   * ADR-115: подпись модели сессии для блока «вложения не доставлены»
   * (`provider/model`). Не задана — в плейсхолдер `{model}` уходит `—`.
   */
  modelLabel?: string;
  /**
   * ADR-115: модальности модели сессии для блока «вложения не доставлены»
   * (плейсхолдер `{modalities}`). Не заданы/пусто — `—`.
   */
  modelModalities?: readonly string[];
  /**
   * ADR-115 §«Модели обработки по модальностям»: обработка вложения aux-моделью
   * семейства. Вызывается, когда модальность вложения **точно** не входит в
   * модальности модели, а также когда модальности модели **неизвестны** (тогда
   * сравнить не с чем, и провайдер может молча выкинуть тип). Успех (непустой
   * текст) — вложение не отправляется, текст дописывается в `content`;
   * `null`/ошибка — прежний путь (`reason: 'modality'` + материализация для
   * известной неподдерживаемой модальности, нативная отправка для неизвестных).
   * Не задан — derive не выполняется.
   */
  derive?: (input: {
    blobPath: string;
    mime: string;
    name?: string;
    family: AttachmentFamily;
  }) => Promise<string | null>;
  /**
   * ADR-115: транскрипт аудиодорожки видео. Вызывается, когда модель принимает
   * `video`, но не `audio` (провайдер доставляет только кадры): дорожка
   * извлекается `ffmpeg` и уходит aux-модели аудио, а текст дописывается в
   * `content` блоком `[video-audio: <name>]`. Видео при этом уходит нативно.
   * `null`/ошибка/не задан — прежнее поведение (без транскрипта), ход не падает.
   */
  deriveVideoAudio?: (input: {
    blobPath: string;
    mime: string;
    name?: string;
  }) => Promise<string | null>;
  /**
   * ADR-115: сжатие вложения **перед отправкой** (оригинал в blob не меняется).
   * Вызывается только на нативном пути — после проверок модальности/транспорта
   * и до чтения байтов; aux-derive и assistant-сообщения сжатия не касаются.
   * `null`/ошибка — отправляем оригинал (оптимизация не должна ломать ход).
   */
  compress?: (input: {
    blobPath: string;
    mime: string;
    family: 'image' | 'video' | 'audio';
    size: number;
    width?: number;
    height?: number;
  }) => Promise<{ blobPath: string; mime: string; size: number; name?: string } | null>;
  /**
   * ADR-115: материализация отброшенного вложения в рабочий каталог проекта —
   * возвращает путь относительно workspace (или `null`). Ошибка/отсутствие
   * workspace не мешают ходу: строка просто останется без пути.
   */
  materialize?: (ref: DroppedAttachmentRef) => Promise<string | null>;
}

/** Медиа-типы частей сообщения (только они несут вложение). */
const MEDIA_PART_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'video', 'file']);

/** Вложение, отброшенное при гидратации (пометка в `debug`). */
interface DroppedAttachment {
  mime: string;
  name?: string;
  /** Размер в байтах; `0` — объект не читался (модальность/ошибка отсекли раньше). */
  sizeBytes: number;
  /**
   * `limit` — превышен суммарный объём base64;
   * `modality` — модель не принимает такую модальность вложения;
   * `unavailable` — объект не прочитан (нет, битый, порт вернул `null`/ошибку).
   */
  reason: AttachmentDropReason;
}

/** Отброшенное вложение + путь объекта (нужен для материализации). */
interface DroppedEntry {
  drop: DroppedAttachment;
  blobPath: string;
  /** Относительный путь материализованной копии (`null` — не сохранили). */
  path: string | null;
}

/** Вложение, обработанное aux-моделью: текст вместо байтов (ADR-115). */
interface DerivedEntry {
  /** Семейство вложения (`image`/`pdf`/`audio`/`video`) — префикс блока. */
  family: AttachmentFamily;
  /**
   * Заголовок блока вместо семейства (`video-audio` — транскрипт дорожки
   * видео).
   */
  label?: string;
  name?: string;
  /** Текст результата — как есть, без экранирования. */
  text: string;
}

/**
 * Строка списка отброшенных вложений: `- {name} ({mime}) — {reason}`;
 * `name` неизвестно — только `{mime}`. Материализованный файл — `; path: …`.
 */
function dropLine(entry: DroppedEntry): string {
  const { drop } = entry;
  const target = drop.name ? `${drop.name} (${drop.mime})` : drop.mime;
  const line = `- ${target} — ${drop.reason}`;
  return entry.path ? `${line}; path: ${entry.path}` : line;
}

/**
 * Техническая строка на случай, когда шаблона нет (файла prompts нет/он пуст).
 * Английский — канал LLM (ADR-041); формат — как у прежней пометки.
 */
function fallbackLine(entry: DroppedEntry): string {
  const { drop } = entry;
  const target = drop.name ? `${drop.name} (${drop.mime})` : drop.mime;
  const line = `[attachment not delivered: ${target} — ${drop.reason}]`;
  return entry.path ? `${line}; path: ${entry.path}` : line;
}

/** Блок для `content` LLM-сообщения: шаблон с `{items}` либо fallback-строки. */
function dropsBlock(
  entries: readonly DroppedEntry[],
  noticeTemplate: string | undefined,
  modelLabel: string | undefined,
  modelModalities: readonly string[] | undefined,
): string {
  const items = entries.map(dropLine).join('\n');
  const template = noticeTemplate ?? '';
  if (template.trim().length === 0) return entries.map(fallbackLine).join('\n');
  // split/join — подстановка без интерпретации `$`-паттернов в именах файлов.
  // `{model}`/`{modalities}` подставляются до `{items}`: имена файлов могут
  // содержать фигурные скобки, и подстановка по ним уже не должна прогоняться.
  const model = modelLabel && modelLabel.trim() !== '' ? modelLabel : '—';
  const modalities = modelModalities && modelModalities.length > 0
    ? modelModalities.join(', ')
    : '—';
  return template
    .split('{model}').join(model)
    .split('{modalities}').join(modalities)
    .split('{items}').join(items);
}

/**
 * Блоки производного текста для `content` (ADR-115): каждый — с пустой строки,
 * `[<family|label>: <name>]` (без имени — `[<family|label>]`) и текстом как есть.
 */
function derivedBlocks(entries: readonly DerivedEntry[]): string {
  return entries
    .map((entry) => {
      const label = entry.label ?? entry.family;
      return `\n\n[${label}${entry.name ? `: ${entry.name}` : ''}]\n${entry.text}`;
    })
    .join('');
}

/** Ссылка на вложение в истории сообщения. */
interface MediaPartRef {
  blobPath: string;
  mime: string;
  name?: string;
}

/**
 * Сообщения, которые `sessionMessagesToLlm` отдаёт модели (зеркало его
 * фильтра): по одному `LLMMessage` на каждое такое сообщение.
 */
function includedSourceMessages(source: readonly Message[]): Message[] {
  return source.filter((message) => {
    if (message.disabled || message.hidden) return false;
    if (message.role === MessageRole.INFO) return false;
    if (message.role === MessageRole.ASSISTANT && message.metadata?.status === 'error') return false;
    return true;
  });
}

/** Ссылки на вложения в частях сообщения (в порядке частей). */
function mediaPartRefs(message: Message): MediaPartRef[] {
  const parts = message.parts ?? [];
  const refs: MediaPartRef[] = [];
  for (const part of parts) {
    if (!MEDIA_PART_TYPES.has(part.type)) continue;
    const data = part.data as Partial<MediaPartData> | undefined;
    if (!data || typeof data.blobPath !== 'string' || typeof data.mime !== 'string') continue;
    refs.push({
      blobPath: data.blobPath,
      mime: data.mime,
      ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}),
    });
  }
  return refs;
}

/**
 * Модальность вложения, пересылаемая байтами: `text` (его содержимое уже в
 * `content`) и неизвестные типы не отправляются и «отброшенными» не считаются.
 */
function byteModality(mime: string): AttachmentFamily | null {
  const modality = attachmentModalityOf(mime);
  return modality !== null && modality !== 'text' ? modality : null;
}

/**
 * Кандидат на отправку (фаза A): всё уже решено по метаданным, байтов нет.
 * `readPath` — что читать в фазе C (сжатая копия или оригинал).
 */
interface HydrationCandidate {
  messageIndex: number;
  /** Исходный путь вложения (для пометок и материализации). */
  blobPath: string;
  /** Что читать: сжатая копия (`compress`) либо оригинал. */
  readPath: string;
  /** MIME и имя отправляемого объекта (сжатого либо оригинала). */
  mime: string;
  name?: string;
  /** MIME/имя исходной части — для отказа чтения (паритет прежнего поведения). */
  partMime: string;
  partName?: string;
  /** Размер отправляемого объекта, байт (`0` — неизвестен). */
  sizeBytes: number;
  /** Оценка base64-объёма (`Math.ceil(size/3)*4`) — без чтения байтов. */
  estimate: number;
}

/**
 * Оценка длины base64 по размеру байтов (без чтения самого объекта):
 * каждый блок из 3 байт даёт 4 символа. Оценка сверху — `stripMetadata`
 * может только уменьшить объект.
 */
function base64Estimate(size: number): number {
  return size > 0 ? Math.ceil(size / 3) * 4 : 0;
}

/** Поток в буфер (порт `readStream` отдаёт `Readable`). */
async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Гидратация вложений в истории запроса.
 *
 * @param messages уже собранные LLM-сообщения (`sessionMessagesToLlm`)
 * @param source   сообщения сессии в том же порядке (до маппинга)
 * @param deps     порты чтения blob-объектов
 * @param options  модальности модели и предел объёма
 */
export async function hydrateMessageAttachments(
  messages: LLMMessage[],
  source: readonly Message[],
  deps: HydrateDeps,
  options: HydrateOptions = {},
): Promise<LLMMessage[]> {
  const included = includedSourceMessages(source);
  const maxTotal = options.maxTotalBase64Bytes ?? MAX_ATTACHMENT_BASE64_BYTES;
  // Модальности неизвестны (не заданы или пусты) — фильтра нет: вложение,
  // которое модель не примет, отклонит провайдер (ошибка видна пользователю).
  const allowedModalities = options.modalities && options.modalities.length > 0
    ? new Set<AttachmentModality>(options.modalities)
    : null;

  // 1. Фаза A (без чтения байтов): модальность/транспорт/derive, метаданные
  // (`resolve`) и сжатие. Байты здесь не читаются — на длинной медиа-истории
  // это был пик памяти (все вложения сразу в Buffer + base64).
  const candidates: HydrationCandidate[] = [];
  const droppedByMessage = new Map<number, DroppedEntry[]>();
  const derivedByMessage = new Map<number, DerivedEntry[]>();
  let modalityDropped = 0;
  let unavailableDropped = 0;
  let derivedCount = 0;

  /** Пометить вложение, отброшенное при гидратации (в `debug` + лог). */
  const addDrop = (messageIndex: number, blobPath: string, drop: DroppedAttachment): void => {
    const list = droppedByMessage.get(messageIndex) ?? [];
    list.push({ drop, blobPath, path: null });
    droppedByMessage.set(messageIndex, list);
    if (drop.reason === 'modality') modalityDropped += 1;
    if (drop.reason === 'unavailable') unavailableDropped += 1;
  };

  /**
   * ADR-115: обработать вложение aux-моделью вместо отправки байтов.
   *
   * `true` — текст получен (вложение не отправляется, блок попадёт в
   * `content`); `false` — обработка не удалась (вызывающий идёт прежним путём
   * «отброшено + материализация»). Ошибка aux-вызова не роняет ход.
   */
  const tryDerive = async (
    messageIndex: number,
    input: { blobPath: string; mime: string; name?: string; family: AttachmentFamily },
  ): Promise<boolean> => {
    if (!options.derive) return false;
    try {
      const text = await options.derive(input);
      if (typeof text !== 'string' || text.trim() === '') return false;
      const list = derivedByMessage.get(messageIndex) ?? [];
      list.push({
        family: input.family,
        ...(input.name ? { name: input.name } : {}),
        text,
      });
      derivedByMessage.set(messageIndex, list);
      derivedCount += 1;
      options.log?.(
        `[attachments] вложение ${input.blobPath} обработано моделью-обработчиком (${input.family})`,
      );
      return true;
    } catch (err) {
      options.log?.(
        `[attachments] не удалось обработать вложение ${input.blobPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  /**
   * ADR-115: транскрипт аудиодорожки видео (модель принимает `video`, но не
   * `audio` — провайдер доставляет только кадры). Текст дописывается в
   * `content` блоком `[video-audio: <name>]`, видео при этом уходит нативно.
   * `true` — транскрипт получен; `false` — нет (прежнее поведение, ход не падает).
   */
  const tryDeriveVideoAudio = async (
    messageIndex: number,
    input: { blobPath: string; mime: string; name?: string },
  ): Promise<boolean> => {
    if (!options.deriveVideoAudio) return false;
    try {
      const text = await options.deriveVideoAudio(input);
      if (typeof text !== 'string' || text.trim() === '') return false;
      const list = derivedByMessage.get(messageIndex) ?? [];
      list.push({
        family: 'audio',
        label: 'video-audio',
        ...(input.name ? { name: input.name } : {}),
        text,
      });
      derivedByMessage.set(messageIndex, list);
      derivedCount += 1;
      options.log?.(
        `[attachments] аудиодорожка видео ${input.blobPath} расшифрована моделью-обработчиком`,
      );
      return true;
    } catch (err) {
      options.log?.(
        `[attachments] не удалось расшифровать аудиодорожку ${input.blobPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const limit = Math.min(messages.length, included.length);
  for (let index = 0; index < limit; index++) {
    const current = included[index]!;
    // Вложения — только из реплик пользователя: медиа в assistant-сообщении
    // исходящее (для шлюзов/UI через `stream.done.attachments`), в контекст
    // провайдера не идёт — часть провайдеров (OpenAI) вложения ассистента
    // отвергает. Пропускаем роль целиком: ни байтов, ни `derive`, ни пометки
    // «не доставлено», ни записи в `debug`, ни учёта в лимите объёма.
    if (current.role !== MessageRole.USER) continue;
    const refs = mediaPartRefs(current);
    if (refs.length === 0) continue;

    for (const ref of refs) {
      const modality = byteModality(ref.mime);
      if (modality === null) continue;

      const modalityUnsupported = allowedModalities !== null && !allowedModalities.has(modality);
      // Транспорт провайдера может не уметь конкретный контейнер (ogg у
      // Anthropic-протокола), хотя модальность `audio` в каталоге есть.
      const transportUnsupported = (modality === 'audio' || modality === 'video')
        && options.canDeliverNative !== undefined
        && !options.canDeliverNative(ref.mime);
      if (modalityUnsupported || transportUnsupported) {
        // Модальность/формат не приняты: сначала пробуем aux-модель семейства
        // (байты модели сессии не отправляются). Не удалось — отброс.
        const derived = await tryDerive(index, {
          blobPath: ref.blobPath,
          mime: ref.mime,
          ...(ref.name ? { name: ref.name } : {}),
          family: modality,
        });
        if (derived) continue;
        // Байты не читаем — размер неизвестен (0).
        addDrop(index, ref.blobPath, {
          mime: ref.mime,
          ...(ref.name ? { name: ref.name } : {}),
          sizeBytes: 0,
          reason: 'modality',
        });
        continue;
      }
      // Аудио с назначенной aux-моделью обрабатываем всегда (Hermes:
      // явный выбор модели обработки важнее нативного пути — форматы
      // голосовых/записей слишком разнородны). Для остальных модальностей
      // aux применяется, только когда модальности модели неизвестны.
      // Неудача — прежнее поведение (нативно), ход не падает.
      if (options.derive && (modality === 'audio' || allowedModalities === null)) {
        const derived = await tryDerive(index, {
          blobPath: ref.blobPath,
          mime: ref.mime,
          ...(ref.name ? { name: ref.name } : {}),
          family: modality,
        });
        if (derived) continue;
      }
      // ADR-115: `video`-модальность доставляет только кадры — аудиодорожка
      // файла до модели не доходит. Модель принимает `video`, но не `audio`, и
      // назначена aux-модель аудио — извлекаем дорожку и кладём транскрипт рядом
      // с видео (блок `[video-audio: <name>]`). Видео всё равно уходит нативно;
      // неудача/нет aux — прежнее поведение.
      const videoAudioTranscript = modality === 'video'
        && options.deriveVideoAudio !== undefined
        && allowedModalities !== null
        && allowedModalities.has('video')
        && !allowedModalities.has('audio');
      if (videoAudioTranscript) {
        await tryDeriveVideoAudio(index, {
          blobPath: ref.blobPath,
          mime: ref.mime,
          ...(ref.name ? { name: ref.name } : {}),
        });
      }
      try {
        const meta = await deps.resolve(ref.blobPath);
        if (!meta) {
          // Объекта нет/путь не разрешён — модель должна узнать, что вложение
          // не доставлено, иначе пойдёт искать файл на диске.
          addDrop(index, ref.blobPath, {
            mime: ref.mime,
            ...(ref.name ? { name: ref.name } : {}),
            sizeBytes: 0,
            reason: 'unavailable',
          });
          continue;
        }
        const metaModality = byteModality(meta.mime);
        if (metaModality === null) continue;
        const metaTransportUnsupported = (metaModality === 'audio' || metaModality === 'video')
          && options.canDeliverNative !== undefined
          && !options.canDeliverNative(meta.mime);
        if ((allowedModalities && !allowedModalities.has(metaModality)) || metaTransportUnsupported) {
          const name = meta.name ?? ref.name;
          const derived = await tryDerive(index, {
            blobPath: ref.blobPath,
            mime: meta.mime,
            ...(name ? { name } : {}),
            family: metaModality,
          });
          if (derived) continue;
          addDrop(index, ref.blobPath, {
            mime: meta.mime,
            ...(name ? { name } : {}),
            sizeBytes: meta.size,
            reason: 'modality',
          });
          continue;
        }
        // ADR-115: на нативном пути вложение можно сжать перед отправкой
        // (оригинал в blob не меняется). Сжатие — только image/video/audio;
        // pdf уходит как есть. `null`/ошибка → оригинал.
        let readPath = ref.blobPath;
        let sentMime = meta.mime;
        let sentName = meta.name ?? ref.name;
        let sentSize = meta.size;
        if (
          options.compress
          && (metaModality === 'image' || metaModality === 'video' || metaModality === 'audio')
        ) {
          try {
            const compressed = await options.compress({
              blobPath: ref.blobPath,
              mime: meta.mime,
              family: metaModality,
              size: meta.size,
              ...(meta.width !== undefined ? { width: meta.width } : {}),
              ...(meta.height !== undefined ? { height: meta.height } : {}),
            });
            if (compressed) {
              readPath = compressed.blobPath;
              sentMime = compressed.mime;
              sentName = compressed.name ?? sentName;
              sentSize = compressed.size;
              options.log?.(
                `[attachments] вложение ${ref.blobPath} сжато: ${meta.size} → ${compressed.size} байт (${compressed.mime})`,
              );
            }
          } catch (err) {
            options.log?.(
              `[attachments] сжатие ${ref.blobPath} не удалось: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        // Байты на этой фазе не читаются: бюджет base64 считается по
        // метаданным (для сжатой копии — по её размеру), а чтение идёт только
        // для вложений, выбранных бюджетом (фаза C).
        candidates.push({
          messageIndex: index,
          blobPath: ref.blobPath,
          readPath,
          mime: sentMime,
          ...(sentName ? { name: sentName } : {}),
          partMime: ref.mime,
          ...(ref.name ? { partName: ref.name } : {}),
          sizeBytes: sentSize > 0 ? sentSize : 0,
          estimate: base64Estimate(sentSize),
        });
      } catch (err) {
        // Битый объект не должен ломать ход: плейсхолдер в `content` уже есть,
        // а модели уходит пометка, что вложение не доставлено.
        options.log?.(
          `[attachments] не удалось прочитать вложение ${ref.blobPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        addDrop(index, ref.blobPath, {
          mime: ref.mime,
          ...(ref.name ? { name: ref.name } : {}),
          sizeBytes: 0,
          reason: 'unavailable',
        });
      }
    }
  }

  // Вложения, отсечённые модальностью, не теряются молча: в лог — сводка,
  // в `debug.attachmentsDropped` — запись с причиной (для отладки).
  if (modalityDropped > 0) {
    options.log?.(
      `[attachments] отброшено вложений: ${modalityDropped} (причина: modality — модель не принимает такой тип)`,
    );
  }
  if (unavailableDropped > 0) {
    options.log?.(
      `[attachments] отброшено вложений: ${unavailableDropped} (причина: unavailable — объект недоступен)`,
    );
  }
  if (derivedCount > 0) {
    options.log?.(
      `[attachments] обработано вложений моделью-обработчиком: ${derivedCount} (текст добавлен в сообщение)`,
    );
  }

  if (candidates.length === 0 && droppedByMessage.size === 0 && derivedByMessage.size === 0) {
    return messages;
  }

  // 2. Фаза B — бюджет base64: идём от **самых новых** вложений к старым и
  // набираем, пока оценка влезает (`estimate = ceil(size/3)*4`, по метаданным,
  // без чтения байтов). Как только очередное (более старое) вложение не
  // влезает, дальше не идём: отбрасываются оно и все более старые —
  // `reason:'limit'`. Порядок итоговой выдачи остаётся хронологическим.
  let keptFrom = candidates.length;
  let totalEstimate = 0;
  for (let position = candidates.length - 1; position >= 0; position--) {
    const estimate = candidates[position]!.estimate;
    if (totalEstimate + estimate > maxTotal) break;
    totalEstimate += estimate;
    keptFrom = position;
  }

  // 3. Фаза C — читаем и кодируем ТОЛЬКО выбранные (в хронологическом
  // порядке частей). `stripMetadata` — как раньше, на границе отправки.
  const attachmentsByMessage = new Map<number, LLMAttachment[]>();

  for (let position = 0; position < candidates.length; position++) {
    const candidate = candidates[position]!;
    if (position < keptFrom) {
      addDrop(candidate.messageIndex, candidate.blobPath, {
        mime: candidate.mime,
        ...(candidate.name ? { name: candidate.name } : {}),
        sizeBytes: candidate.sizeBytes,
        reason: 'limit',
      });
      continue;
    }
    let bytes: Buffer | null;
    try {
      bytes = await deps.read(candidate.readPath);
    } catch (err) {
      // Битый объект не должен ломать ход: плейсхолдер в `content` уже есть,
      // а модели уходит пометка, что вложение не доставлено.
      options.log?.(
        `[attachments] не удалось прочитать вложение ${candidate.blobPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      addDrop(candidate.messageIndex, candidate.blobPath, {
        mime: candidate.partMime,
        ...(candidate.partName ? { name: candidate.partName } : {}),
        sizeBytes: 0,
        reason: 'unavailable',
      });
      continue;
    }
    if (!bytes) {
      addDrop(candidate.messageIndex, candidate.blobPath, {
        mime: candidate.mime,
        ...(candidate.name ? { name: candidate.name } : {}),
        sizeBytes: candidate.sizeBytes,
        reason: 'unavailable',
      });
      continue;
    }
    const list = attachmentsByMessage.get(candidate.messageIndex) ?? [];
    list.push({
      mime: candidate.mime,
      ...(candidate.name ? { name: candidate.name } : {}),
      // ADR-115 §«Приватность»: провайдеру — байты без EXIF/метаданных,
      // blob не меняется (там оригинал).
      base64: stripMetadata(bytes, candidate.mime).toString('base64'),
    });
    attachmentsByMessage.set(candidate.messageIndex, list);
  }

  // 4. Материализация отброшенного в рабочем каталоге (ADR-115): файл не
  // отправлен модели, но пользователь его приложил — путь даёт доступ тулами.
  // Ошибка материализации не мешает ходу: строка останется без пути.
  if (options.materialize && droppedByMessage.size > 0) {
    for (const entries of droppedByMessage.values()) {
      for (const entry of entries) {
        try {
          entry.path = await options.materialize({
            ...(entry.drop.name ? { name: entry.drop.name } : {}),
            mime: entry.drop.mime,
            blobPath: entry.blobPath,
            reason: entry.drop.reason,
          });
        } catch (err) {
          entry.path = null;
          options.log?.(
            `[attachments] не удалось сохранить вложение ${entry.blobPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  return messages.map((message, index) => {
    const attachments = attachmentsByMessage.get(index);
    const dropped = droppedByMessage.get(index);
    const derived = derivedByMessage.get(index);
    if (
      (!attachments || attachments.length === 0)
      && (!dropped || dropped.length === 0)
      && (!derived || derived.length === 0)
    ) {
      return message;
    }

    const next: LLMMessage = { ...message };
    if (attachments && attachments.length > 0) next.attachments = attachments;
    let content = message.content;
    // ADR-115: производный текст — вместо байтов вложения (модель сессии его
    // не принимает): блоки идут в порядке частей сообщения.
    if (derived && derived.length > 0) content = `${content}${derivedBlocks(derived)}`;
    if (dropped && dropped.length > 0) {
      // Модель должна видеть, что вложение не доставлено и почему: иначе
      // плейсхолдер `[file: …]` толкает её искать файл на диске. Один блок на
      // сообщение (даже если отброшено несколько), порядок — как в обработке
      // (модальность по частям, затем лимит объёма).
      content = `${content}\n\n${dropsBlock(dropped, options.noticeTemplate, options.modelLabel, options.modelModalities)}`;
    }
    if (content !== message.content) next.content = content;

    const debugExtra: Record<string, unknown> = {};
    if (dropped && dropped.length > 0) {
      const previous = Array.isArray(message.debug?.attachmentsDropped)
        ? (message.debug!.attachmentsDropped as DroppedAttachment[])
        : [];
      debugExtra.attachmentsDropped = [...previous, ...dropped.map((entry) => entry.drop)];
    }
    if (derived && derived.length > 0) {
      const previous = typeof message.debug?.attachmentsDerived === 'number'
        ? (message.debug!.attachmentsDerived as number)
        : 0;
      debugExtra.attachmentsDerived = previous + derived.length;
    }
    if (Object.keys(debugExtra).length > 0) {
      next.debug = { ...(message.debug ?? {}), ...debugExtra };
    }
    return next;
  });
}

/**
 * `HydrateDeps` поверх порта blob-хранилища.
 *
 * Переиспользует `AttachmentService` (единственная точка чтения объектов
 * вложений: containment `attachments/`, sidecar-метаданные, фоллбек по сигнатуре).
 * Конфиг сервиса для чтения не используется — берутся дефолты схемы.
 */
export function createHydrateDeps(blobs: BlobStore): HydrateDeps {
  const service = new AttachmentService({
    blobs,
    config: attachmentsConfigSchema.parse({}),
  });
  return {
    resolve: async (blobPath) => {
      try {
        const resolved = await service.resolve(blobPath);
        if (!resolved) return null;
        return {
          mime: resolved.mime,
          size: resolved.size,
          sha256: resolved.sha256,
          ...(resolved.name ? { name: resolved.name } : {}),
          ...(resolved.width !== undefined ? { width: resolved.width } : {}),
          ...(resolved.height !== undefined ? { height: resolved.height } : {}),
          ...(resolved.durationMs !== undefined ? { durationMs: resolved.durationMs } : {}),
        };
      } catch {
        return null;
      }
    },
    read: async (blobPath) => {
      try {
        const stream = await service.read(blobPath);
        if (!stream) return null;
        return await readStreamToBuffer(stream);
      } catch {
        return null;
      }
    },
  };
}
