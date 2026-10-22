// ADR-097 (волна 5): `synth storage migrate` — идемпотентный перенос данных
// инстанса между физическими backend'ами хранения (`file` ↔ `postgres`).
//
// Копирование идёт **только через доменные порты** `StorageContext` (ADR-096),
// не по файлам: сущность читается доменным методом источника и пишется доменным
// методом цели. Перед записью наличие проверяется по стабильному идентификатору
// (`id`/ключ/метка) — повторный прогон ничего не дублирует, а уже существующие
// записи пропускаются (не перезаписываются). Отчёт — счётчики `copied`/`skipped`
// по каждой сущности.
//
// ── Что переносится ───────────────────────────────────────────────────────
// sessions (целиком, с `messages`/`references`/`checkpoints`/`stickyNotes`),
// projects (с `members`), profiles, settings (мапинг `load()` → сеттеры порта),
// defaults, providers/models/agents, eventBindings, eventRoutes, eventApiKeys,
// eventJournal, identityClaims, schedules, jobs, webhooks, webhookDeliveries,
// sshKeys, serviceKeys, mcpRegistry, skillBundles, maintenanceAudit.
//
// ── Что НЕ переносится (осознанно) ────────────────────────────────────────
// - `dedup` — транзиентный (окно идемпотентности событий живёт минуты);
// - `blobs`/`skills`/`contextFiles` — **файловые в обоих backend'ах** (драйвер
//   postgres отдаёт их файловыми реализациями core), переезжать нечему;
// - файловый периметр вне портов: `audit/*.jsonl` (LLM Gateway), prompts,
//   `meta.json`, `workspaces/`, `secrets/master.key` — см. ADR-091/ADR-092;
// - `meta.json` (версия схемы данных инстанса) — контур `synth migrate`.
//
// ── Известные ограничения ────────────────────────────────────────────────
// - `webhooks`: signing-секрет шифруется мастер-ключом цели и наружу на запись
//   не отдаётся — при переносе создаётся **новая** подписка с **новым** секретом
//   (метаданные сохраняются), о чём выводится предупреждение;
// - `schedules`/`webhooks`/`sshKeys`/`mcpRegistry` получают новые `id`
//   (порт `create`/`add` их генерирует), привязки по `id` переезжают как есть.
//
// `eventApiKeys`/`serviceKeys`, наоборот, переносятся **как есть** (`importExisting`):
// сохраняются `id`, `prefix` и at-rest sha256-хеш, поэтому выданные ранее токены
// продолжают работать (ADR-096, регрессия «401 после миграции»).
import { readdir } from 'node:fs/promises';
import type { SynthConfig } from '@itphx/synth-shared';
import { resolveStorageBackend } from '@itphx/synth-shared';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import {
  buildStorageContext,
  type StorageBackendKind,
  type StorageContext,
} from '../storage/storage-context.js';
import { recordMaintenanceAudit } from './audit.js';

/** Целевой backend переноса (обратное направление — `file`, для откатa). */
export type StorageMigrateTarget = 'file' | 'postgres';

/** Канал вывода. */
export type StorageMigrateLog = (msg: string) => void;

/** Счётчики переноса одной сущности. */
export interface StorageMigrationEntity {
  /** Имя сущности (ключ порта `StorageContext`). */
  entity: string;
  copied: number;
  skipped: number;
  /** Замечание (напр. «signing-секрет перевыпущен») — для отчёта. */
  note?: string;
}

/** Итог переноса данных между двумя контекстами. */
export interface StorageMigrationReport {
  from: StorageBackendKind;
  to: StorageBackendKind;
  dryRun: boolean;
  entities: StorageMigrationEntity[];
  copied: number;
  skipped: number;
}

/** Опции низкоуровневого переноса (готовые контексты — тесты/встраивание). */
export interface MigrateStorageDataOptions {
  source: StorageContext;
  target: StorageContext;
  /** Предпросмотр: считать, но не писать. */
  dryRun?: boolean;
  /** Канал предупреждений (по умолчанию — тихий). */
  warn?: StorageMigrateLog;
}

/** Рабочие счётчики одной сущности. */
interface Counter {
  copied: number;
  skipped: number;
  note?: string;
}

/** Контекст копирования, общий для всех обработчиков. */
interface CopyContext {
  dryRun: boolean;
  warn: StorageMigrateLog;
}

/** Обработчик одной сущности: читает источник, идемпотентно пишет цель. */
interface EntityMigrator {
  entity: string;
  copy: (src: StorageContext, dst: StorageContext, ctx: CopyContext) => Promise<Counter>;
}

// ────────────────────────────────────────────────────────────────────────────
// Мелкие утилиты
// ────────────────────────────────────────────────────────────────────────────

function _isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** «Пустое» значение настройки: `undefined`, пустой объект или пустой массив. */
function _isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.length === 0;
  if (_isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** Стабильная сериализация (порядок ключей не влияет) — для сравнения секций. */
function _stableJson(value: unknown): string {
  return JSON.stringify(_sortDeep(value));
}

function _sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => _sortDeep(item));
  if (_isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = _sortDeep(value[key]);
    return out;
  }
  return value;
}

/** Записывает элемент, если его нет в цели; счётчики — в `counter`. */
async function _copyOne(
  dryRun: boolean,
  exists: boolean,
  write: () => Promise<void>,
  counter: Counter,
): Promise<void> {
  if (exists) {
    counter.skipped += 1;
    return;
  }
  if (!dryRun) await write();
  counter.copied += 1;
}

// ────────────────────────────────────────────────────────────────────────────
// Сущности: сессии, проекты, профили
// ────────────────────────────────────────────────────────────────────────────

async function copySessions(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  for (const session of await src.sessions.list()) {
    await _copyOne(
      ctx.dryRun,
      await dst.sessions.exists(session.id),
      () => dst.sessions.save(session),
      counter,
    );
  }
  return counter;
}

async function copyProjects(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  for (const project of await src.projects.list()) {
    await _copyOne(
      ctx.dryRun,
      (await dst.projects.load(project.id)) !== null,
      () => dst.projects.save(project),
      counter,
    );
  }
  return counter;
}

async function copyProfiles(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  for (const profile of await src.profiles.listProfiles()) {
    await _copyOne(
      ctx.dryRun,
      (await dst.profiles.loadProfile(profile.id)) !== null,
      () => dst.profiles.saveProfile(profile),
      counter,
    );
  }
  return counter;
}

// ────────────────────────────────────────────────────────────────────────────
// Настройки и умолчания оформления
// ────────────────────────────────────────────────────────────────────────────

type SettingsPort = StorageContext['settings'];

/** Дескриптор секции `RuntimeSettings` → методы порта. */
interface SettingsSection {
  key: string;
  read: (settings: SettingsPort) => Promise<unknown>;
  write: (settings: SettingsPort, value: unknown) => Promise<void>;
}

type McpSettings = Awaited<ReturnType<SettingsPort['getMcpSettings']>>;
type GatewaySettings = Awaited<ReturnType<SettingsPort['getLlmGatewaySettings']>>;
type SecuritySettings = Awaited<ReturnType<SettingsPort['getSecuritySettings']>>;
type ToolsPolicy = NonNullable<Awaited<ReturnType<SettingsPort['getToolsPolicy']>>>;
type ToolsDisabled = NonNullable<Awaited<ReturnType<SettingsPort['getToolsDisabled']>>>;
type SkillsDisabled = NonNullable<Awaited<ReturnType<SettingsPort['getSkillsDisabled']>>>;
type McpNetworkPolicy = NonNullable<Awaited<ReturnType<SettingsPort['getMcpNetworkPolicy']>>>;
type WorkspacePolicy = NonNullable<Awaited<ReturnType<SettingsPort['getWorkspacePolicy']>>>;
type EventsSettings = Awaited<ReturnType<SettingsPort['getEvents']>>;
type DecisionSettings = Awaited<ReturnType<SettingsPort['getDecision']>>;
type ProxySettings = NonNullable<Awaited<ReturnType<SettingsPort['getProxySettings']>>>;

/** Секции `settings.json` «один геттер → один сеттер» (кроме карт-исключений). */
const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    key: 'workspace',
    read: (s) => s.getWorkspace(),
    write: (s, v) => s.setWorkspace(v as string),
  },
  {
    key: 'mcpServers',
    read: (s) => s.getMcpSettings(),
    write: (s, v) => s.setMcpSettings(v as McpSettings),
  },
  {
    key: 'llmGateway',
    read: (s) => s.getLlmGatewaySettings(),
    write: (s, v) => s.setLlmGatewaySettings(v as GatewaySettings),
  },
  {
    key: 'security',
    read: (s) => s.getSecuritySettings(),
    write: (s, v) => s.setSecuritySettings(v as SecuritySettings),
  },
  {
    key: 'toolsPolicy',
    read: (s) => s.getToolsPolicy(),
    write: (s, v) => s.setToolsPolicy(v as ToolsPolicy),
  },
  {
    key: 'mcpPolicy',
    read: (s) => s.getMcpPolicy(),
    write: (s, v) => s.setMcpPolicy(v as ToolsPolicy),
  },
  {
    key: 'toolsDisabled',
    read: (s) => s.getToolsDisabled(),
    write: (s, v) => s.setToolsDisabled(v as ToolsDisabled),
  },
  {
    key: 'skillsDisabled',
    read: (s) => s.getSkillsDisabled(),
    write: (s, v) => s.setSkillsDisabled(v as SkillsDisabled),
  },
  {
    key: 'skillsDisabledForNewProjects',
    read: (s) => s.getSkillsDisabledForNewProjects(),
    write: (s, v) => s.setSkillsDisabledForNewProjects(v as SkillsDisabled),
  },
  {
    key: 'skillsPolicy',
    read: (s) => s.getSkillsPolicy(),
    write: (s, v) => s.setSkillsPolicy(v as ToolsPolicy),
  },
  {
    key: 'mcpNetworkPolicy',
    read: (s) => s.getMcpNetworkPolicy(),
    write: (s, v) => s.setMcpNetworkPolicy(v as McpNetworkPolicy),
  },
  {
    key: 'defaultAgent',
    read: (s) => s.getDefaultAgent(),
    write: (s, v) => s.setDefaultAgent(v as string),
  },
  {
    key: 'workspacePolicy',
    read: (s) => s.getWorkspacePolicy(),
    write: (s, v) => s.setWorkspacePolicy(v as WorkspacePolicy),
  },
  {
    key: 'events',
    read: (s) => s.getEvents(),
    write: (s, v) => s.setEvents(v as EventsSettings),
  },
  {
    key: 'decision',
    read: (s) => s.getDecision(),
    write: (s, v) => s.setDecision(v as DecisionSettings),
  },
  {
    key: 'proxy',
    read: (s) => s.getProxySettings(),
    write: (s, v) => s.setProxySettings(v as ProxySettings),
  },
];

/**
 * Переносит `settings.json` через сеттеры порта (`load()` → соответствующие
 * сеттеры). Идемпотентность — по секции: пустая секция цели заполняется;
 * совпадающая считается пропущенной; заданная и отличающаяся — не
 * перезаписывается (предупреждение). Карты (`tokenRatios`/`migrations`) —
 * по ключу.
 */
async function copySettings(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };

  for (const section of SETTINGS_SECTIONS) {
    const srcValue = await section.read(src.settings);
    if (_isEmptyValue(srcValue)) {
      counter.skipped += 1;
      continue;
    }
    const dstValue = await section.read(dst.settings);
    if (!_isEmptyValue(dstValue)) {
      if (_stableJson(dstValue) !== _stableJson(srcValue)) {
        ctx.warn(
          `Предупреждение: секция настроек «${section.key}» уже задана в цели и отличается — не перезаписываю.`,
        );
      }
      counter.skipped += 1;
      continue;
    }
    await _copyOne(ctx.dryRun, false, () => section.write(dst.settings, srcValue), counter);
  }

  // Egress-политика (tools/webhooks): отдельные геттеры/сеттеры по скоупу.
  for (const scope of ['tools', 'webhooks'] as const) {
    const srcPolicy = await src.settings.getEgressPolicy(scope);
    if (_isEmptyValue(srcPolicy)) {
      counter.skipped += 1;
      continue;
    }
    const dstPolicy = await dst.settings.getEgressPolicy(scope);
    if (!_isEmptyValue(dstPolicy)) {
      if (_stableJson(dstPolicy) !== _stableJson(srcPolicy)) {
        ctx.warn(`Предупреждение: egress-политика «${scope}» уже задана в цели и отличается — не перезаписываю.`);
      }
      counter.skipped += 1;
      continue;
    }
    await _copyOne(ctx.dryRun, false, () => dst.settings.setEgressPolicy(scope, srcPolicy!), counter);
  }

  // `tokenRatios`: откалиброванный chars-per-token по модели — пер-ключ.
  const srcRatios = await src.settings.getTokenRatios();
  const dstRatios = await dst.settings.getTokenRatios();
  for (const [model, ratio] of Object.entries(srcRatios)) {
    await _copyOne(
      ctx.dryRun,
      dstRatios[model] !== undefined,
      () => dst.settings.setTokenRatio(model, ratio),
      counter,
    );
  }

  // Разовые миграции (`migrations`): маркеры «уже выполнено».
  const loaded = await src.settings.load();
  for (const name of Object.keys(loaded.migrations ?? {})) {
    await _copyOne(
      ctx.dryRun,
      await dst.settings.getMigrationMarker(name),
      () => dst.settings.setMigrationMarker(name),
      counter,
    );
  }

  return counter;
}

async function copyDefaults(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  const srcDefaults = await src.defaults.loadDefaults();
  if (_isEmptyValue(srcDefaults)) {
    counter.skipped += 1;
    return counter;
  }
  const dstDefaults = await dst.defaults.loadDefaults();
  if (!_isEmptyValue(dstDefaults) && _stableJson(dstDefaults) !== _stableJson(srcDefaults)) {
    ctx.warn('Предупреждение: умолчания оформления уже заданы в цели и отличаются — не перезаписываю.');
    counter.skipped += 1;
    return counter;
  }
  await _copyOne(ctx.dryRun, _stableJson(dstDefaults) === _stableJson(srcDefaults), () =>
    dst.defaults.saveDefaults(srcDefaults).then(() => undefined), counter);
  return counter;
}

// ────────────────────────────────────────────────────────────────────────────
// Конфиг-словари: провайдеры / модели / агенты
// ────────────────────────────────────────────────────────────────────────────

/**
 * Копирует `DocumentRepository<T>`: ключ документа — `keyOf` (провайдеры — по
 * `name`, модели и агенты — по `id`). Ключ совпадает с тем, которым пользуется
 * домен при `save`.
 */
async function _copyDocuments<T>(
  src: { list(): Promise<T[]>; exists(key: string): Promise<boolean>; save(key: string, value: T): Promise<void> },
  dst: { exists(key: string): Promise<boolean>; save(key: string, value: T): Promise<void> },
  keyOf: (doc: T) => string | undefined,
  ctx: CopyContext,
): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  for (const doc of await src.list()) {
    const key = keyOf(doc);
    if (!key) {
      counter.skipped += 1;
      continue;
    }
    await _copyOne(
      ctx.dryRun,
      await dst.exists(key),
      () => dst.save(key, doc),
      counter,
    );
  }
  return counter;
}

const copyProviders: EntityMigrator['copy'] = (src, dst, ctx) =>
  _copyDocuments(src.providers, dst.providers, (p) => p.name, ctx);

const copyModels: EntityMigrator['copy'] = (src, dst, ctx) =>
  _copyDocuments(src.models, dst.models, (m) => m.id, ctx);

const copyAgents: EntityMigrator['copy'] = (src, dst, ctx) =>
  _copyDocuments(src.agents, dst.agents, (a) => a.id, ctx);

// ────────────────────────────────────────────────────────────────────────────
// Внешние события: привязки, правила, ключи, журнал, claim-коды
// ────────────────────────────────────────────────────────────────────────────

async function copyEventBindings(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  for (const binding of await src.eventBindings.list()) {
    await _copyOne(
      ctx.dryRun,
      (await dst.eventBindings.get(binding.id)) !== null,
      () => dst.eventBindings.upsert(binding).then(() => undefined),
      counter,
    );
  }
  return counter;
}

async function copyEventRoutes(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  for (const rule of await src.eventRoutes.list()) {
    await _copyOne(
      ctx.dryRun,
      (await dst.eventRoutes.get(rule.id)) !== null,
      () => dst.eventRoutes.upsert(rule).then(() => undefined),
      counter,
    );
  }
  return counter;
}

/**
 * API-ключи привязок: переносятся **как есть** (`importExisting`) — сохраняются
 * `id`, `prefix`, `bindingId` и at-rest sha256-хеш, поэтому уже выданные токены
 * остаются валидными. Идемпотентность — по `id`/метке/хешу.
 */
async function copyEventApiKeys(
  src: StorageContext,
  dst: StorageContext,
  ctx: CopyContext,
): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  const keys = await src.eventApiKeys.exportAll();
  if (keys.length === 0) return counter;
  const existing = await dst.eventApiKeys.exportAll();
  const ids = new Set(existing.map((key) => key.id));
  const labels = new Set(existing.map((key) => key.label.toLowerCase()));
  const hashes = new Set(existing.map((key) => key.hash));

  for (const key of keys) {
    const exists = ids.has(key.id) || labels.has(key.label.toLowerCase()) || hashes.has(key.hash);
    await _copyOne(
      ctx.dryRun,
      exists,
      () => dst.eventApiKeys.importExisting(key).then(() => undefined),
      counter,
    );
  }
  return counter;
}

/**
 * Журнал Router: append-only, идентификатор записи — `event.id`. Записи, уже
 * присутствующие в цели, пропускаются.
 */
async function copyEventJournal(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  const entries = await src.eventJournal.list();
  if (entries.length === 0) return counter;
  const existing = new Set((await dst.eventJournal.list()).map((entry) => entry.event.id));
  for (const entry of entries) {
    await _copyOne(
      ctx.dryRun,
      existing.has(entry.event.id),
      () => dst.eventJournal.record(entry),
      counter,
    );
  }
  return counter;
}

/**
 * Одноразовые claim-коды идентичности: живые записи пересоздаются портом
 * (`create` выдаёт новый код с дефолтным TTL) — сами коды одноразовые и
 * короткоживущие. Идемпотентность — по тройке `provider|externalId|principalId`.
 */
async function copyIdentityClaims(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0, note: 'коды перевыпущены (TTL по умолчанию)' };
  const claims = await src.identityClaims.list(true);
  if (claims.length === 0) return counter;
  const existing = new Set(
    (await dst.identityClaims.list(false)).map(
      (claim) => `${claim.provider}|${claim.externalId}|${claim.principalId}`,
    ),
  );
  for (const claim of claims) {
    await _copyOne(
      ctx.dryRun,
      existing.has(`${claim.provider}|${claim.externalId}|${claim.principalId}`),
      () =>
        dst.identityClaims
          .create({
            provider: claim.provider,
            externalId: claim.externalId,
            principalId: claim.principalId,
            ...(claim.chatKey !== undefined ? { chatKey: claim.chatKey } : {}),
          })
          .then(() => undefined),
      counter,
    );
  }
  return counter;
}

// ────────────────────────────────────────────────────────────────────────────
// Шедулер, webhooks
// ────────────────────────────────────────────────────────────────────────────

/**
 * Расписания: порт `create` не принимает `id` (генерирует свой) — идемпотентность
 * по имени расписания; служебные поля запуска (`lastRunAt`/`nextRunAt`) не
 * переносятся.
 */
async function copySchedules(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0, note: 'id перегенерирован, история запусков не переносится' };
  const schedules = await src.schedules.list();
  if (schedules.length === 0) return counter;
  const existing = new Set((await dst.schedules.list()).map((schedule) => schedule.name));
  for (const schedule of schedules) {
    await _copyOne(
      ctx.dryRun,
      existing.has(schedule.name),
      () =>
        dst.schedules
          .create({
            name: schedule.name,
            enabled: schedule.enabled,
            target: schedule.target,
            ...(schedule.cron !== undefined ? { cron: schedule.cron } : {}),
            ...(schedule.every !== undefined ? { every: schedule.every } : {}),
            ...(schedule.prompt !== undefined ? { prompt: schedule.prompt } : {}),
            ...(schedule.payload !== undefined ? { payload: schedule.payload } : {}),
            ...(schedule.ownerId !== undefined ? { ownerId: schedule.ownerId } : {}),
            ...(schedule.catchUp !== undefined ? { catchUp: schedule.catchUp } : {}),
          })
          .then(() => undefined),
      counter,
    );
  }
  return counter;
}

/** Job-история расписаний: append-only, идентификатор — `job.id`. */
async function copyJobs(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  const jobs = await src.jobs.list();
  if (jobs.length === 0) return counter;
  const existing = new Set((await dst.jobs.list()).map((job) => job.id));
  for (const job of jobs) {
    await _copyOne(ctx.dryRun, existing.has(job.id), () => dst.jobs.append(job), counter);
  }
  return counter;
}

/**
 * Подписки webhooks: signing-секрет портом не отдаётся на запись — подписка
 * пересоздаётся с **новым** `whsec_…`; мягкое отключение воспроизводится
 * (`setEnabled`). Идемпотентность — по глобальной метке (`label`).
 */
async function copyWebhooks(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0, note: 'signing-секрет перевыпущен, id перегенерирован' };
  const subscriptions = await src.webhooks.list();
  if (subscriptions.length === 0) return counter;
  const existing = new Set((await dst.webhooks.list()).map((item) => item.label.toLowerCase()));
  let warned = false;

  for (const subscription of subscriptions) {
    if (existing.has(subscription.label.toLowerCase())) {
      counter.skipped += 1;
      continue;
    }
    if (!warned) {
      ctx.warn(
        'Предупреждение: подписки webhooks переносятся с НОВЫМ signing-секретом — ' +
          'получателям нужно обновить проверку подписи.',
      );
      warned = true;
    }
    if (ctx.dryRun) {
      counter.copied += 1;
      continue;
    }
    const created = await dst.webhooks.create(
      {
        label: subscription.label,
        url: subscription.url,
        events: subscription.events,
        enabled: subscription.enabled,
        ...(subscription.description !== undefined ? { description: subscription.description } : {}),
      },
      subscription.createdBy || 'migrate',
    );
    if (!subscription.enabled) await dst.webhooks.setEnabled(created.id, false);
    counter.copied += 1;
  }
  return counter;
}

/**
 * Журнал доставок webhooks: append-only, идентификатор — `whd_…`. `subscriptionId`
 * ссылается на пересозданную подписку (id меняется) — ссылка остаётся
 * исторической.
 */
async function copyWebhookDeliveries(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = {
    copied: 0,
    skipped: 0,
    note: 'subscriptionId ссылается на пересозданную подписку',
  };
  const deliveries = await src.webhookDeliveries.list();
  if (deliveries.length === 0) return counter;
  const existing = new Set((await dst.webhookDeliveries.list()).map((delivery) => delivery.id));
  for (const delivery of deliveries) {
    await _copyOne(ctx.dryRun, existing.has(delivery.id), () => dst.webhookDeliveries.record(delivery), counter);
  }
  return counter;
}

// ────────────────────────────────────────────────────────────────────────────
// Секреты и контент: SSH-ключи, service-key, MCP-реестр, bundles, аудит
// ────────────────────────────────────────────────────────────────────────────

/**
 * SSH-ключи агентов: секрет расшифровывается `reveal()` у источника и
 * перешифровывается мастер-ключом цели (`create`). Идемпотентность — по имени
 * (уникальное, регистронезависимо). `id` перегенерируется.
 */
async function copySshKeys(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0, note: 'id перегенерирован' };
  const keys = await src.sshKeys.list();
  if (keys.length === 0) return counter;
  const existing = new Set((await dst.sshKeys.list()).map((key) => key.name.toLowerCase()));
  for (const key of keys) {
    if (existing.has(key.name.toLowerCase())) {
      counter.skipped += 1;
      continue;
    }
    if (ctx.dryRun) {
      counter.copied += 1;
      continue;
    }
    const secret = await src.sshKeys.reveal(key.id);
    if (!secret) {
      counter.skipped += 1;
      ctx.warn(`Предупреждение: SSH-ключ «${key.name}» не расшифрован — пропущен.`);
      continue;
    }
    await dst.sshKeys.create({
      name: key.name,
      type: key.type,
      privateKey: secret.privateKey,
      agentIds: key.agentIds,
      ...(secret.passphrase !== undefined ? { passphrase: secret.passphrase } : {}),
    });
    counter.copied += 1;
  }
  return counter;
}

/**
 * service-key инстанса: переносятся **как есть** (`importExisting`) — сохраняются
 * `id`, `prefix` и at-rest sha256-хеш, поэтому уже выданные токены остаются
 * валидными. Идемпотентность — по `id`/метке/хешу.
 */
async function copyServiceKeys(
  src: StorageContext,
  dst: StorageContext,
  ctx: CopyContext,
): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  const keys = await src.serviceKeys.exportAll();
  if (keys.length === 0) return counter;
  const existing = await dst.serviceKeys.exportAll();
  const ids = new Set(existing.map((key) => key.id));
  const labels = new Set(existing.map((key) => key.label.toLowerCase()));
  const hashes = new Set(existing.map((key) => key.hash));

  for (const key of keys) {
    const exists = ids.has(key.id) || labels.has(key.label.toLowerCase()) || hashes.has(key.hash);
    await _copyOne(
      ctx.dryRun,
      exists,
      () => dst.serviceKeys.importExisting(key).then(() => undefined),
      counter,
    );
  }
  return counter;
}

/** Реестр MCP: `add` принимает явный `id` — запись переносится как есть. */
async function copyMcpRegistry(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  for (const entry of await src.mcpRegistry.list()) {
    await _copyOne(
      ctx.dryRun,
      (await dst.mcpRegistry.getByName(entry.name)) !== null,
      () =>
        dst.mcpRegistry
          .add({
            id: entry.id,
            name: entry.name,
            config: entry.config,
            origin: entry.origin,
            author: entry.author,
            trust: entry.trust,
            enabled: entry.enabled,
            enabledByDefault: entry.enabledByDefault,
          })
          .then(() => undefined),
      counter,
    );
  }
  return counter;
}

/** Instance-bundles слэш-команд: ключ — `name`. */
async function copySkillBundles(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  for (const bundle of await src.skillBundles.list()) {
    await _copyOne(
      ctx.dryRun,
      await dst.skillBundles.exists(bundle.name),
      () => dst.skillBundles.set(bundle),
      counter,
    );
  }
  return counter;
}

/** Аудит-журнал обслуживания: append-only, идентификатор — `ma_…`; исходный порядок. */
async function copyMaintenanceAudit(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  const entries = (await src.maintenanceAudit.list()).slice().reverse();
  if (entries.length === 0) return counter;
  const existing = new Set((await dst.maintenanceAudit.list()).map((entry) => entry.id));
  for (const entry of entries) {
    await _copyOne(ctx.dryRun, existing.has(entry.id), () => dst.maintenanceAudit.append(entry), counter);
  }
  return counter;
}

/** Аудит security-политик: append-only, идентификатор — `sa_…`; исходный порядок. */
async function copySecurityAudit(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  const entries = (await src.securityAudit.list()).slice().reverse();
  if (entries.length === 0) return counter;
  const existing = new Set((await dst.securityAudit.list()).map((entry) => entry.id));
  for (const entry of entries) {
    await _copyOne(ctx.dryRun, existing.has(entry.id), () => dst.securityAudit.append(entry), counter);
  }
  return counter;
}

/** Журнал внешних запросов: append-only, идентификатор — `eg_…`; исходный порядок. */
async function copyEgressRequests(src: StorageContext, dst: StorageContext, ctx: CopyContext): Promise<Counter> {
  const counter: Counter = { copied: 0, skipped: 0 };
  const entries = (await src.egressRequests.list()).slice().reverse();
  if (entries.length === 0) return counter;
  const existing = new Set((await dst.egressRequests.list()).map((entry) => entry.id));
  for (const entry of entries) {
    await _copyOne(ctx.dryRun, existing.has(entry.id), () => dst.egressRequests.append(entry), counter);
  }
  return counter;
}

/**
 * Порядок и состав сущностей переноса. Порядок важен для ссылочной логики
 * (сессии → привязки → ключи привязок; подписки → доставки).
 */
const ENTITY_MIGRATORS: readonly EntityMigrator[] = [
  { entity: 'sessions', copy: copySessions },
  { entity: 'projects', copy: copyProjects },
  { entity: 'profiles', copy: copyProfiles },
  { entity: 'settings', copy: copySettings },
  { entity: 'defaults', copy: copyDefaults },
  { entity: 'providers', copy: copyProviders },
  { entity: 'models', copy: copyModels },
  { entity: 'agents', copy: copyAgents },
  { entity: 'eventBindings', copy: copyEventBindings },
  { entity: 'eventRoutes', copy: copyEventRoutes },
  { entity: 'eventApiKeys', copy: copyEventApiKeys },
  { entity: 'eventJournal', copy: copyEventJournal },
  { entity: 'identityClaims', copy: copyIdentityClaims },
  { entity: 'schedules', copy: copySchedules },
  { entity: 'jobs', copy: copyJobs },
  { entity: 'webhooks', copy: copyWebhooks },
  { entity: 'webhookDeliveries', copy: copyWebhookDeliveries },
  { entity: 'sshKeys', copy: copySshKeys },
  { entity: 'serviceKeys', copy: copyServiceKeys },
  { entity: 'mcpRegistry', copy: copyMcpRegistry },
  { entity: 'skillBundles', copy: copySkillBundles },
  { entity: 'maintenanceAudit', copy: copyMaintenanceAudit },
  { entity: 'securityAudit', copy: copySecurityAudit },
  { entity: 'egressRequests', copy: copyEgressRequests },
];

/** Имена переносимых сущностей (для отчёта/тестов). */
export const STORAGE_MIGRATION_ENTITIES: readonly string[] = ENTITY_MIGRATORS.map(
  (migrator) => migrator.entity,
);

/**
 * Переносит данные инстанса между двумя собранными контекстами хранения.
 *
 * Идемпотентно: наличие записи в цели проверяется по стабильному идентификатору,
 * существующие записи пропускаются (не перезаписываются). `dryRun` — счётчики без
 * записи (но чтение цели/источника выполняется).
 */
export async function migrateStorageData(
  opts: MigrateStorageDataOptions,
): Promise<StorageMigrationReport> {
  const { source, target } = opts;
  const ctx: CopyContext = { dryRun: !!opts.dryRun, warn: opts.warn ?? ((): void => {}) };
  const entities: StorageMigrationEntity[] = [];

  for (const migrator of ENTITY_MIGRATORS) {
    const counter = await migrator.copy(source, target, ctx);
    entities.push({
      entity: migrator.entity,
      copied: counter.copied,
      skipped: counter.skipped,
      ...(counter.note !== undefined ? { note: counter.note } : {}),
    });
  }

  return {
    from: source.kind,
    to: target.kind,
    dryRun: ctx.dryRun,
    entities,
    copied: entities.reduce((sum, item) => sum + item.copied, 0),
    skipped: entities.reduce((sum, item) => sum + item.skipped, 0),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CLI-команда
// ────────────────────────────────────────────────────────────────────────────

/** Опции CLI-команды `synth storage migrate` (паритет dev-CLI и публичного CLI). */
export interface StorageMigrateCommandOptions {
  /** Каталог данных источника (и файловой цели по умолчанию). */
  dataDir: string;
  /** Полный конфиг инстанса (источник `storage.*`, включая параметры PG). */
  config: SynthConfig;
  /** Целевой backend (`--to`). */
  to: StorageMigrateTarget;
  /** Предпросмотр: счётчики без записи. */
  dryRun?: boolean;
  /** Подтверждение (`--yes`); без него (и без `--dry-run`) — отказ. */
  yes?: boolean;
  /** Каталог данных файловой цели (`--target-data-dir`); по умолчанию — `dataDir`. */
  targetDataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** ADR-079: home-каталог (для резолва путей/секретов). */
  home?: string | null;
  /** Канал вывода (по умолчанию `console.log`). */
  log?: StorageMigrateLog;
  /** Канал ошибок (по умолчанию `console.error`). */
  error?: StorageMigrateLog;
  /** Канал предупреждений (по умолчанию — `error`). */
  warn?: StorageMigrateLog;
  /** ADR-092: аудит-журнал обслуживания (best-effort). */
  audit?: MaintenanceAuditRepository;
  /** ADR-092: инициатор операции (по умолчанию `'cli'`). */
  actor?: string;
}

/** Каталог содержит хоть какие-то данные (для предупреждения `--to file`). */
async function _dirHasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Тело CLI-команды `synth storage migrate`: собирает контексты источника
 * (resolved backend из конфига/env) и цели (`--to`) и переносит данные через
 * порты. Без `--yes` и без `--dry-run` — отказ. Собранные контексты закрываются
 * в `finally` (пул БД не остаётся висеть).
 *
 * @returns код выхода процесса (0 — успех, 1 — отказ/ошибка).
 */
export async function runStorageMigrateCommand(opts: StorageMigrateCommandOptions): Promise<number> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const error = opts.error ?? ((msg: string) => console.error(msg));
  const warn = opts.warn ?? error;
  const dryRun = !!opts.dryRun;
  const env = opts.env ?? process.env;
  const actor = opts.actor ?? 'cli';
  const targetDataDir = opts.targetDataDir ? String(opts.targetDataDir) : opts.dataDir;

  if (!dryRun && !opts.yes) {
    error(
      'Ошибка: перенос данных между backend\'ами изменяет хранилище. Используйте --dry-run для проверки или --yes для применения.',
    );
    return 1;
  }

  const sourceKind = resolveStorageBackend(opts.config, env);
  if (sourceKind === opts.to) {
    error(
      `Ошибка: источник и цель совпадают (backend='${sourceKind}'). Источник — resolved backend из конфига/env ` +
        `(SYNTH_STORAGE_BACKEND / storage.backend); цель задаётся --to.`,
    );
    return 1;
  }

  let source: StorageContext | undefined;
  let target: StorageContext | undefined;
  try {
    // Источник — resolved backend инстанса; схема БД не трогается (`skip`).
    source = await buildStorageContext({
      dataDir: opts.dataDir,
      config: opts.config,
      env,
      home: opts.home ?? null,
      postgresSchemaMode: 'skip',
    });
    // Цель — строго `--to`: env `SYNTH_STORAGE_BACKEND` для цели игнорируем,
    // иначе он перебил бы явный флаг; схема БД цели применяется (apply).
    const targetEnv: NodeJS.ProcessEnv = { ...env };
    delete targetEnv.SYNTH_STORAGE_BACKEND;
    target = await buildStorageContext({
      dataDir: targetDataDir,
      config: {
        ...opts.config,
        storage: { ...opts.config.storage, backend: opts.to } as SynthConfig['storage'],
      },
      env: targetEnv,
      home: opts.home ?? null,
    });

    // Целевой backend недоступен → сборка ушла в деградированный файловый
    // фоллбек (`storage.degradedMode='fallback-file'`): `target.kind` не совпадёт
    // с `--to`. Для обслуживающей команды это недопустимо — перенос молча ушёл бы
    // в чужой каталог (`fallbackDir`) с отчётом об успехе. Отказываем явно.
    if (target.kind !== opts.to) {
      throw new Error(
        `целевой backend '${opts.to}' недоступен — хранилище собралось как '${target.kind}' ` +
          `(деградированный режим: ${target.degraded?.reason ?? 'см. предупреждения выше'}). ` +
          'Перенос отменён, чтобы не записать данные в другой backend. ' +
          'Проверьте доступность БД/драйвера (synth doctor) и повторите.',
      );
    }

    if (opts.to === 'file' && (await _dirHasEntries(targetDataDir))) {
      warn(
        `Предупреждение: в целевом каталоге ${targetDataDir} уже есть данные — ` +
          'существующие записи не перезаписываются (пропускаются).',
      );
    }

    log(
      `${dryRun ? '[dry-run] ' : ''}Перенос данных хранилища: ${source.kind} → ${target.kind}` +
        (opts.to === 'file' ? ` (целевой каталог: ${targetDataDir})` : ''),
    );
    const report = await migrateStorageData({ source, target, dryRun, warn });
    for (const item of report.entities) {
      log(
        `  ${item.entity}: скопировано ${item.copied}, пропущено ${item.skipped}` +
          (item.note ? ` — ${item.note}` : ''),
      );
    }
    log(`  итого: скопировано ${report.copied}, пропущено ${report.skipped}`);
    if (dryRun) log('  (dry-run: изменения не записаны)');

    if (!dryRun) {
      await recordMaintenanceAudit(opts.audit, {
        op: 'migrate.applied',
        status: 'ok',
        actor,
        details: {
          storageBackend: { from: report.from, to: report.to },
          copied: report.copied,
          skipped: report.skipped,
          trigger: 'cli',
        },
      });
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordMaintenanceAudit(opts.audit, {
      op: 'migrate.failed',
      status: 'failed',
      actor,
      details: { dataDir: opts.dataDir, storageBackend: { to: opts.to }, trigger: 'cli' },
      error: message,
    });
    error(`Ошибка переноса данных: ${message}`);
    return 1;
  } finally {
    // Закрываем только собранные нами контексты (пул БД освобождается всегда).
    await target?.close?.().catch(() => undefined);
    await source?.close?.().catch(() => undefined);
  }
}
