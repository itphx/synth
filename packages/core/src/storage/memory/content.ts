/**
 * In-memory реализации «контентных» портов: скиллы, bundles, файлы контекста,
 * blob-хранилище и SSH-ключи (ADR-096, шаг W2.2).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): файловые деревья моделируются
 * `Map`, виртуальные пути — строки (`/memory/skills/<name>`, `/memory/prompts`).
 * Семантика повторяет файловую (`SkillStore`/`SkillBundleStore`/`ContextConfig`/
 * `FileBlobStore`/`SSHKeyStore`): валидация имён скиллов/bundles, frontmatter
 * через `shared`, containment blob-путей, «публичные методы не отдают секреты».
 *
 * Расхождения описаны точечно (см. ниже у классов): системные промпты/скиллы не
 * читаются с диска; SSH-секреты в памяти не шифруются (`listRaw` не отдаёт
 * секреты, `rotateMasterKey` — no-op-обёртка).
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  ContextCategory,
  ContextFileContent,
  ContextFileInfo,
  SSHKey,
  SSHKeyCreateRequest,
  SSHKeyMeta,
  SSHKeyUpdateRequest,
  SkillBundle,
} from '@itphx/synth-shared';
import { SKILL_NAME_MAX, SKILL_NAME_REGEX, nowISO, parseFrontmatter, stringifyFrontmatter } from '@itphx/synth-shared';
import type { CreateSkillInput, UpdateSkillMarkdownInput } from '../skill-store.js';
import type { RotateMasterKeyOptions, RotateMasterKeyResult } from '../ssh-key-store.js';
import { SSHKeyStoreError } from '../ssh-key-store.js';
import type {
  BlobReadRange,
  BlobStat,
  BlobStore,
  ContextFileRepository,
  PackInstallation,
  PackRepository,
  PipelineDefinitionRecord,
  PipelineInstanceFilter,
  PipelineInstanceRecord,
  PipelineRepository,
  SSHKeyRepository,
  SkillBundleRepository,
  SkillRepository,
} from '../ports/index.js';
import { resolvePipelineInstanceLimit } from '../ports/pipeline-repository.js';
import { resolveCreatedAt, resolveUpdatedAt } from '../record-timestamps.js';

/** Проверка имени скилла/bundle (1–64, `^[a-z0-9]+(-[a-z0-9]+)*$`). */
function assertSkillName(name: string, kind = 'скилла'): void {
  if (!name || name.length > SKILL_NAME_MAX || !SKILL_NAME_REGEX.test(name)) {
    throw new Error(`Недопустимое имя ${kind}: ${name}`);
  }
}

/** Относительный путь внутри дерева (без выхода за корень): нормализованный posix-путь или `null`. */
function safeRelPath(relPath: string): string | null {
  if (!relPath || relPath.startsWith('/') || relPath.includes('..') || relPath.includes('\\') || relPath.includes('\0')) {
    return null;
  }
  const normalized = relPath.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!normalized) return null;
  return normalized;
}

interface MemorySkill {
  markdown: string;
}

/** Порт instance-скиллов — дерево в `Map` (путей наружу не отдаёт, ADR-116). */
export class MemorySkillRepository implements SkillRepository {
  private readonly _skills = new Map<string, MemorySkill>();
  /** supporting-файлы: ключ `\`${name}\0${rel}\`` (независимо от наличия `SKILL.md`). */
  private readonly _files = new Map<string, string>();

  private _fileKey(name: string, rel: string): string {
    return `${name}\0${rel}`;
  }

  async exists(name: string): Promise<boolean> {
    return this._skills.has(name);
  }

  async listNames(): Promise<string[]> {
    return [...this._skills.keys()].sort();
  }

  async readMarkdown(name: string): Promise<string | null> {
    return this._skills.get(name)?.markdown ?? null;
  }

  async create(input: CreateSkillInput): Promise<void> {
    assertSkillName(input.name);
    if (this._skills.has(input.name)) throw new Error(`Скилл "${input.name}" уже существует`);
    for (const [rel, body] of Object.entries(input.files ?? {})) {
      const target = safeRelPath(rel);
      if (!target) throw new Error(`Небезопасный путь supporting-файла: ${rel}`);
      this._files.set(this._fileKey(input.name, target), body);
    }
    const data: Record<string, unknown> = { ...(input.frontmatter ?? {}) };
    data.name = input.name;
    data.description = input.description;
    this._skills.set(input.name, {
      markdown: stringifyFrontmatter(data, input.body ?? ''),
    });
  }

  async updateMarkdown(name: string, patch: UpdateSkillMarkdownInput): Promise<void> {
    assertSkillName(name);
    const skill = this._skills.get(name);
    if (!skill) throw new Error(`Скилл "${name}" не найден`);

    const fm = parseFrontmatter(skill.markdown);
    const data: Record<string, unknown> = { ...fm.data, name };
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.metadata !== undefined) {
      const existing = typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata)
        ? data.metadata as Record<string, unknown>
        : {};
      data.metadata = { ...existing, ...patch.metadata };
    }
    const body = patch.body !== undefined ? patch.body : fm.body;
    skill.markdown = stringifyFrontmatter(data, body);
  }

  async remove(name: string): Promise<boolean> {
    assertSkillName(name);
    for (const key of [...this._files.keys()]) {
      if (key.startsWith(`${name}\0`)) this._files.delete(key);
    }
    return this._skills.delete(name);
  }

  async readFile(name: string, relPath: string): Promise<string | null> {
    const target = safeRelPath(relPath);
    if (!target) return null;
    return this._files.get(this._fileKey(name, target)) ?? null;
  }

  async writeFile(name: string, relPath: string, content: string): Promise<void> {
    assertSkillName(name);
    const target = safeRelPath(relPath);
    if (!target) throw new Error(`Небезопасный путь supporting-файла: ${relPath}`);
    this._files.set(this._fileKey(name, target), content);
  }

  async deleteFile(name: string, relPath: string): Promise<boolean> {
    const target = safeRelPath(relPath);
    if (!target) return false;
    this._files.delete(this._fileKey(name, target));
    // Как `SkillStore.deleteFile`: удаление отсутствующего файла — не ошибка.
    return true;
  }

  /** Supporting-файлы (рекурсивно, без `SKILL.md`) с размерами, по возрастанию пути. */
  async listFiles(name: string): Promise<Array<{ path: string; size: number }>> {
    const prefix = `${name}\0`;
    const files: Array<{ path: string; size: number }> = [];
    for (const [key, content] of this._files) {
      if (!key.startsWith(prefix)) continue;
      const rel = key.slice(prefix.length);
      if (rel === 'SKILL.md') continue;
      files.push({ path: rel, size: Buffer.byteLength(content, 'utf-8') });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}

/** Порт instance-bundles поверх `Map` (семантика `SkillBundleStore`). */
export class MemorySkillBundleRepository implements SkillBundleRepository {
  private readonly _bundles = new Map<string, SkillBundle>();

  async exists(name: string): Promise<boolean> {
    return this._bundles.has(name);
  }

  async get(name: string): Promise<SkillBundle | undefined> {
    const bundle = this._bundles.get(name);
    return bundle ? structuredClone(bundle) : undefined;
  }

  async list(): Promise<SkillBundle[]> {
    return [...this._bundles.values()]
      .map((b) => structuredClone(b))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async set(bundle: SkillBundle): Promise<void> {
    assertSkillName(bundle.name, 'bundle');
    this._bundles.set(bundle.name, structuredClone(bundle));
  }

  async remove(name: string): Promise<boolean> {
    assertSkillName(name, 'bundle');
    return this._bundles.delete(name);
  }
}

const DEFAULT_ENABLED_FILES = ['SOUL.md', 'COMPANY.md', 'ABOUT.md'];

/**
 * Порт файлов контекста/промптов поверх `Map`.
 *
 * Читаются/пишутся только пользовательские файлы (сохранённые через
 * `saveFile`); встроенные системные промпты с диска не подгружаются (нет ФС) —
 * соответствующие геттеры возвращают пустую строку/`null`. `systemPromptsDir` —
 * виртуальный путь `/memory/prompts` (используется доменом как строка).
 */
export class MemoryContextFileRepository implements ContextFileRepository {
  readonly systemPromptsDir = '/memory/prompts';

  private readonly _files = new Map<string, string>();
  private _enabledFiles: string[] = [...DEFAULT_ENABLED_FILES];

  private _key(category: ContextCategory, filename: string): string {
    return `${category}:${filename}`;
  }

  listAllFiles(): ContextFileInfo[] {
    return [...this._files.entries()].map(([key, content]) => {
      const sep = key.indexOf(':');
      const category = key.slice(0, sep) as ContextCategory;
      const filename = key.slice(sep + 1);
      return {
        filename,
        isSystem: false,
        isOverridden: false,
        category,
        size: Buffer.byteLength(content, 'utf-8'),
        modifiedAt: Date.now(),
        enabled: this._enabledFiles.includes(filename),
      };
    });
  }

  getFile(filename: string, category: ContextCategory): ContextFileContent | null {
    const content = this._files.get(this._key(category, filename));
    if (content === undefined) return null;
    // Паритет с файловой реализацией: прочитанный пользовательский файл —
    // override (системного файла категории `user` нет).
    return { filename, content, isSystem: false, isOverridden: true, category };
  }

  async saveFile(filename: string, content: string, category: ContextCategory): Promise<boolean> {
    this._files.set(this._key(category, filename), content);
    return true;
  }

  async deleteFile(filename: string, category: ContextCategory): Promise<boolean> {
    return this._files.delete(this._key(category, filename));
  }

  async restoreFile(filename: string, category: ContextCategory): Promise<boolean> {
    return this.deleteFile(filename, category);
  }

  getEnabledFiles(): string[] {
    return [...this._enabledFiles];
  }

  setEnabledFiles(files: string[]): void {
    this._enabledFiles = [...files];
  }

  getRolePrompt(): string | null {
    return null;
  }

  getRolesDescription(): string {
    return '';
  }

  getInterviewTemplate(): string {
    return '';
  }

  getParticipantsNotice(): string {
    return '';
  }

  getSchedulerNotice(): string {
    return '';
  }

  getSchedulerTurnNotice(): string {
    return '';
  }

  getMaxStepsPrompt(): string {
    return '';
  }

  getSummarizerPrompt(): string {
    return '';
  }

  getUserContextTemplate(): string {
    return '';
  }

  getCompressedDialogTemplate(): string {
    return '';
  }

  getStickyNotesTemplate(): string {
    return '';
  }

  getRoutingInstructions(): string {
    return '';
  }

  getRules(): string {
    return '';
  }

  getGatewayInstructions(): string {
    return '';
  }

  getMemoryInstructions(): string {
    return '';
  }

  getSecurityMessage(): string | null {
    return null;
  }

  getModePrompt(): string | null {
    return null;
  }

  getPlanModePrompt(): string | null {
    return null;
  }

  getPlanGuide(): string | null {
    return null;
  }

  getModePolicy(): string | null {
    return null;
  }

  getClassificationInstructions(): string {
    return '';
  }
}

/** Порт blob-дерева поверх `Map` (семантика `FileBlobStore`, containment). */
export class MemoryBlobStore implements BlobStore {
  private readonly _blobs = new Map<string, Buffer>();
  /** Время последней записи объекта (мс) — для `stat().mtimeMs`. */
  private readonly _mtimes = new Map<string, number>();

  /** Валидация относительного пути (без выхода за корень). */
  private _validate(path: string): void {
    if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\') || path.includes('\0')) {
      throw new Error(`Недопустимый путь blob: ${path}`);
    }
  }

  async read(path: string): Promise<Buffer | null> {
    this._validate(path);
    const buf = this._blobs.get(path);
    return buf ? Buffer.from(buf) : null;
  }

  async write(path: string, data: Buffer | string, opts?: { mode?: number }): Promise<void> {
    void opts;
    this._validate(path);
    this._blobs.set(path, typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data));
    this._mtimes.set(path, Date.now());
  }

  async append(path: string, data: Buffer | string): Promise<void> {
    this._validate(path);
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data);
    const current = this._blobs.get(path);
    this._blobs.set(path, current ? Buffer.concat([current, chunk]) : chunk);
    this._mtimes.set(path, Date.now());
  }

  async delete(path: string): Promise<void> {
    this._validate(path);
    this._blobs.delete(path);
    this._mtimes.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    this._validate(path);
    return this._blobs.has(path);
  }

  async list(prefix?: string): Promise<Array<{ path: string; size: number }>> {
    const base = (prefix ?? '').replace(/^\/+|\/+$/g, '');
    if (base) this._validate(base);
    const entries: Array<{ path: string; size: number }> = [];
    for (const [path, data] of this._blobs) {
      if (base && path !== base && !path.startsWith(`${base}/`)) continue;
      entries.push({ path, size: data.byteLength });
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** ADR-115: метаданные объекта (размер/mtime); `null` — объекта нет. */
  async stat(path: string): Promise<BlobStat | null> {
    this._validate(path);
    const buf = this._blobs.get(path);
    if (!buf) return null;
    return { size: buf.byteLength, mtimeMs: this._mtimes.get(path) ?? 0 };
  }

  /**
   * ADR-115: потоковое чтение объекта; диапазон — включительно с обоих
   * концов (как у `fs`). `null` — объекта нет.
   */
  async readStream(path: string, opts?: BlobReadRange): Promise<Readable | null> {
    this._validate(path);
    const buf = this._blobs.get(path);
    if (!buf) return null;
    const start = opts?.start !== undefined ? Math.max(0, opts.start) : 0;
    const end = opts?.end !== undefined ? opts.end : buf.byteLength - 1;
    const chunk = buf.subarray(start, end + 1);
    return Readable.from([chunk]);
  }
}

/** Публичные метаданные SSH-ключа (без секретов). */
function toMeta(record: SSHKey): SSHKeyMeta {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    agentIds: [...record.agentIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Порт хранилища SSH-ключей поверх `Map`.
 *
 * В памяти секреты не шифруются at-rest (шифровать нечего — состояние в
 * процессе): храним ключи как есть. Публичные методы секретов не отдают;
 * `reveal` возвращает приватный ключ/passphrase. `listRaw` секреты **не** отдаёт
 * (в файловой реализации там cifrtext для ротации; здесь шифрования нет, поэтому
 * «сырой» доступ без секретов). `rotateMasterKey` — валидная no-op-обёртка
 * (`total`/`skipped` = число записей, остальное 0) без обращения к ФС.
 */
export class MemorySSHKeyRepository implements SSHKeyRepository {
  private readonly _keys = new Map<string, SSHKey>();

  async list(): Promise<SSHKeyMeta[]> {
    return [...this._keys.values()].map(toMeta).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listRaw(): Promise<SSHKey[]> {
    return [...this._keys.values()].map((record) => {
      const { privateKey, passphrase, ...rest } = record;
      void privateKey;
      void passphrase;
      return rest as unknown as SSHKey;
    });
  }

  async rotateMasterKey(
    oldKey: Buffer,
    newKey: Buffer,
    opts?: RotateMasterKeyOptions,
  ): Promise<RotateMasterKeyResult> {
    void oldKey;
    void newKey;
    void opts;
    const total = this._keys.size;
    return { total, rotated: 0, upgraded: 0, skipped: total, ids: [] };
  }

  async listForAgent(agentId: string): Promise<SSHKeyMeta[]> {
    return (await this.list()).filter((key) => key.agentIds.includes(agentId));
  }

  async get(id: string): Promise<SSHKeyMeta | null> {
    const record = this._keys.get(id);
    return record ? toMeta(record) : null;
  }

  async create(input: SSHKeyCreateRequest): Promise<SSHKeyMeta> {
    if (!input.privateKey || input.privateKey.trim() === '') {
      throw new SSHKeyStoreError('invalid', 'Приватный ключ не может быть пустым');
    }
    for (const record of this._keys.values()) {
      if (record.name.toLowerCase() === input.name.toLowerCase()) {
        throw new SSHKeyStoreError('name_exists', `SSH-ключ "${input.name}" уже существует`);
      }
    }
    const now = nowISO();
    const record: SSHKey = {
      id: randomUUID(),
      name: input.name,
      type: input.type ?? 'user',
      privateKey: input.privateKey,
      passphrase: input.passphrase,
      agentIds: input.agentIds ? [...input.agentIds] : [],
      createdAt: now,
      updatedAt: now,
    };
    this._keys.set(record.id, record);
    return toMeta(record);
  }

  async update(id: string, patch: SSHKeyUpdateRequest): Promise<SSHKeyMeta | null> {
    const record = this._keys.get(id);
    if (!record) return null;

    const nextName = patch.name;
    if (nextName !== undefined && nextName.toLowerCase() !== record.name.toLowerCase()) {
      for (const other of this._keys.values()) {
        if (other.id !== id && other.name.toLowerCase() === nextName.toLowerCase()) {
          throw new SSHKeyStoreError('name_exists', `SSH-ключ "${nextName}" уже существует`);
        }
      }
    }
    if (patch.privateKey !== undefined) {
      if (!patch.privateKey || patch.privateKey.trim() === '') {
        throw new SSHKeyStoreError('invalid', 'Приватный ключ не может быть пустым');
      }
      record.privateKey = patch.privateKey;
    }
    if (patch.passphrase !== undefined) record.passphrase = patch.passphrase;
    if (nextName !== undefined) record.name = nextName;
    if (patch.type !== undefined) record.type = patch.type;
    if (patch.agentIds !== undefined) record.agentIds = [...patch.agentIds];
    record.updatedAt = nowISO();
    return toMeta(record);
  }

  async delete(id: string): Promise<boolean> {
    return this._keys.delete(id);
  }

  async linkAgent(id: string, agentId: string): Promise<SSHKeyMeta | null> {
    const record = this._keys.get(id);
    if (!record) return null;
    if (!record.agentIds.includes(agentId)) record.agentIds = [...record.agentIds, agentId];
    record.updatedAt = nowISO();
    return toMeta(record);
  }

  async unlinkAgent(id: string, agentId: string): Promise<SSHKeyMeta | null> {
    const record = this._keys.get(id);
    if (!record) return null;
    record.agentIds = record.agentIds.filter((a) => a !== agentId);
    record.updatedAt = nowISO();
    return toMeta(record);
  }

  async reveal(id: string): Promise<{ privateKey: string; passphrase?: string } | null> {
    const record = this._keys.get(id);
    if (!record) return null;
    return record.passphrase === undefined
      ? { privateKey: record.privateKey }
      : { privateKey: record.privateKey, passphrase: record.passphrase };
  }
}

/**
 * Порт пайплайнов (определения + экземпляры) поверх `Map`
 * (ADR-051/ADR-100, реализация — `FilePipelineStore`).
 *
 * Семантика повторяет файловую реализацию: upsert определения по `id`
 * (`createdAt` сохраняется, `updatedAt` монотонно обновляется), детерминированный
 * порядок определений (по `id`), выборка экземпляров «свежие первыми» с
 * фильтрами `pipelineId`/`status` и потолком `limit`.
 * Возвращаемые записи — копии (`structuredClone`), как в остальных memory-портах.
 */
export class MemoryPipelineRepository implements PipelineRepository {
  private readonly _definitions = new Map<string, PipelineDefinitionRecord>();
  private readonly _instances = new Map<string, PipelineInstanceRecord>();

  async saveDefinition(def: PipelineDefinitionRecord): Promise<void> {
    const stored = this._definitions.get(def.id);
    this._definitions.set(def.id, {
      ...structuredClone(def),
      createdAt: resolveCreatedAt(stored?.createdAt, def.createdAt),
      updatedAt: resolveUpdatedAt(stored?.updatedAt, def.updatedAt),
    });
  }

  async getDefinition(id: string): Promise<PipelineDefinitionRecord | null> {
    const record = this._definitions.get(id);
    return record ? structuredClone(record) : null;
  }

  async listDefinitions(): Promise<PipelineDefinitionRecord[]> {
    return [...this._definitions.values()]
      .map((d) => structuredClone(d))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async deleteDefinition(id: string): Promise<boolean> {
    return this._definitions.delete(id);
  }

  async saveInstance(instance: PipelineInstanceRecord): Promise<void> {
    const stored = this._instances.get(instance.id);
    this._instances.set(instance.id, {
      ...structuredClone(instance),
      createdAt: resolveCreatedAt(stored?.createdAt, instance.createdAt),
      updatedAt: resolveUpdatedAt(stored?.updatedAt, instance.updatedAt),
    });
  }

  async getInstance(id: string): Promise<PipelineInstanceRecord | null> {
    const record = this._instances.get(id);
    return record ? structuredClone(record) : null;
  }

  async listInstances(filter?: PipelineInstanceFilter): Promise<PipelineInstanceRecord[]> {
    const filtered = [...this._instances.values()].filter(
      (i) =>
        (filter?.pipelineId === undefined || i.pipelineId === filter.pipelineId) &&
        (filter?.status === undefined || i.status === filter.status),
    );
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    const sorted = [...filtered].sort((a, b) => {
      const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id.localeCompare(b.id);
    });
    return sorted.slice(0, resolvePipelineInstanceLimit(filter?.limit)).map((i) => structuredClone(i));
  }
}

/**
 * Порт реестра установок пакетов расширений поверх `Map`
 * (ADR-086 §5, реализация — `FilePackStore`).
 *
 * Семантика повторяет файловую реализацию: upsert по имени пакета
 * (`installedAt` сохраняется, `updatedAt` обновляется), детерминированный
 * порядок списка (по имени), удаление — `true`/`false`.
 */
export class MemoryPackRepository implements PackRepository {
  private readonly _packs = new Map<string, PackInstallation>();

  async save(pack: PackInstallation): Promise<void> {
    const stored = this._packs.get(pack.name);
    this._packs.set(pack.name, {
      ...structuredClone(pack),
      installedAt: resolveCreatedAt(stored?.installedAt, pack.installedAt),
      updatedAt: resolveUpdatedAt(stored?.updatedAt, pack.updatedAt),
    });
  }

  async get(name: string): Promise<PackInstallation | null> {
    const record = this._packs.get(name);
    return record ? structuredClone(record) : null;
  }

  async list(): Promise<PackInstallation[]> {
    return [...this._packs.values()]
      .map((p) => structuredClone(p))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(name: string): Promise<boolean> {
    return this._packs.delete(name);
  }
}
