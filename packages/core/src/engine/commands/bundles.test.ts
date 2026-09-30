import { describe, it, expect } from 'vitest';
import { parseBundleFile, loadBundle } from './bundles.js';

describe('bundles (AD-046 §7.3)', () => {
  it('parseBundleFile: валидный YAML', () => {
    const raw = [
      'name: backend-dev',
      'description: Backend work',
      'skills:',
      '  - code-review',
      '  - testing',
      'instruction: |',
      '  Доп. инструкция',
    ].join('\n');
    const { bundle, diagnostics } = parseBundleFile(raw, 'backend-dev');
    expect(diagnostics).toEqual([]);
    expect(bundle).toEqual({
      name: 'backend-dev',
      description: 'Backend work',
      skills: ['code-review', 'testing'],
      instruction: 'Доп. инструкция',
    });
  });

  it('parseBundleFile: без скиллов — ошибка', () => {
    const { bundle, diagnostics } = parseBundleFile('name: x\nskills: []\n', 'x');
    expect(bundle).toBeUndefined();
    expect(diagnostics[0]?.code).toBe('invalid-bundle');
  });

  it('parseBundleFile: недопустимое имя — ошибка', () => {
    const { bundle, diagnostics } = parseBundleFile('name: "Bad Name"\nskills: [a]\n', 'x');
    expect(bundle).toBeUndefined();
    expect(diagnostics[0]?.code).toBe('invalid-bundle');
  });

  it('loadBundle: грузит N тел + instruction, отсутствующий скилл — диагностика', async () => {
    const loader = async (name: string) =>
      name === 'ghost' ? undefined : { name, content: `<skill_content name="${name}">body</skill_content>` };
    const res = await loadBundle(
      { name: 'b', description: '', skills: ['a', 'ghost', 'c'], instruction: 'INSTR' },
      loader,
      { maxRenderedBytes: 100_000 },
    );
    expect(res.skills).toEqual(['a', 'c']);
    expect(res.prompt).toContain('INSTR');
    expect(res.prompt).toContain('name="a"');
    expect(res.prompt).toContain('name="c"');
    expect(res.prompt).not.toContain('ghost');
    expect(res.diagnostics.some((d) => d.code === 'missing-skill')).toBe(true);
  });

  it('loadBundle: агрегатный cap maxRenderedBytes', async () => {
    const loader = async (name: string) => ({ name, content: 'x'.repeat(200) });
    const res = await loadBundle(
      { name: 'b', description: '', skills: ['a', 'b'] },
      loader,
      { maxRenderedBytes: 100 },
    );
    expect(Buffer.byteLength(res.prompt, 'utf-8')).toBeLessThanOrEqual(100 + 64);
    expect(res.diagnostics.some((d) => d.message.includes('обрезан'))).toBe(true);
  });
});
