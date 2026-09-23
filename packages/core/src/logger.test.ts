import { describe, it, expect, beforeEach } from 'vitest';
import {
  setLevelForGroup,
  setGroups,
  setAllGroups,
  getAllGroups,
  resetGroupOverrides,
} from './logger.js';

describe('logger group overrides', () => {
  beforeEach(() => {
    resetGroupOverrides();
  });

  describe('setGroups (merge)', () => {
    it('обновляет переданные группы', () => {
      setGroups({ ROUTES: 'DEBUG', STORAGE: 'ERROR' });

      const groups = getAllGroups();
      expect(groups.ROUTES).toBe('DEBUG');
      expect(groups.STORAGE).toBe('ERROR');
    });

    it('сохраняет ранее установленные overrides других групп', () => {
      setLevelForGroup('OPENAI', 'ERROR');
      setGroups({ ROUTES: 'DEBUG' });

      const groups = getAllGroups();
      expect(groups.ROUTES).toBe('DEBUG');
      expect(groups.OPENAI).toBe('ERROR');
    });

    it('последовательные вызовы по категориям не затирают друг друга', () => {
      setGroups({ OPENAI: 'DEBUG', ANTHROPIC: 'ERROR' });
      setGroups({ ROUTES: 'DEBUG', STORAGE: 'ERROR' });

      const groups = getAllGroups();
      expect(groups.OPENAI).toBe('DEBUG');
      expect(groups.ANTHROPIC).toBe('ERROR');
      expect(groups.ROUTES).toBe('DEBUG');
      expect(groups.STORAGE).toBe('ERROR');
    });

    it('невалидный уровень бросает ошибку', () => {
      expect(() => setGroups({ ROUTES: 'TRACE' })).toThrow('Недопустимый уровень: TRACE');
    });

    it('пустой объект не меняет overrides', () => {
      setLevelForGroup('MCP', 'CRITICAL');
      setGroups({});

      expect(getAllGroups().MCP).toBe('CRITICAL');
    });
  });

  describe('setAllGroups (полный сброс)', () => {
    it('сбрасывает ранее установленные overrides', () => {
      setLevelForGroup('OPENAI', 'ERROR');
      setAllGroups({ ROUTES: 'DEBUG' });

      const groups = getAllGroups();
      expect(groups.ROUTES).toBe('DEBUG');
      expect(groups.OPENAI).toBe('INFO');
    });
  });
});
