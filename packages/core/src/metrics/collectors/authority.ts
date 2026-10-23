/**
 * ADR-094: метрики решений Authority-слоя (ADR-106 Ф1).
 *
 * Каталог:
 * - `synth_authority_decisions_total{action,effect,source}` — посчитанные
 *   решения Authority-слоя по действию, эффекту и оси, давшей решение.
 *
 * ## Контракт ADR-094
 *
 * - имена — только `synth_*`;
 * - лейблы — `action`/`effect`/`source` (ADR-106 Ф1: «метрики
 *   `synth_authority_*` (лейблы `action`/`effect`/`source`, без
 *   `user_id`/`session_id`)») — это **аддитивное** расширение списка лейблов
 *   ADR-094 двумя именами (`action`, `effect`); `source` уже входит в
 *   канонический список;
 * - **никаких id**: ни `user_id`, ни `session_id`, ни `turn_id`, ни имён
 *   принципалов, ни сырых путей в лейблах — иначе кардинальность серий
 *   взорвётся, а содержимое журнала утечёт в `/metrics`;
 * - значения лейблов приводятся к **конечным наборам** (`normalize*` ниже):
 *   неизвестное значение → `other`. Доменные действия (из контента пакета) в
 *   метрику не попадают поимённо — иначе кардинальность не ограничена;
 * - ошибка метрик не влияет на ход (вызов обёрнут в try/catch).
 *
 * Модуль **browser-safe**: импортирует только типы `@itphx/synth-shared` и
 * реестр метрик — ни `node:*`, ни файловой системы.
 */
import type { AuthorityDecisionEntry } from '@itphx/synth-shared';

import type { MetricsRegistry } from '../registry.js';

/** Действие в метрике (конечный набор). */
export type AuthorityMetricAction =
  | 'read'
  | 'write'
  | 'execute'
  | 'commit'
  | 'publish'
  | 'approve'
  | 'sign'
  | 'delegate'
  | 'other';

/** Эффект решения в метрике (конечный набор). */
export type AuthorityMetricEffect = 'allow' | 'ask' | 'deny' | 'other';

/** Ось, давшая решение (конечный набор). */
export type AuthorityMetricSource = 'user' | 'agent' | 'session' | 'pack' | 'instance' | 'other';

/**
 * Базовые действия ядра — те же, что в `engine/authority/actions.ts`
 * (`AUTHORITY_CORE_ACTIONS`). Дублирование списка здесь намеренное: модуль
 * метрик не должен тянуть движок (слой метрик — листовой, browser-safe).
 */
const ACTIONS: readonly string[] = [
  'read',
  'write',
  'execute',
  'commit',
  'publish',
  'approve',
  'sign',
  'delegate',
];

const EFFECTS: readonly string[] = ['allow', 'ask', 'deny'];

const SOURCES: readonly string[] = ['user', 'agent', 'session', 'pack', 'instance'];

/** Приведение значения к конечному набору: неизвестное → `other`. */
function normalize(value: string | undefined, allowed: readonly string[]): string {
  if (!value) return 'other';
  return allowed.includes(value) ? value : 'other';
}

/** Нормализация действия (доменные действия → `other`). */
export function normalizeAuthorityAction(value: string | undefined): AuthorityMetricAction {
  return normalize(value, ACTIONS) as AuthorityMetricAction;
}

/** Нормализация эффекта решения. */
export function normalizeAuthorityEffect(value: string | undefined): AuthorityMetricEffect {
  return normalize(value, EFFECTS) as AuthorityMetricEffect;
}

/** Нормализация оси, давшей решение. */
export function normalizeAuthoritySource(value: string | undefined): AuthorityMetricSource {
  return normalize(value, SOURCES) as AuthorityMetricSource;
}

/**
 * Колбэки метрик Authority-слоя — их вызывает shadow-слой
 * (`AuthorityShadowRecorder` через опцию `onDecision`).
 */
export interface AuthorityMetricsHooks {
  /** Посчитано решение (действие/эффект/ось). */
  onDecision: (entry: AuthorityDecisionEntry) => void;
}

/**
 * Создать колбэки метрик Authority-слоя (ADR-094).
 *
 * Реестр метрик — общий (`MetricsRegistry`); новых зависимостей нет.
 */
export function createAuthorityMetrics(registry: MetricsRegistry): AuthorityMetricsHooks {
  const decisions = registry.counter(
    'synth_authority_decisions_total',
    'Total number of Authority-layer decisions by action, effect and source axis.',
    ['action', 'effect', 'source'],
  );

  return {
    onDecision(entry) {
      try {
        decisions.inc({
          action: normalizeAuthorityAction(entry.action),
          effect: normalizeAuthorityEffect(entry.effect),
          source: normalizeAuthoritySource(entry.source),
        });
      } catch {
        // Ошибка метрик не влияет на ход.
      }
    },
  };
}
