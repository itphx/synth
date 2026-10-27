# ADR-115: Мультимодальный ввод — вложения сообщений (Part, blob-порт, API, UI)

> **Статус:** ⚠️ Частично — решение принято 2026-10-27 и **реализовано** (контракт `Part`, blob-порт,
> HTTP-контур, провайдеры, gateway, UI, экспорт/импорт проекта); остаток — перенос вложений в гибриде,
> персист черновиков вложений между сессиями, предобработка (ASR/OCR/видео), см. «Статус в коде».
> **Дата:** 2026-10-27
> **Принято из:** [PROP-085](./prop-085-multimodal-input.md) (исходная гипотеза; файл остаётся как история).
> **Связано:** [ADR-096](./adr-096-storage-layer.md) (доменные порты и файловые реализации),
> [ADR-116](./adr-116-instance-state-and-blob-ports.md) (blob-порты на томе, `blob_refs`, том),
> [ADR-005](./adr-005-json-storage.md) (атомарная запись tmp→rename),
> [ADR-098](./adr-098-storage-degraded-recovery.md) (деградированный режим: файловые байты остаются читаемыми),
> [ADR-036](./adr-036-llm-gateway.md) (guard/обфускация/аудит LLM-вызовов),
> [ADR-070](./adr-070-system-prompt-composer.md) (статистика промпта, prompt-cache),
> [ADR-041](./adr-041-llm-error-taxonomy.md) (строки движка через `shared/i18n`),
> [ADR-023](./adr-023-configuration.md) (конфиг и лимиты),
> [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md) (мобильный UI: камера/микрофон),
> [ADR-024](./adr-024-eventhub-transport.md) (транспорт событий; новых каналов не вводим),
> [ADR-087](./adr-087-gateways.md) / [ADR-089](./adr-089-external-events-automation.md) — вложения из чатов и событий,
> [ADR-101](./adr-101-pipeline-engine.md) — артефакты прогонов в том же blob-порте.

## Контекст

Модель контента сообщения — текстовая: `PartType = 'text' | 'tool_use' | 'tool_result' | 'reasoning' |
'session_reference'` (`packages/shared/src/types/message.ts:19`), `Part = { id, type, data: unknown }`.
Провайдеры получают `LLMMessage.content: string` (`packages/core/src/providers/base.ts:151-154`), поэтому
картинку, голос или документ передать нельзя. При этом:

- ввод с телефона (камера/микрофон, ADR-044) и вложения из мессенджеров (ADR-087/ADR-089) — востребованные
  сценарии; шлюзы уже **приносят метаданные** вложения (`kind`/`fileId`/`fileName`), но не байты;
- vision/audio/pdf-модальности у провайдеров есть, а в Synth нет ни контракта, ни хранилища, ни UI;
- blob-подложка уже существует и работает (логи фоновых процессов через порт `BlobStore`), но у неё один
  потребитель и нет учёта ссылок.

Дополнительно: `content` — производное строковое поле (`buildContentFromParts`,
`packages/shared/src/utils/index.ts:194`) и источник для PG-маппинга
(`packages/storage-postgres/src/ports/sessions-mapping.ts`), экспорта, легаси-сообщений и поиска. Любая
новая часть обязана давать в `content` осмысленный плейсхолдер, иначе вложение «испаряется» без ошибки.

## Решение

1. **Расширить `Part`** типами `image`/`audio`/`video`/`file`; данные части — ссылка на blob + метаданные
   (`blobPath`, `mime`, `size`, `sha256`, `name?`, `width?`, `height?`, `durationMs?`, `transcript?`).
   Текстовые части не меняются — обратная совместимость. Медиа-часть обязана давать в `content`
   плейсхолдер (`[image: name.png]`), чтобы строковые производные не теряли факт вложения.
2. **Байты — на томе через порт `BlobStore`**, content-addressed (`attachments/<sha2>/<sha256>`);
   в БД байты не пишутся (обоснование и `blob_refs` — [ADR-116](./adr-116-instance-state-and-blob-ports.md)).
3. **Контракт LLM-вызова расширяется аддитивно:** `LLMMessage.attachments?: LLMAttachment[]` рядом с
   `content: string` (а не `content` как массив частей). Причина: guard, обфускация, фильтры,
   `estimateTokens`, debug и маппинг истории остаются текстовыми; провайдер сам собирает массив частей
   запроса. Порядок — текст, затем вложения.
4. **Провайдеры** маппят вложения в свои форматы: OpenAI (`image_url`, `input_audio`), Anthropic
   (`image`, `document`), Gemini (inline). Для модели без нужной модальности вложение **не отправляется**,
   модель получает плейсхолдер + системную пометку, пользователь — предупреждение (i18n-ключ), не 500.
5. **Gateway** (инвариант 3) остаётся единственным путём: обфускация/guard/payload-лог работают **только**
   с текстом (`content`, `systemPrompt`, сериализованный `tools`); бинарь не сканируется и не логируется —
   в журнал попадают только ссылки `{blobPath, sha256, size, mime}`. Обфускация на медиа не
   распространяется: это фиксируется как известное ограничение, OCR-инъекции — новый вектор (ADR-036).
6. **HTTP-контур** (core, монтируется backend'ом):
   - `POST /api/v2/sessions/:id/attachments` — multipart, один файл за запрос; MIME определяется по
     содержимому (не по заявленному), размер и количество — по лимитам; ответ `{id, blobPath, sha256, mime, size}`;
   - `GET /api/v2/sessions/:id/attachments/:partId` — байты с проверкой доступа (session prefix-guard, read),
     `Content-Type`, `Content-Length`, `ETag = sha256`, `Content-Disposition: inline` (с санитайзом),
     `Cache-Control: private`; большие файлы — потоком с поддержкой `Range`;
   - `POST /api/v2/sessions/:id/prompt` получает аддитивное `attachments?: string[]` (id вложений) →
     сообщение с частями `[text, image, …]`.
7. **Конфиг** — секция `attachments` (`maxBytesPerFile`, `maxFilesPerMessage`, `maxBytesPerSession`,
   `allowedMimePrefixes`, `gcDays`), приоритет CLI > env > config.yaml > defaults (ADR-023).
8. **UI — по образцу OpenChamber** (эталонный код: `tmp/refs/openchamber/packages/ui/src`). Копируем
   поведение и структуру, а не код; отличия — из-за серверного хранения (см. §«UI»).

## Модель контента

```ts
export type PartType = 'text' | 'tool_use' | 'tool_result' | 'reasoning' | 'session_reference'
  | 'image' | 'audio' | 'video' | 'file';

export interface MediaPartData {
  blobPath: string;   // 'attachments/ab/<sha256>'
  sha256: string;
  mime: string;
  size: number;
  name?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Текстовая расшифровка (ASR/OCR/извлечение из документа) — подставляется в контекст вместо байтов. */
  transcript?: string;
}
```

`messages.parts` в PostgreSQL — `jsonb` (`packages/storage-postgres/src/migrations/001-init.ts:82`), поэтому
новые виды частей схемы БД **не требуют**; требуется только приём новых типов в
`serializePart`/`deserializePart`.

## Хранение

- Порт `BlobStore` (`packages/core/src/storage/ports/blob-store.ts`) расширяется двумя аддитивными
  методами: `stat(path)` (размер/mtime для ответа и `Range`) и `readStream(path, {start?, end?})`
  (раздача без чтения в память). `read()` остаётся для мелких объектов и тестов.
- Content type в порт не переезжает: он живёт в метаданных домена (часть сообщения, запись артефакта).
- Учёт ссылок — `blob_refs` (порт; миграция `024_blob_refs`, первая из релизной серии): ссылка пишется при появлении сообщения и снимается
  при его удалении; объект удаляется, когда ссылок не осталось (плюс sweep сирот).
- Раздача идёт через API, а не прямой ссылкой на файл: доступ проверяется на границе
  (`server/session-access-guard.ts`, инвариант 16).

## Провайдеры и gateway

| Слой | Что делать |
|---|---|
| `providers/openai.ts` | собрать `content: [{type:'text'}, {type:'image_url', image_url:{url:'data:<mime>;base64,…'}}]`, аудио — `input_audio` |
| `providers/anthropic.ts` | `[{type:'text'}, {type:'image', source:{type:'base64', media_type, data}}]`, документы — `document` |
| `providers/gemini.ts` | inline-части (`inline_data`) |
| `engine/gateway/input-guard.ts` | обфускация только `content`/`systemPrompt`/`tools`; вложения не трогаем |
| `engine/gateway/payload-logger.ts` | в журнал — только ссылки, без base64 |
| `engine/orchestrator/prompt-info.ts` | `PromptHistoryInfo.attachments` уже считает нетекстовые части (`:230-243`) — начинает учитывать медиа |
| `engine/context/token-ratio.ts` | приблизительный учёт токенов медиа (по размеру/разрешению), чтобы бюджет промпта не «врал» |

## API и лимиты

- Загрузка — multipart (`@hono/node-server` уже используется для `/fs/upload`); лимит — из конфига,
  превышение → `413 PAYLOAD_TOO_LARGE`, неизвестный/запрещённый MIME → `415 UNSUPPORTED_MEDIA_TYPE`.
- Имя файла — санитайз (без `..`, без управляющих символов); в `blobPath` имя **не** используется
  (content-addressed), оно живёт только в метаданных части.
- Выдача — потоком; `HEAD` поддерживается (размер и `ETag` без тела).
- Доступ: чужой пользователь → 403, нет объекта → 404 (без утечки существования).

## UI (эталон — OpenChamber)

Изученный референс: `tmp/refs/openchamber/packages/ui/src` — `components/chat/FileAttachment.tsx` (943 стр.),
`components/chat/ChatInput.tsx`, `components/chat/composer/ui/ComposerAttachmentControls.tsx`,
`composer/attachments/{dataTransfer,filePaths,inlineMentionAttachments}.ts`,
`sync/input-store.ts`, `sync/attachment-files.ts` (427 стр.), `sync/document-attachments.ts` (688 стр.).

Что берём как есть (поведение):

1. **Модель элемента композера**: `{id, mimeType, filename, size, previewUrl, source, groupId?}`;
   `groupId` склеивает элементы, извлечённые из одного документа (удаление любого — удаляет группу).
2. **Чипы в композере** (`AttachedFilesList`): изображения — превью 64×64, клик открывает галерею
   (перелистывание, клавиатура, `aria-label`), кнопка удаления поверх; прочие файлы — чип с иконкой типа,
   усечённым именем и размером. Две строки: изображения, затем файлы.
3. **Кнопка «прикрепить»** (`ComposerAttachmentControls`): меню (локальные файлы + будущие провайдеры
   контекста), скрытый `<input type="file" multiple accept={ATTACHMENT_ACCEPT}>`; на телефоне — bottom sheet
   (мобильный адаптив ADR-044).
4. **Drag&drop**: чистые хелперы `hasDraggedFiles` / `collectDroppedFiles` / `collectDroppedFileUris`
   (в референсе — поддержка браузерных `File`, VS Code-путей и внутреннего дерева файлов) + оверлей
   «бросить сюда»; повторный дроп дубликатов не создаёт.
5. **Вставка из буфера**: изображения из `clipboardData.files`/`items` — с автогенерируемым именем и
   цитатой-подписью; прочие файлы — как выбранные. Вставка **пути/URL** в текст обрабатывается отдельно
   (в референсе — markdown-ссылка на выделение; у нас — через `@`-упоминания файлов проекта).
6. **Клиентская подготовка** (`attachment-files.ts`): определение MIME по содержимому, HEIC→JPEG,
   документы (docx/pptx/xlsx/odt/odp/ods) распаковываются на клиенте в текст + встроенные изображения с
   квотами референса (архив ≤ 20 МБ, распаковано ≤ 100 МБ, запись ≤ 25 МБ, XML ≤ 8 МБ, ≤ 5000 записей,
   ≤ 50 изображений, ≤ 20 МБ/изображение и ≤ 40 МБ суммарно, текст ≤ 500 000 символов), тяжёлый
   paste-текст предлагается приложить файлом.
7. **Гейт модальностей**: `getAttachmentInputModality(mime)` → `text|image|pdf|audio|video`;
   `getUnsupportedAttachmentInputs(files, model.modalities.input)`; проверка при добавлении и при смене
   модели/появлении метаданных; предупреждение — тост с перечнем модальностей и имён файлов; блокировка
   отправки несовместимого набора.
8. **Отображение в сообщении** (`MessageFilesDisplay`): компактные чипы/миниатюры, клик — попап:
   текст-подобные файлы показываются как текст (`decodeDataUrlText`), изображения — галерея, остальные —
   скачивание. Это заменяет нам рендер вложений из `content`.
9. **Мелочи, которые в референсе сделаны и которые легко потерять**: дедуп по `name+size`, три попытки
   подготовки при коллизии имён, сохранение набора вложений при переключении черновика/сессии
   (`attachmentDrafts`), «вложения восстанавливаются» при неудачной отправке, `aria-label` на всех
   действиях, ленивая загрузка превью.

Чем отличаемся из-за серверного хранения:

| Референс (OpenChamber) | Synth |
|---|---|
| байты остаются в браузере (`dataUrl`) и уходят провайдеру в промпте | файл **загружается** на `POST /sessions/:id/attachments`, в сообщение попадает `blobPath` |
| сразу готово к отправке | состояние `uploading → ready → error`; чип с прогрессом, повтор при ошибке |
| `file://` и server-path как «вложение» | `blobPath` + API-URL для превью (`/api/v2/sessions/:id/attachments/:partId`) |
| документы распаковываются и уходят текстом | так же: извлечённый текст — отдельная `text`-часть/`transcript`, байты документа — `file`-часть |
| модель-гейт по `modalities.input` приходит с сервера OpenCode | поле модальностей добавляется в метаданные модели (`shared/model-metadata.ts` + конфиг), отдаётся в `GET /models` |

Что **не** берём из референса: вкладки-гости, трекеры/issues/PR как вложения, VS Code-интеграцию,
`file://`-пути (у нас — workspace и `@`-упоминания), dictation-режим (голосовой ввод — отдельная задача
после 0.13).

## Лимиты и безопасность

- MIME — по сигнатуре содержимого; `image/svg+xml` запрещён (XSS), HTML-файлы отдаются только как
  `attachment`/`text`-просмотр.
- EXIF/IPTC вычищаются при загрузке (иначе геолокация уезжает провайдеру).
- Обфускация секретов на бинарь **не работает** — фиксируется в ADR-036 и в UI-подсказке.
- Аудит загрузок/выдач — через существующий контур безопасности (без новых журналов).
- Метрики — `synth_attachments_*` (см. ADR-094: имена и лейблы — контракт).

## Границы (вне объёма)

- **Видео-ввод** нативно (кадры/аудио-дорожка) — отдельная задача; в 0.13 видео принимается как `file`.
- **ASR/OCR/ffmpeg/sharp** — предобработка на сервере не входит (новые зависимости — инвариант 12);
  текстовые расшифровки приходят от клиента (документы) или от провайдера.
- Смена физического backend'а blob-хранилища — не входит (см. ADR-116: байты на томе).

## Статус в коде

**Реализовано (2026-10-27), волна 1.1:**

- контракт: `PartType` + `image|audio|video|file`, `MediaPartData`, `makeMediaPart`,
  плейсхолдер в `buildContentFromParts` (`packages/shared/src/types/message.ts`,
  `packages/shared/src/utils/index.ts`), `mediaPartSchema`;
- модальности моделей: `KNOWN_MODEL_MODALITIES`/`resolveModelModalities`, отдаются `GET /api/v2/models`;
- хранение: `BlobStore.stat/readStream`, корень `{dataDir}/blobs`, `AttachmentService`
  (MIME по сигнатуре, лимиты, запрет SVG, вычищение EXIF/PNG-метаданных до хеширования,
  content-addressed `attachments/<sha2>/<sha256>`, sidecar с именем), `blobRefs` (миграция `024`);
- HTTP: `POST /sessions/:id/attachments`, `GET /sessions/:id/attachments/:partId`
  (Range/206/416, `ETag`/304, HEAD, `Content-Disposition: inline`), `attachments: string[]`
  в `POST /prompt` → медиа-части + ссылки, pruner сирот (старт + 6 ч);
- LLM: `LLMMessage.attachments`, гидратация из blob-порта (лимит 20 МиБ, фильтр по модальностям),
  OpenAI `image_url`/`input_audio`, Anthropic `image`/`document`; gateway не обфусцирует и не логирует
  base64 (payload-лог и debug-снимок — сводкой `{mime,name,sizeBytes}`);
- UI: композер (кнопка/drag&drop/paste, `prepareAttachmentFiles`: HEIC→JPEG, office→текст+картинки
  с группой), чипы и галерея, отправка `attachments`, рендер в ленте (изображения сеткой, audio/video
  `controls`, файлы чипом), гейт модальностей по `modalities`;
- переносимость: портативный экспорт/импорт проекта (формат 2) переносит байты вложений и `blob_refs`;
- метрики `synth_attachment_*`; доки — `docs/API_V2.md` §5.6.1, `docs/CONFIGURATION.md`.

**Остаток:**

- гибрид (`remote/transfer.ts`, publish/fork) байты вложений не переносит — медиа-части на удалённой
  стороне остаются с неразрешённым `blobPath`;
- черновики вложений не переживают переключение сессии (`attachmentDrafts` из §«UI»);
- предобработка вне объёма: ASR/OCR/извлечение кадров/конвертация на сервере (видео принимается как `file`);
- `transcript` заполняется только тем, что пришло с клиента/провайдера.

## Открытые вопросы

Решено при реализации: вложения в промпте — `attachments: string[]` (blob-пути); квота сессии считается
по сумме `size` медиа-частей истории; EXIF/метаданные вычищает сервер до хеширования. Остаются:

1. Где считать стоимость медиа: в `usage` провайдера (если он её отдаёт) или оценкой по размеру?
2. `transcript` для аудио без серверного ASR — только то, что пришло с клиента/провайдера?
3. Как переносить байты вложений в гибриде (publish/fork, `remote/transfer`)?

## История

- 2026-10-27 — принято как ADR-115 из [PROP-085](./prop-085-multimodal-input.md). Зафиксировано: байты на
  томе через `BlobStore` (не в БД), `blob_refs` для дедупа и GC, аддитивное `attachments` в LLM-контракте,
  UI по образцу OpenChamber (`tmp/refs/openchamber`), видео/ASR/OCR — вне объёма.
