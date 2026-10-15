/**
 * In-memory реализации «контентных» портов: скиллы, bundles, файлы контекста,
 * blob-хранилище и SSH-ключи (PROP-032, шаг W2.2).
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
  BlobStore,
  ContextFileRepository,
  SSHKeyRepository,
  SkillBundleRepository,
  SkillRepository,
} from '../ports/index.js';

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

/** Порт instance-скиллов — дерево в `Map`, виртуальные пути `/memory/skills`. */
export class MemorySkillRepository implements SkillRepository {
  private readonly _skills = new Map<string, MemorySkill>();
  /** supporting-файлы: ключ `\`${name}\0${rel}\`` (независимо от наличия `SKILL.md`). */
  private readonly _files = new Map<string, string>();

  private _fileKey(name: string, rel: string): string {
    return `${name}\0${rel}`;
  }

  root(): string {
    return '/memory/skills';
  }

  skillDir(name: string): string {
    assertSkillName(name);
    return `${this.root()}/${name}`;
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
    this._skills.set(input.name, {
      markdown: stringifyFrontmatter({ name: input.name, description: input.description }, input.body ?? ''),
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
      };
    });
  }

  getFile(filename: string, category: ContextCategory): ContextFileContent | null {
    const content = this._files.get(this._key(category, filename));
    if (content === undefined) return null;
    return { filename, content, isSystem: false, isOverridden: false, category };
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
  }

  async delete(path: string): Promise<void> {
    this._validate(path);
    this._blobs.delete(path);
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
