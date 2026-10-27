/**
 * ADR-101 × ADR-115: вложения прогона пайплайна.
 *
 * Прогон — не сессия (ADR-101 §1), но вход у него такой же «человеческий»:
 * файлы, приложенные к запуску (документ, картинка, расшифровка), и объекты-
 * артефакты предыдущих шагов. Байты в прогоне **не хранятся**: и вложения, и
 * артефакты — объекты blob-хранилища (ADR-116), а прогон носит только ссылки
 * (`blobPath` + метаданные).
 *
 * ## Что здесь живёт
 *
 * 1. **Проверка ссылок входа прогона** (`validatePipelineAttachments`) — до
 *    старта прогона, ровно теми же правилами, что приём внешнего события
 *    (ADR-089, `engine/events/ingest.ts`): контур `attachments/`, объект
 *    существует, `sha256`/`mime`/`size` совпадают со sidecar объекта, лимиты
 *    `attachments.maxFilesPerMessage` / `maxBytesPerFile` / `maxBytesPerSession`.
 *    Без сервиса вложений или порта ссылок — fail-closed: иначе в прогон
 *    можно было бы подставить ссылку на несуществующий/чужой объект.
 * 2. **Сбор ссылок для шага** (`collectStepAttachmentRefs`): вход прогона
 *    (`trigger.payload.attachments`), значения маппинга шага (`ctx.input`) и
 *    артефакты предыдущего шага с `kind: 'blob'` (ADR-116).
 * 3. **Гидратация для agent-шага** (`hydrateStepAttachments`) — **тот же**
 *    путь, что у сессий: `hydrateMessageAttachments` (ADR-115). Поэтому
 *    автоматически работают очистка метаданных (`stripMetadata`), лимит
 *    суммарного base64 (`MAX_ATTACHMENT_BASE64_BYTES`), фильтр модальностей
 *    модели шага, обработка aux-моделью (`derive`) и блок-пометка
 *    «вложения не доставлены» в тексте шага.
 * 4. **Обработка вложения aux-моделью** (`createPipelineAttachmentDerive`) —
 *    фабрика derive для text-only моделей шага: настройка та же, что у сессий
 *    (`attachments.modalityModels`), вызов — только через `GatewayProvider`
 *    (ADR-036), которую передаёт точка сборки.
 *
 * ## Почему hydrate, а не свой base64-цикл
 *
 * Своя сборка `LLMAttachment` разошлась бы с сессиями: пропали бы очистка
 * метаданных на границе отправки, фильтр модальностей, лимит объёма и
 * пометки модели. Шаг передаёт гидратации **синтетическое user-сообщение** с
 * медиа-частями (ссылки) и получает обратно готовое LLM-сообщение.
 *
 * ## Чего здесь нет
 *
 * Материализации отброшенных вложений в workspace проекта (в сессиях —
 * `attachments.workspaceFallback`): у шага она не запрошена, при отбросе
 * модель видит только причину. GC объектов — общий (ADR-115): ссылки
 * прогона регистрируются в `blob_refs` (`ownerKind: 'pipeline-run'`).
 */

import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  isBlobPipelineArtifact,
  makeMediaPart,
  makeTextPart,
  MessageRole,
  nowISO,
  type AttachmentFamily,
  type AttachmentModality,
  type AttachmentsConfig,
  type EventAttachmentRef,
  type Message,
  type PipelineArtifact,
} from '@itphx/synth-shared';

import type { LLMAttachment, BaseProvider, LLMMessage } from '../../providers/base.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import { deriveModalityText } from '../attachments/derive.js';
import {
  hydrateMessageAttachments,
  type HydrateDeps,
} from '../attachments/hydrate.js';
import { isAttachmentPath, partTypeOf, type AttachmentService } from '../attachments/service.js';
import { stripMetadata } from '../attachments/strip-metadata.js';
import { isPipelineArtifactPath } from './artifacts.js';
import type { PipelineStepAttachments, StepExecutionContext } from './types.js';

/**
 * Ссылка на вложение прогона — та же форма, что у вложения внешнего события
 * (ADR-115 × ADR-089): путь объекта + его метаданные для сверки со sidecar.
 */
export type PipelineAttachmentRef = EventAttachmentRef;

/**
 * Жёсткий предел числа вложений в прогоне, если сервис вложений не передан
 * (нет доступа к `attachments.maxFilesPerMessage`). Значение — как у события
 * (`EVENT_ATTACHMENTS_MAX_FILES`, ADR-089).
 */
export const PIPELINE_ATTACHMENTS_MAX_FILES = 10;

/** Предел глубины обхода значения входа шага при поиске ссылок. */
const MAX_INPUT_WALK_DEPTH = 4;

/** Причина отказа во вложениях прогона (роут отдаёт 400 `VALIDATION_ERROR`). */
export type PipelineAttachmentErrorReason =
  | 'attachments_unavailable'
  | 'too_many'
  | 'invalid_path'
  | 'not_found'
  | 'metadata_mismatch'
  | 'too_large';

/** Вложения прогона не прошли проверку — прогон **не** стартует. */
export class PipelineAttachmentError extends Error {
  constructor(
    readonly reason: PipelineAttachmentErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineAttachmentError';
  }
}

/**
 * Проверить ссылки на вложения входа прогона (ADR-115 × ADR-101).
 *
 * Правила — паритет с приёмом внешнего события (ADR-089):
 * - без сервиса вложений или порта ссылок — `attachments_unavailable`
 *   (fail-closed: без сверки со sidecar ссылку можно подменить);
 * - число ≤ `attachments.maxFilesPerMessage` (`too_many`);
 * - путь — только внутри `attachments/` (`invalid_path`, контур ADR-115);
 * - объект существует (`not_found`) и его `sha256`/`mime`/`size` совпадают со
 *   sidecar (`metadata_mismatch`);
 * - размер файла ≤ `maxBytesPerFile`, сумма ≤ `maxBytesPerSession`
 *   (`too_large`).
 *
 * Возвращает нормализованные ссылки: метаданные берутся из резолва объекта
 * (объявленные только сверяются) — в прогон попадает достоверная запись.
 */
export async function validatePipelineAttachments(
  service: AttachmentService | undefined,
  blobRefs: BlobRefRepository | undefined,
  refs: readonly PipelineAttachmentRef[] | undefined,
): Promise<PipelineAttachmentRef[]> {
  const list = refs ?? [];
  if (list.length === 0) return [];

  if (!service || !blobRefs) {
    throw new PipelineAttachmentError(
      'attachments_unavailable',
      'Вложения прогона недоступны: не подключён сервис вложений или учёт blob-ссылок',
    );
  }

  const config = service.config;
  const maxFiles = config.maxFilesPerMessage ?? PIPELINE_ATTACHMENTS_MAX_FILES;
  if (list.length > maxFiles) {
    throw new PipelineAttachmentError(
      'too_many',
      `Вложений в прогоне ${list.length} — предел ${maxFiles}`,
    );
  }

  const resolvedRefs: PipelineAttachmentRef[] = [];
  let total = 0;
  for (const [index, attachment] of list.entries()) {
    const blobPath = attachment.blobPath;
    if (!isAttachmentPath(blobPath)) {
      throw new PipelineAttachmentError(
        'invalid_path',
        `attachments[${index}].blobPath вне attachments/: ${blobPath}`,
      );
    }
    const resolved = await service.resolve(blobPath);
    if (!resolved) {
      throw new PipelineAttachmentError(
        'not_found',
        `Вложение ${blobPath} не найдено в хранилище`,
      );
    }
    const declaredSha = attachment.sha256.trim().toLowerCase();
    const declaredMime = attachment.mime.trim().toLowerCase();
    if (resolved.sha256 !== declaredSha) {
      throw new PipelineAttachmentError(
        'metadata_mismatch',
        `attachments[${index}]: sha256 не совпадает с объектом ${blobPath}`,
      );
    }
    if (resolved.mime !== declaredMime) {
      throw new PipelineAttachmentError(
        'metadata_mismatch',
        `attachments[${index}]: mime «${attachment.mime}» не совпадает с объектом (${resolved.mime})`,
      );
    }
    if (resolved.size !== attachment.size) {
      throw new PipelineAttachmentError(
        'metadata_mismatch',
        `attachments[${index}]: size ${attachment.size} не совпадает с объектом (${resolved.size})`,
      );
    }
    if (resolved.size > config.maxBytesPerFile) {
      throw new PipelineAttachmentError(
        'too_large',
        `attachments[${index}]: размер ${resolved.size} Б превышает предел ${config.maxBytesPerFile} Б`,
      );
    }
    total += resolved.size;
    resolvedRefs.push({
      blobPath,
      sha256: resolved.sha256,
      mime: resolved.mime,
      size: resolved.size,
      ...(resolved.name ? { name: resolved.name } : {}),
    });
  }

  if (total > config.maxBytesPerSession) {
    throw new PipelineAttachmentError(
      'too_large',
      `Суммарный объём вложений прогона ${total} Б превышает предел ${config.maxBytesPerSession} Б`,
    );
  }

  return resolvedRefs;
}

/** Ссылка на объект, который шаг может приложить к запросу модели. */
export interface PipelineAttachmentSource {
  /** Путь объекта в blob-хранилище (`attachments/…` или `artifacts/…`). */
  blobPath: string;
  /** MIME-тип содержимого. */
  mime: string;
  /** Размер, байт. */
  size: number;
  /** SHA-256 содержимого (у артефактов может быть неизвестен). */
  sha256?: string;
  /** Имя файла (для подписи/пометок). */
  name?: string;
}

/**
 * Собрать ссылки на вложения для шага (ADR-101 × ADR-115/ADR-116).
 *
 * Источники (в порядке приоритета, дубли по `blobPath` схлопываются):
 * 1. **вход прогона** — `trigger.payload.attachments` (поле `attachments` тела
 *    `POST /projects/:id/pipelines/:pid/runs`): вложения доступны каждому шагу
 *    без отдельного маппинга;
 * 2. **маппинг шага** — значения `ctx.input` (любой путь, отобразивший ссылку
 *    вложения или артефакт `kind: 'blob'`), обход ограничен глубиной;
 * 3. **артефакты предыдущего шага** — `prev.artifacts` с `kind: 'blob'`
 *    (`StepResult.artifacts`, ADR-116).
 *
 * Ничего не бросает: значения без нужной формы просто игнорируются.
 */
export function collectStepAttachmentRefs(
  ctx: Pick<StepExecutionContext, 'trigger' | 'input' | 'prev'>,
): PipelineAttachmentSource[] {
  const found: PipelineAttachmentSource[] = [];
  const seen = new Set<string>();

  const push = (source: PipelineAttachmentSource | null): void => {
    if (!source || seen.has(source.blobPath)) return;
    seen.add(source.blobPath);
    found.push(source);
  };

  const walk = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > MAX_INPUT_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    const direct = asAttachmentSource(value);
    if (direct) {
      push(direct);
      return;
    }
    for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1);
  };

  // 1. Вход прогона: вложения запуска (доступны шагу без маппинга).
  walk(ctx.trigger?.payload?.attachments, 0);

  // 2. Маппинг шага: ссылки/артефакты, отображённые путями `node.input`.
  for (const key of Object.keys(ctx.input).sort()) walk(ctx.input[key], 0);

  // 3. Артефакты предыдущего шага (ADR-116): только blob-объекты.
  for (const artifact of ctx.prev?.artifacts ?? []) {
    if (!isBlobPipelineArtifact(artifact)) continue;
    push({
      blobPath: artifact.path,
      mime: artifact.mime ?? 'application/octet-stream',
      size: artifact.size ?? 0,
      ...(artifact.name ? { name: artifact.name } : {}),
    });
  }

  return found;
}

/** Объект-значение как ссылка на вложение (форма `EventAttachmentRef`/артефакта). */
function asAttachmentSource(value: object): PipelineAttachmentSource | null {
  const record = value as Record<string, unknown>;
  const artifact = record as unknown as PipelineArtifact;
  if (isBlobPipelineArtifact(artifact)) {
    return {
      blobPath: artifact.path,
      mime: artifact.mime ?? 'application/octet-stream',
      size: artifact.size ?? 0,
      ...(artifact.name ? { name: artifact.name } : {}),
    };
  }
  const blobPath = record.blobPath;
  const mime = record.mime;
  if (typeof blobPath !== 'string' || blobPath.length === 0) return null;
  if (typeof mime !== 'string' || mime.length === 0) return null;
  if (!isAttachmentPath(blobPath) && !isPipelineArtifactPath(blobPath)) return null;
  const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0;
  return {
    blobPath,
    mime,
    size,
    ...(typeof record.sha256 === 'string' && record.sha256 ? { sha256: record.sha256 } : {}),
    ...(typeof record.name === 'string' && record.name ? { name: record.name } : {}),
  };
}

/** Опции гидратации вложений шага (поверх `HydrateOptions`, ADR-115). */
export interface StepAttachmentHydrationOptions {
  /** Модальности модели шага (конфиг модели инстанса). */
  modalities?: readonly AttachmentModality[];
  /** Обработка вложения aux-моделью (text-only модель шага). */
  derive?: (input: {
    blobPath: string;
    mime: string;
    name?: string;
    family: AttachmentFamily;
  }) => Promise<string | null>;
  /** Шаблон блока «вложения не доставлены» (`prompts/system`). */
  noticeTemplate?: string;
  /** Подпись модели шага (`provider/model`) для пометок. */
  modelLabel?: string;
  /** Предел суммарного base64 на шаг (по умолчанию — как у сессии, 20 МиБ). */
  maxTotalBase64Bytes?: number;
  /** Лог предупреждений. */
  log?: (message: string) => void;
}

/**
 * Приложить вложения к сообщению шага (ADR-115, единый путь с сессиями).
 *
 * Строит синтетическое user-сообщение с медиа-частями по ссылкам и прогоняет
 * его через `hydrateMessageAttachments`: base64 (с очисткой метаданных),
 * фильтр модальностей, derive, лимит объёма и блок-пометка о не доставленных
 * вложениях — всё то же, что у сессий.
 *
 * Без инфраструктуры чтения (`runtime.service`/`runtime.artifacts`) ссылки не
 * читаются: в текст шага добавляется техническая строка-пометка (модель должна
 * знать, что вложение есть, но не доставлено). Ошибка чтения одного объекта не
 * роняет шаг — гидратация помечает его `unavailable`.
 */
export async function hydrateStepAttachments(params: {
  /** LLM-сообщения шага (первое — сообщение запроса). */
  messages: LLMMessage[];
  /** Ссылки, собранные `collectStepAttachmentRefs`. */
  refs: readonly PipelineAttachmentSource[];
  /** Инфраструктура чтения и обработки (из контекста шага). */
  runtime?: PipelineStepAttachments;
  /** Опции гидратации. */
  options?: StepAttachmentHydrationOptions;
}): Promise<LLMMessage[]> {
  const { messages, refs, runtime, options = {} } = params;
  if (refs.length === 0 || messages.length === 0) return messages;

  const base = messages[0]!;
  const content = base.content ?? '';
  const log = options.log ?? (() => undefined);

  const reader = runtime ? createStepAttachmentReader(runtime, refs) : null;
  if (!reader) {
    // Инфраструктуры нет — молчать нельзя: модель иначе решит, что вложений не
    // было. Формат строки — как у fallback-пометки гидратации (канал LLM, ADR-041).
    log('[attachments] вложения шага не прочитаны: нет blob-инфраструктуры');
    return [
      {
        ...base,
        content: appendUndelivered(
          content,
          refs.map((ref) => ({ ...ref, reason: 'unavailable' })),
        ),
      },
    ];
  }

  // `text/*` и неопознанные типы гидратация не отправляет (их содержимое в
  // сессиях уже лежит в тексте сообщения). В шаге текста нет — сообщаем модели
  // путём и типом, иначе вложение исчезло бы молча.
  const nonByte = refs.filter((ref) => partTypeOf(ref.mime) === 'file' && !isByteMime(ref.mime));
  const byteRefs = refs.filter((ref) => !nonByte.includes(ref));

  const source: Message = {
    id: 'pipeline-step-attachments',
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [
      makeTextPart(content),
      ...refs.map((ref) =>
        makeMediaPart(partTypeOf(ref.mime), {
          blobPath: ref.blobPath,
          sha256: ref.sha256 ?? '',
          mime: ref.mime,
          size: ref.size,
          ...(ref.name ? { name: ref.name } : {}),
        }),
      ),
    ],
    content: appendUndelivered(content, nonByte.map((ref) => ({ ...ref, reason: 'disabled' }))),
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
  };

  if (byteRefs.length === 0) {
    return [{ ...base, content: source.content }];
  }

  const hydrated = await hydrateMessageAttachments([{ ...base, content: source.content }], [source], reader, {
    ...(options.modalities && options.modalities.length > 0
      ? { modalities: options.modalities }
      : {}),
    ...(options.derive ? { derive: options.derive } : {}),
    ...(options.noticeTemplate ? { noticeTemplate: options.noticeTemplate } : {}),
    ...(options.modelLabel ? { modelLabel: options.modelLabel } : {}),
    ...(options.modalities && options.modalities.length > 0
      ? { modelModalities: options.modalities }
      : {}),
    ...(options.maxTotalBase64Bytes ? { maxTotalBase64Bytes: options.maxTotalBase64Bytes } : {}),
    log,
  });

  return [hydrated[0] ?? { ...base, content: source.content }, ...messages.slice(1)];
}

/**
 * Порты чтения для гидратации: `attachments/…` — через `AttachmentService`
 * (sidecar-метаданные, containment), `artifacts/…` — через хранилище
 * артефактов прогона (ADR-116). Возвращает `null`, если читать нечем.
 */
function createStepAttachmentReader(
  runtime: PipelineStepAttachments,
  refs: readonly PipelineAttachmentSource[],
): HydrateDeps | null {
  const service = runtime.service;
  const artifacts = runtime.artifacts;
  if (!service && !artifacts) return null;

  const byPath = new Map(refs.map((ref) => [ref.blobPath, ref]));
  // Артефакт читается в `resolve` и снова в `read` — байты кэшируются на один
  // шаг, повторного чтения объекта нет.
  const preloaded = new Map<string, Buffer | null>();

  const readArtifact = async (blobPath: string): Promise<Buffer | null> => {
    if (!artifacts || !isPipelineArtifactPath(blobPath)) return null;
    if (preloaded.has(blobPath)) return preloaded.get(blobPath) ?? null;
    const bytes = await artifacts.read({ path: blobPath });
    preloaded.set(blobPath, bytes);
    return bytes;
  };

  return {
    resolve: async (blobPath) => {
      if (service && isAttachmentPath(blobPath)) {
        const resolved = await service.resolve(blobPath);
        if (!resolved) return null;
        return {
          mime: resolved.mime,
          size: resolved.size,
          sha256: resolved.sha256,
          ...(resolved.name ? { name: resolved.name } : {}),
        };
      }
      const ref = byPath.get(blobPath);
      if (!ref) return null;
      const bytes = await readArtifact(blobPath);
      if (!bytes) return null;
      return {
        mime: ref.mime,
        size: bytes.length,
        sha256: ref.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
        ...(ref.name ? { name: ref.name } : {}),
      };
    },
    read: async (blobPath) => {
      if (service && isAttachmentPath(blobPath)) {
        const stream = await service.read(blobPath);
        return stream ? readStreamToBuffer(stream) : null;
      }
      return readArtifact(blobPath);
    },
  };
}

/** MIME-модальность, которая отправляется байтами (не `text/*`). */
function isByteMime(mime: string): boolean {
  const normalized = mime.toLowerCase();
  if (normalized.startsWith('text/')) return false;
  return (
    normalized.startsWith('image/') ||
    normalized.startsWith('audio/') ||
    normalized.startsWith('video/') ||
    normalized.startsWith('application/pdf')
  );
}

/** Строки-пометки о не доставленных вложениях (технический текст для модели). */
function appendUndelivered(
  content: string,
  refs: ReadonlyArray<PipelineAttachmentSource & { reason: string }>,
): string {
  if (refs.length === 0) return content;
  const lines = refs.map((ref) => {
    const target = ref.name ? `${ref.name} (${ref.mime})` : ref.mime;
    return `[attachment not delivered: ${target} — ${ref.reason}; path: ${ref.blobPath}]`;
  });
  return `${content}\n\n${lines.join('\n')}`;
}

/** Поток в буфер (порт `readStream` отдаёт `Readable`). */
async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/** Зависимости обработки вложения шага aux-моделью (text-only модель). */
export interface PipelineAttachmentDeriveDeps {
  /** Live-конфиг вложений (`attachments.modalityModels` — назначения aux-моделей). */
  config: () => AttachmentsConfig;
  /** Сервис вложений: медиа-часть объекта (blobPath/mime/метаданные, ADR-115). */
  attachments: AttachmentService;
  /** Blob-порт: кэш результата и производные объекты (`attachments/.derived`). */
  blobs: BlobStore;
  /**
   * Провайдер aux-модели, **уже обёрнутый в `GatewayProvider`** (ADR-036) —
   * инвариант 3: LLM-вызов только через gateway. `null` — провайдер не собран.
   */
  resolveProvider: (provider: string, model: string) => Promise<BaseProvider | null> | BaseProvider | null;
  /** Доступен ли `ffmpeg` (видео/нестандартное аудио, ADR-078). */
  hasFfmpeg: () => boolean | Promise<boolean>;
  /** Шаблон промпта обработки (`ContextConfig.getMediaDeriveTemplate`). */
  promptTemplate?: (language: 'ru' | 'en') => string;
  /** Язык промпта по умолчанию (если шаг его не задал). */
  language?: string;
  /** Лог предупреждений. */
  log?: (message: string) => void;
}

/**
 * Фабрика обработки вложения aux-моделью для шага пайплайна (ADR-115).
 *
 * Настройка та же, что у сессий: `attachments.modalityModels[<семейство>]`
 * (live-резолвер). Модель шага не меняется — aux-вызов идёт отдельным
 * провайдером через gateway, а в сообщение шага попадает текст (`hydrate`
 * подставит его вместо байтов).
 *
 * Ничего не бросает: нет модели/провайдера, ошибка вызова или `ffmpeg` —
 * `null` (гидратация идёт прежним путём «отброшено + пометка»).
 */
export function createPipelineAttachmentDerive(
  deps: PipelineAttachmentDeriveDeps,
): (input: {
  blobPath: string;
  mime: string;
  name?: string;
  family: AttachmentFamily;
  language?: 'ru' | 'en';
}) => Promise<string | null> {
  const log = deps.log ?? (() => undefined);
  return async (input) => {
    const family = input.family;
    // `AttachmentFamily` шире семейств обработки (`text`): такая запись в
    // настройке невозможна — обрабатывать нечего.
    if (!isDeriveFamily(family)) return null;
    const target = deps.config().modalityModels?.[family];
    if (!target) return null;

    try {
      const provider = await deps.resolveProvider(target.provider, target.model);
      if (!provider) {
        log(
          `[attachments] модель обработки «${target.provider}/${target.model}» недоступна (семейство ${family})`,
        );
        return null;
      }
      const built = await deps.attachments.buildMediaPart(input.blobPath);
      if (!built) {
        log(`[attachments] объект ${input.blobPath} не разрешён для обработки`);
        return null;
      }
      const hasFfmpeg = await Promise.resolve(deps.hasFfmpeg()).catch(() => false);
      const language: 'ru' | 'en' =
        (input.language ?? deps.language) === 'en' ? 'en' : 'ru';
      const result = await deriveModalityText(
        {
          family,
          mime: input.mime,
          ...(input.name ? { name: input.name } : {}),
          blobPath: input.blobPath,
          part: makeMediaPart(built.type, built.data),
          provider: target.provider,
          model: target.model,
          language,
        },
        {
          blobs: deps.blobs,
          blobsRead: (path) => deps.blobs.read(path),
          hasFfmpeg: () => hasFfmpeg,
          ...(deps.promptTemplate ? { promptTemplate: deps.promptTemplate } : {}),
          log,
          chat: async (parts, prompt) => {
            const attachments: LLMAttachment[] = [];
            for (const part of parts) {
              const data = part.data as { blobPath?: unknown; mime?: unknown; name?: unknown } | undefined;
              const blobPath = typeof data?.blobPath === 'string' ? data.blobPath : '';
              if (!blobPath) continue;
              const bytes = await deps.blobs.read(blobPath);
              if (!bytes) continue;
              const mime = typeof data?.mime === 'string' ? data.mime : 'application/octet-stream';
              attachments.push({
                mime,
                ...(typeof data?.name === 'string' && data.name ? { name: data.name } : {}),
                // ADR-115 §«Приватность»: aux-модель получает байты без EXIF.
                base64: stripMetadata(bytes, mime).toString('base64'),
              });
            }
            if (attachments.length === 0) {
              throw new Error('aux-вызов: нет читаемых частей вложения');
            }
            const response = await provider.chat([
              {
                id: 'pipeline-attachment-derive',
                role: 'user',
                content: prompt,
                attachments,
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                disabled: false,
                pinned: false,
                branchId: '',
              },
            ]);
            return { text: response.content };
          },
        },
      );
      return result.ok ? result.text : null;
    } catch (err) {
      log(
        `[attachments] обработка вложения ${input.blobPath} (${family}) не удалась: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  };
}

/** Семейство, для которого бывает назначена aux-модель (ADR-115). */
function isDeriveFamily(
  family: AttachmentFamily,
): family is 'image' | 'pdf' | 'audio' | 'video' {
  return family === 'image' || family === 'pdf' || family === 'audio' || family === 'video';
}
