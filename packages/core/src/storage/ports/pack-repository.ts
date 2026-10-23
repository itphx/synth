/**
 * Порт реестра установок пакетов расширений (ADR-086 §5, PROP-068/ADR-090).
 *
 * Реестр — «что установлено в этот инстанс»: имя пакета, версия, класс
 * расширения, статус установки, перечень поставленных в инстанс сущностей
 * (`provides` — id'ы агентов/скиллов/MCP-серверов/пайплайнов) и сырой манифест
 * `synth.pack` для аудита и «показать детали» в UI.
 *
 * Идентификатором записи служит **имя пакета** (уникально в инстансе) — по нему
 * идёт upsert и удаление (снятие установки). Имя/версия/манифест — контракты
 * `@itphx/synth-shared` (`packNameSchema`/`packVersionSchema`/`PackManifest`);
 * здесь они не дублируются.
 */
import type { CatalogTrustLevel } from '@itphx/synth-shared';

/** Статус установки пакета в инстансе. */
export type PackInstallationStatus = 'active' | 'pending_approval' | 'disabled';

/**
 * Что именно пакет поставил в инстанс (id'ы) — нужно для снятия установки.
 *
 * Это **не** `PackProvides` из shared: манифест описывает вклады как объекты
 * ( `{ id, path }` и т. п.), а реестр хранит плоские списки идентификаторов
 * уже установленных сущностей.
 */
export interface PackInstallationProvides {
  /** id установленных агентов. */
  agents: string[];
  /** id установленных скиллов. */
  skills: string[];
  /** id зарегистрированных MCP-серверов. */
  mcp: string[];
  /** id установленных пайплайнов. */
  pipelines: string[];
}

/** Запись реестра установок пакетов расширений. */
export interface PackInstallation {
  /** Имя пакета (из манифеста) — уникально в инстансе, ключ записи. */
  name: string;
  /** Версия пакета (semver). */
  version: string;
  /** Класс расширения: `plugin`/`gateway`/`addon`/`pack`/`storage` (ADR-086 §5). */
  kind: string;
  /** Тип контент-пака (только для `kind: 'pack'`). */
  packType?: string;
  /** Краткое описание (инспекция/каталог). */
  description?: string;
  /** Статус установки. */
  status: PackInstallationStatus;
  /** Требуется ли подтверждение администратора (пакет даёт capability-гранты). */
  requiresApproval: boolean;
  /** Что этот пакет поставил в инстанс (id'ы) — нужно для удаления. */
  provides: PackInstallationProvides;
  /**
   * ADR-106 Ф5: фактическое доверие пакета (PROP-068 §4.1) — верхняя граница
   * по заявленному в манифесте уровню. Запоминается при установке, потому что
   * одобрение приходит **отдельным** запросом: trust-floor мутирующих грантов
   * считается по нему, а не по манифесту в момент одобрения.
   */
  trustLevel?: CatalogTrustLevel;
  /** Сырой манифест — для аудита и «показать детали» в UI (обычно `PackManifest`). */
  manifest?: unknown;
  /**
   * Файлы пакета (относительные пути → содержимое) — исходники установки.
   *
   * Нужны для **отложенной** установки: пакет с capability-грантами сначала
   * попадает в `pending_approval` (фактическая установка не выполняется), а
   * `POST /packs/:name/approve` доустанавливает его уже без тела запроса —
   * поэтому содержимое файлов (ролевые промпты, определения пайплайнов,
   * `SKILL.md` и supporting-файлы) хранится вместе с манифестом.
   */
  files?: Record<string, string>;
  /** ISO-время установки. */
  installedAt: string;
  /** ISO-время последней записи. */
  updatedAt: string;
  /** Кто установил (userId/keyId установщика). */
  installedBy?: string;
}

/**
 * Порт реестра установок пакетов расширений (ADR-096 — слой хранения).
 */
export interface PackRepository {
  /** Upsert установки по `name` (существующая обновляется). */
  save(pack: PackInstallation): Promise<void>;
  /** Установка по имени (`null`, если не установлен). */
  get(name: string): Promise<PackInstallation | null>;
  /** Все установки (детерминированный порядок — по имени). */
  list(): Promise<PackInstallation[]>;
  /** Снятие установки (`true` — удалено, `false` — не было). */
  delete(name: string): Promise<boolean>;
}
