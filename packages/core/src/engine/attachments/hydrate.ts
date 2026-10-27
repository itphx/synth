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
 *  - суммарный объём base64 ограничен (`MAX_ATTACHMENT_BASE64_BYTES`): при
 *    превышении отбрасываются **самые старые** вложения (с начала истории), а
 *    на сообщении остаётся пометка `reason: 'limit'` — промпт не ломается;
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
   * ADR-115: может ли провайдер хода принять аудиофайл с таким MIME нативно
   * (предикат `supportsNativeAudio`). `false` — формат транспортом не
   * поддерживается (напр. ogg для Anthropic-протокола): вложение идёт через
   * aux-модель или помечается недоставленным, а не теряется молча.
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
 * `[<family>: <name>]` (без имени — `[<family>]`) и текстом как есть.
 */
function derivedBlocks(entries: readonly DerivedEntry[]): string {
  return entries
    .map((entry) => `\n\n[${entry.family}${entry.name ? `: ${entry.name}` : ''}]\n${entry.text}`)
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

  // 1. Читаем все допустимые вложения в хронологическом порядке.
  const candidates: Array<{
    messageIndex: number;
    attachment: LLMAttachment;
    sizeBytes: number;
    blobPath: string;
  }> = [];
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
      const transportUnsupported = modality === 'audio'
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
        const metaTransportUnsupported = metaModality === 'audio'
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
        const bytes = await deps.read(ref.blobPath);
        if (!bytes) {
          addDrop(index, ref.blobPath, {
            mime: meta.mime,
            ...(meta.name ?? ref.name ? { name: meta.name ?? ref.name } : {}),
            sizeBytes: meta.size,
            reason: 'unavailable',
          });
          continue;
        }
        candidates.push({
          messageIndex: index,
          attachment: {
            mime: meta.mime,
            ...(meta.name ?? ref.name ? { name: meta.name ?? ref.name } : {}),
            // ADR-115 §«Приватность»: провайдеру — байты без EXIF/метаданных,
            // blob не меняется (там оригинал).
            base64: stripMetadata(bytes, meta.mime).toString('base64'),
          },
          sizeBytes: meta.size > 0 ? meta.size : bytes.length,
          blobPath: ref.blobPath,
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

  // 2. Лимит объёма: отбрасываем самые старые вложения (с начала истории).
  const totalBase64 = candidates.reduce((sum, item) => sum + item.attachment.base64.length, 0);
  let droppedCount = 0;
  if (totalBase64 > maxTotal) {
    let remaining = totalBase64;
    while (droppedCount < candidates.length && remaining > maxTotal) {
      remaining -= candidates[droppedCount]!.attachment.base64.length;
      droppedCount += 1;
    }
  }

  // 3. Сборка результата без мутации входа.
  const attachmentsByMessage = new Map<number, LLMAttachment[]>();

  candidates.forEach((candidate, position) => {
    if (position < droppedCount) {
      addDrop(candidate.messageIndex, candidate.blobPath, {
        mime: candidate.attachment.mime,
        ...(candidate.attachment.name ? { name: candidate.attachment.name } : {}),
        sizeBytes: candidate.sizeBytes,
        reason: 'limit',
      });
      return;
    }
    const list = attachmentsByMessage.get(candidate.messageIndex) ?? [];
    list.push(candidate.attachment);
    attachmentsByMessage.set(candidate.messageIndex, list);
  });

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
