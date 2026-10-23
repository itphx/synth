/**
 * ADR-106 Ф1: shadow-интеграция Authority-слоя.
 *
 * ⚠️ **Устарело (Ф2).** Решения теперь считает и применяет `AuthorityGuard`
 * (`engine/authority/guard.ts`) — он же ведёт журнал решений
 * (`{dataDir}/audit/authority.jsonl` через порт `AuthorityDecisionJournal`).
 * Класс оставлен как совместимая обёртка (Ф1-контракт
 * `record`/`flush`/`active`), чтобы не ломать внешние вызовы.
 *
 * Что попадает в журнал: `principal`/`action`/`target`/`effect`/`source`/
 * `reason` — **без секретов и без сырых абсолютных путей** (цель строится
 * относительно workspace, инвариант 25/ADR-094).
 *
 * Расхождение shadow-решения с текущим — **дефект миграции**, а не повод
 * «подкрутить» политику; поэтому в журнал пишется и текущее решение
 * permission-слоя (поле `permissionEffect`).
 */
import { AuthorityGuard, type AuthorityGuardOptions } from './guard.js';

/** Опции shadow-записи (совместимы с опциями guard'а). */
export type AuthorityShadowRecorderOptions = AuthorityGuardOptions;

/**
 * Наблюдатель Authority-слоя (Ф1) — считает решения и пишет их в журнал, но
 * **не применяет** (решение прав не меняется).
 *
 * @deprecated ADR-106 Ф2: используйте `AuthorityGuard` — он же считает и
 * применяет решения (`authority.enabled` + `authority.shadow: false`).
 */
export class AuthorityShadowRecorder extends AuthorityGuard {}
