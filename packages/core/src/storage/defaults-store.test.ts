/**
 * Санитизация умолчаний оформления — файловая реализация (`DefaultsStore`,
 * ADR-096). Хранится один JSON-файл `{dataDir}/defaults.json`; значения,
 * которые не входят в контракт `AppearanceDefaults`, отбрасываются молча
 * (без исключений), чтобы клиент взял свой встроенный дефолт.
 *
 * Здесь — рендер сообщений пользователя (`userMessageMarkdown`) и диаграмм
 * Mermaid (`mermaidRenderingMode`): оба пришли в контракт умолчаний инстанца
 * вместе с личными настройками чата, поэтому проверяем и их санитизацию,
 * и то, что прежние поля не ломаются.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultsStore } from './defaults-store.js';

describe('DefaultsStore — умолчания рендера (разметка сообщений и Mermaid)', () => {
  let tmpDir: string;
  let store: DefaultsStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-defaults-render-'));
    store = new DefaultsStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('сохраняет известные значения разметки и рендера Mermaid', async () => {
    const saved = await store.saveDefaults({
      userMessageMarkdown: 'plain',
      mermaidRenderingMode: 'ascii',
    });
    expect(saved).toEqual({ userMessageMarkdown: 'plain', mermaidRenderingMode: 'ascii' });
    expect(await store.loadDefaults()).toEqual(saved);
  });

  it('отбрасывает неизвестные значения (строка, число, null)', async () => {
    expect(await store.saveDefaults({ userMessageMarkdown: 'yes' as never })).toEqual({});
    expect(await store.saveDefaults({ mermaidRenderingMode: 3 as never })).toEqual({});
    expect(await store.saveDefaults({ userMessageMarkdown: null as never })).toEqual({});
    expect(await store.saveDefaults({ mermaidRenderingMode: null as never })).toEqual({});
    expect(await store.saveDefaults({ userMessageMarkdown: 'html' as never })).toEqual({});
    expect(await store.saveDefaults({ mermaidRenderingMode: 'canvas' as never })).toEqual({});
  });

  it('невалидный патч не затирает ранее сохранённые значения', async () => {
    await store.saveDefaults({
      chatViewMode: 'feed',
      chatDensity: 'compact',
      userMessageMarkdown: 'plain',
    });
    const saved = await store.saveDefaults({
      userMessageMarkdown: 'yes' as never,
      mermaidRenderingMode: 'ascii',
    });
    expect(saved).toEqual({
      chatViewMode: 'feed',
      chatDensity: 'compact',
      userMessageMarkdown: 'plain',
      mermaidRenderingMode: 'ascii',
    });
  });

  it('подчищает невалидные значения из готового файла', async () => {
    await writeFile(
      join(tmpDir, 'defaults.json'),
      JSON.stringify({
        userMessageMarkdown: 'yes',
        mermaidRenderingMode: 'svg',
        chatDensity: 'compact',
      }),
      'utf-8',
    );
    expect(await store.loadDefaults()).toEqual({
      mermaidRenderingMode: 'svg',
      chatDensity: 'compact',
    });
  });

  it('значения переживают рестарт стора', async () => {
    await store.saveDefaults({ userMessageMarkdown: 'plain', mermaidRenderingMode: 'off' });
    const store2 = new DefaultsStore({ dataDir: tmpDir });
    expect(await store2.loadDefaults()).toEqual({
      userMessageMarkdown: 'plain',
      mermaidRenderingMode: 'off',
    });
  });
});
