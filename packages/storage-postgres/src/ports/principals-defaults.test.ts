/**
 * Unit-тесты порта умолчаний оформления PostgreSQL-драйвера (ADR-097).
 *
 * Живая БД не нужна — подменяется соединение (`PostgresConnection`): запросы
 * фиксируются, а строка секции `defaults` отдаётся из подготовленного объекта.
 * Проверяется паритет санитизации с файловой реализацией
 * (`@itphx/synth-core`, `storage/defaults-store.ts`): неизвестные значения
 * отбрасываются, известные — сохраняются.
 */

import { describe, expect, it } from 'vitest';
import type { PostgresConnection, PostgresExecutor } from '../pool.js';
import { createPrincipalDefaultsPort } from './principals-defaults.js';

type Row = Record<string, unknown>;

/** Зафиксированный запрос. */
interface RecordedQuery {
  text: string;
  params: unknown[];
}

/** Подменённое соединение: `SELECT` отдаёт подготовленную секцию, `INSERT` пишется. */
function makeConn(stored?: Record<string, unknown>): {
  connection: PostgresConnection;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const executor = {
    query: (async (text: string, params: unknown[] = []): Promise<Row[]> => {
      queries.push({ text, params });
      if (/^\s*SELECT/i.test(text)) {
        return stored === undefined ? [] : [{ value: stored }];
      }
      return [];
    }) as PostgresExecutor['query'],
  };
  const connection = {
    query: executor.query,
    withTransaction: async <T>(fn: (tx: PostgresExecutor) => Promise<T>): Promise<T> => fn(executor),
  };
  return { connection: connection as unknown as PostgresConnection, queries };
}

/** Объект, записанный в секцию `settings` (из JSON-параметра INSERT). */
function writtenValue(queries: RecordedQuery[]): Record<string, unknown> {
  const insert = queries.find((q) => /^\s*INSERT/i.test(q.text));
  if (!insert) throw new Error('INSERT не найден');
  return JSON.parse(String(insert.params[1])) as Record<string, unknown>;
}

describe('Postgres — порт умолчаний оформления', () => {
  it('loadDefaults отбрасывает неизвестные значения рендера', async () => {
    const { connection } = makeConn({
      locale: 'en',
      chatDensity: 'compact',
      userMessageMarkdown: 'yes',
      mermaidRenderingMode: 3,
    });

    const defaults = await createPrincipalDefaultsPort(connection).loadDefaults();

    expect(defaults).toEqual({ locale: 'en', chatDensity: 'compact' });
  });

  it('loadDefaults отдаёт сохранённые значения рендера', async () => {
    const { connection } = makeConn({
      userMessageMarkdown: 'plain',
      mermaidRenderingMode: 'ascii',
    });

    const defaults = await createPrincipalDefaultsPort(connection).loadDefaults();

    expect(defaults).toEqual({ userMessageMarkdown: 'plain', mermaidRenderingMode: 'ascii' });
  });

  it('saveDefaults сохраняет известные значения и не пишет мусор', async () => {
    const { connection, queries } = makeConn({ locale: 'ru' });

    const saved = await createPrincipalDefaultsPort(connection).saveDefaults({
      userMessageMarkdown: 'plain',
      mermaidRenderingMode: 'off',
    });

    expect(saved).toEqual({
      locale: 'ru',
      userMessageMarkdown: 'plain',
      mermaidRenderingMode: 'off',
    });
    expect(writtenValue(queries)).toEqual(saved);
  });

  it('saveDefaults отбрасывает невалидный патч, не затирая текущие значения', async () => {
    const { connection, queries } = makeConn({ locale: 'en', userMessageMarkdown: 'plain' });

    const saved = await createPrincipalDefaultsPort(connection).saveDefaults({
      userMessageMarkdown: 'yes' as never,
      mermaidRenderingMode: null as never,
    });

    expect(saved).toEqual({ locale: 'en', userMessageMarkdown: 'plain' });
    expect(writtenValue(queries)).toEqual(saved);
  });
});
