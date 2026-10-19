import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextConfig } from './config.js';

/**
 * Инварианты ролевых промптов (ADR-041/шаблон ролей):
 * - у роли `publisher` факты берутся из payload внешнего события (у агента нет доступа к репозиторию);
 * - секция [CONTENT RULES] — шаблонная, должна быть побайтово идентична роли `analyst`.
 */
describe('ролевые промпты — publisher', () => {
  let ctx: ContextConfig;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-role-prompts-'));
    ctx = new ContextConfig({ userDataDir: join(tmpDir, 'context') });
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Содержимое секции `[HEADER]` (до следующей секции верхнего уровня). */
  function section(text: string, header: string): string {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.trim() === header);
    if (start < 0) return '';
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^\[[A-Z]/.test(l.trim()));
    return (end < 0 ? rest : rest.slice(0, end)).join('\n');
  }

  function rolePrompt(role: string, language: string): string {
    return ctx.getRolePrompt(role, undefined, language) ?? '';
  }

  function firstPrinciple(text: string): string {
    const match = section(text, '[PRINCIPLES]').match(/^1\.\s+(.*)$/m);
    return match?.[1] ?? '';
  }

  for (const language of ['ru', 'en']) {
    it(`${language}: ролевой промпт publisher загружается и содержит все секции`, () => {
      const text = rolePrompt('publisher', language);
      expect(text.length).toBeGreaterThan(0);
      for (const header of ['[ROLE: PUBLISHER]', '[COMPETENCIES]', '[PRINCIPLES]', '[CONTENT RULES]', '[ATTRIBUTION]']) {
        expect(text, `секция ${header}`).toContain(header);
      }
    });

    it(`${language}: принцип 1 — факты только из payload события, не из репозитория`, () => {
      const principle = firstPrinciple(rolePrompt('publisher', language));
      expect(principle).toContain('payload');
      expect(principle).toContain('sourceRefs');
      // доступа к репозиторию у агента нет — таких указаний быть не должно
      expect(principle).not.toContain('git/');
      expect(principle).not.toContain('CHANGELOG');
      expect(principle).not.toContain('git log');
    });

    it(`${language}: компетенции — работа с payload внешнего события, а не сбор фактов из репозитория`, () => {
      const competencies = section(rolePrompt('publisher', language), '[COMPETENCIES]');
      expect(competencies).toContain('payload');
      expect(competencies).not.toContain('git log');
      expect(competencies).not.toContain('CHANGELOG');
    });

    it(`${language}: [CONTENT RULES] побайтово идентична роли analyst`, () => {
      const publisherRules = section(rolePrompt('publisher', language), '[CONTENT RULES]');
      const analystRules = section(rolePrompt('analyst', language), '[CONTENT RULES]');
      expect(publisherRules.length).toBeGreaterThan(0);
      expect(publisherRules).toBe(analystRules);
    });
  }
});
