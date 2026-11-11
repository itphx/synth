/**
 * Общий предел вывода инструментов в точке вызова тула (`executeToolDef`).
 *
 * Проверяем правила chokepoint'а:
 * - успешный результат длиннее лимита усекается (маркер + `metadata.truncated`
 *   + `metadata.outputBounded`);
 * - результат, который тул **сам** усек по своему лимиту (`metadata.truncated`),
 *   общий бунд всё равно применяет — тул не может отключить предел вывода;
 * - результат, который тул **сам уложил в общий бюджет**
 *   (`metadata.outputBounded`), в пределах лимита повторно не режется, но
 *   сам маркер **не отменяет** общий предел: поддельный маркер с выводом
 *   больше бюджета приводит к усечению (аудит 0.13.8 — исключение
 *   `tool-output-cap-bypass-via-metadata`);
 * - маркер усечения самого тула (`metadata.truncationNote`) не теряется, когда
 *   общий бунд срезает хвост вывода;
 * - маркеры усечения и исключений (`metadata.excludedNote`) доезжают оба;
 * - результат с ошибкой (`isError`) не трогается;
 * - лимиты берутся из `ctx.extra.toolOutputLimits`, без них — дефолты секции
 *   `tools` (2000 строк / 51200 байт).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolCapability, type ToolContext, type ToolDefinition } from '@itphx/synth-shared';
import { executeToolDef } from './tool-execution.js';
import { t as sm } from '../system-messages.js';

function toolOf(
  execute: ToolDefinition['execute'],
): ToolDefinition {
  return {
    name: 'tool_test',
    description: 'тестовый тул',
    parameters: z.object({}),
    capabilities: [ToolCapability.SEARCH],
    execute,
  };
}

function ctxWith(extra?: Record<string, unknown>): ToolContext {
  return {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    workingDir: '/workspace',
    ...(extra ? { extra } : {}),
  };
}

describe('executeToolDef — общий предел вывода', () => {
  it('результат длиннее лимита усекается: маркер, truncated и outputBounded', async () => {
    const tool = toolOf(async () => ({ content: ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n') }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 2, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.isError).toBeFalsy();
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.outputBounded).toEqual({ shownLines: 2, totalLines: 5 });
    expect(result.content.startsWith('l1\nl2')).toBe(true);
    expect(result.content).not.toContain('l3');
    expect(result.content).toContain('Output truncated');
  });

  it('результат в лимите не трогается', async () => {
    const tool = toolOf(async () => ({ content: 'l1\nl2' }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 5, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.content).toBe('l1\nl2');
    expect(result.metadata?.truncated).toBeUndefined();
    expect(result.metadata?.outputBounded).toBeUndefined();
  });

  it('тул, усекший результат по счёту (metadata.truncated), всё равно режется общим бундом', async () => {
    // Семантика `metadata.truncated` изменена (инцидент 2026-11-08): флаг
    // означает «тул усек результат по своему лимиту» (пагинация read_file,
    // число совпадений grep_files), а НЕ «тул уже уложился в байтовый бюджет».
    // Прежде этот флаг полностью отключал общий предел — из-за этого
    // grep_files с одной строкой в 236 КБ унёс в контекст модели 243 КБ.
    const content = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const tool = toolOf(async () => ({
      content,
      metadata: { truncated: true },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 2, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.outputBounded).toEqual({ shownLines: 2, totalLines: 5 });
    expect(result.content.startsWith('l1\nl2')).toBe(true);
    expect(result.content).not.toContain('l3');
    expect(result.content).toContain(sm('tool.output_bounded', { shown: '2', total: '5' }));
  });

  it('тул, усекший результат по счёту и уложившийся в бюджет, не трогается', async () => {
    const note = sm('search.matches_truncated', { shown: '2', total: '5' });
    const content = ['l1', 'l2', note].join('\n');
    const tool = toolOf(async () => ({
      content,
      metadata: { truncated: true, truncationNote: note },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 100, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.content).toBe(content);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.outputBounded).toBeUndefined();
  });

  it('маркер усечения самого тула не теряется, когда общий бунд срезает хвост', async () => {
    // Тул усек результат по счёту и пометил свой маркер (`truncationNote`),
    // общий бунд срезает хвост — маркер тула возвращается в конец вывода.
    const note = sm('search.matches_truncated', { shown: '2', total: '5' });
    const content = ['l1', 'l2', 'l3', 'l4', note].join('\n');
    const tool = toolOf(async () => ({
      content,
      metadata: { truncated: true, truncationNote: note },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 2, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.content).toContain(note);
    expect(result.content).toContain(sm('tool.output_bounded', { shown: '2', total: '5' }));
    // Маркер не продублирован: в выводе он ровно один раз.
    expect(result.content.split(note).length - 1).toBe(1);
  });

  it('маркеры усечения и исключений не теряются, когда общий бунд срезает хвост', async () => {
    // grep_files оставляет два маркера: «показаны не все совпадения» и
    // «скрыто совпадений в исключённых путях». Общий бунд срезает хвост —
    // оба маркера должны дойти до модели.
    const truncation = sm('search.matches_truncated', { shown: '2', total: '5' });
    const excluded = sm('search.matches_excluded', { count: '3', categories: '*.map, node_modules' });
    const content = ['l1', 'l2', 'l3', 'l4', truncation, excluded].join('\n');
    const tool = toolOf(async () => ({
      content,
      metadata: {
        truncated: true,
        truncationNote: truncation,
        excludedNote: excluded,
        excludedMatches: 3,
      },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 2, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.content).toContain(truncation);
    expect(result.content).toContain(excluded);
    // Каждый маркер — ровно один раз.
    expect(result.content.split(truncation).length - 1).toBe(1);
    expect(result.content.split(excluded).length - 1).toBe(1);
    // Счётчик скрытых совпадений не теряется.
    expect(result.metadata?.excludedMatches).toBe(3);
  });

  it('тул, пометивший вывод как уложенный в бюджет (metadata.outputBounded), в пределах лимита не режется повторно', async () => {
    // Маркер тула больше **не отменяет** общий предел — решение принимает
    // фактический размер вывода. Если вывод действительно в бюджете, он
    // остаётся как есть, а собственный маркер/счётчики тула сохраняются
    // (второго маркера усечения не появляется).
    const content = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const tool = toolOf(async () => ({
      content,
      metadata: { truncated: true, outputBounded: { shownLines: 5, totalLines: 5 } },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 100, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.content).toBe(content);
    expect(result.metadata?.truncated).toBe(true);
    // Счётчики тула не переписаны: усечения не было.
    expect(result.metadata?.outputBounded).toEqual({ shownLines: 5, totalLines: 5 });
  });

  it('тул подставил metadata.outputBounded с поддельными счётчиками — вывод всё равно усекается', async () => {
    // Негативный кейс: маркер «уже в бюджете» не отменяет общий предел.
    const content = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const tool = toolOf(async () => ({
      content,
      metadata: { truncated: true, outputBounded: { shownLines: 1, totalLines: 1 } },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 2, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.metadata?.truncated).toBe(true);
    // В metadata — фактические счётчики, а не поддельные от тула.
    expect(result.metadata?.outputBounded).toEqual({ shownLines: 2, totalLines: 5 });
    expect(result.content.startsWith('l1\nl2')).toBe(true);
    expect(result.content).not.toContain('l3');
    expect(result.content).toContain(sm('tool.output_bounded', { shown: '2', total: '5' }));
  });

  it('тул подставил metadata.outputBounded = true — общий предел всё равно применяется', async () => {
    // Форма пробы аудита 0.13.8: 600 001 байт и маркер от тула.
    const tool = toolOf(async () => ({
      content: 'x'.repeat(600_001),
      metadata: { outputBounded: true },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 2000, maxBytes: 51200 } }),
      'tool_test',
    );

    expect(result.metadata?.truncated).toBe(true);
    // Поддельный маркер перезаписан фактическим.
    expect(result.metadata?.outputBounded).toEqual({ shownLines: 1, totalLines: 1 });
    // В контекст ушло не больше байтового бюджета (без маркера усечения).
    expect(Buffer.byteLength(result.content.split('\n\n')[0]!, 'utf8')).toBeLessThanOrEqual(51_200);
    expect(result.content).toContain(sm('tool.output_bounded', { shown: '1', total: '1' }));
  });

  it('метаданные пагинации тула (truncated/totalLines/offset/limit) не теряются', async () => {
    // read_file/list_directory: тул усек страницу по своему лимиту — общий
    // бунд не отменяет его метаданные, они остаются в результате.
    const note = sm('fsread.truncated', { count: '2', next: '2' });
    const content = ['1: a', '2: b', note].join('\n');
    const tool = toolOf(async () => ({
      content,
      metadata: {
        path: '/workspace/a.ts',
        type: 'file',
        totalLines: 10,
        offset: 0,
        limit: 2,
        truncated: true,
        truncationNote: note,
      },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 100, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.metadata).toMatchObject({
      path: '/workspace/a.ts',
      type: 'file',
      totalLines: 10,
      offset: 0,
      limit: 2,
      truncated: true,
    });
    expect(result.content).toContain('1: a');
    expect(result.content).toContain(note);
  });

  it('результат с ошибкой (isError) не усекается', async () => {
    const content = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const tool = toolOf(async () => ({
      content,
      isError: true,
      metadata: { reason: 'failed' },
    }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 2, maxBytes: 1000 } }),
      'tool_test',
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe(content);
    expect(result.metadata?.truncated).toBeUndefined();
    expect(result.metadata?.outputBounded).toBeUndefined();
  });

  it('лимиты берутся из ctx.extra.toolOutputLimits', async () => {
    const tool = toolOf(async () => ({ content: 'a'.repeat(100) }));

    const result = await executeToolDef(
      tool,
      {},
      ctxWith({ toolOutputLimits: { maxLines: 100, maxBytes: 10 } }),
      'tool_test',
    );

    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.outputBounded).toEqual({ shownLines: 1, totalLines: 1 });
    // Байтовый лимит (10) жёстче лимита строк (100).
    expect(Buffer.byteLength(result.content.split('\n\n')[0]!, 'utf8')).toBeLessThanOrEqual(10);
  });

  it('без лимитов в extra — дефолт секции tools (2000 строк / 51200 байт)', async () => {
    const tool = toolOf(async () => ({ content: 'x'.repeat(60_000) }));

    const result = await executeToolDef(tool, {}, ctxWith(), 'tool_test');

    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.outputBounded).toEqual({ shownLines: 1, totalLines: 1 });
    expect(Buffer.byteLength(result.content.split('\n\n')[0]!, 'utf8')).toBeLessThanOrEqual(51_200);
  });

  it('вывод в дефолтных лимитах не усекается', async () => {
    const tool = toolOf(async () => ({ content: 'x'.repeat(1000) }));

    const result = await executeToolDef(tool, {}, ctxWith(), 'tool_test');

    expect(result.metadata?.truncated).toBeUndefined();
    expect(result.content).toBe('x'.repeat(1000));
  });
});
