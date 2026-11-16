import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBuiltinSkills, SYNTH_HTML_REPORT_NAME } from './builtin.js';
import { collectSupportingFiles, listSupportingFiles, readSkillSupportingFile } from './loader.js';

/**
 * ADR-126 §15: builtin-скилл `synth-html-report` поставляется каталогом
 * `prompts/skills/<name>` — supporting-файлы (CSS, логотип, чекер) читаются
 * тулом `skill` (base directory вне рабочего каталога проекта).
 */
const skill = buildBuiltinSkills().find((s) => s.name === SYNTH_HTML_REPORT_NAME);

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'synth-html-report-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('builtin synth-html-report: supporting-файлы', () => {
  it('скилл найден и указывает на реальный каталог', () => {
    expect(skill).toBeDefined();
    expect(existsSync(skill!.file)).toBe(true);
    expect(existsSync(join(skill!.dir, 'assets', 'logo.svg'))).toBe(true);
    expect(existsSync(join(skill!.dir, 'scripts', 'check_html.mjs'))).toBe(true);
  });

  it('collectSupportingFiles находит assets/ и scripts/ (без SKILL.md)', async () => {
    const files = await collectSupportingFiles(skill!.dir);
    expect(files).toEqual(expect.arrayContaining([
      'assets/logo.svg',
      'assets/report.css',
      'scripts/check_html.mjs',
    ]));
    expect(files).not.toContain('SKILL.md');
    // Сортировка — как в loader'е (стабильный порядок в выдаче тула `skill`).
    expect([...files].sort()).toEqual(files);
  });

  it('listSupportingFiles идёт по каталогу скилла (ФС-источник)', async () => {
    const files = await listSupportingFiles(skill!);
    expect(files).toEqual(expect.arrayContaining([
      'assets/logo.svg',
      'assets/report.css',
      'scripts/check_html.mjs',
    ]));
  });

  it('readSkillSupportingFile отдаёт содержимое файлов скилла', async () => {
    const css = await readSkillSupportingFile(skill!, 'assets/report.css');
    expect(css).toBeDefined();
    expect(css!.length).toBeGreaterThan(0);

    const logo = await readSkillSupportingFile(skill!, 'assets/logo.svg');
    expect(logo).toContain('<svg');
    expect(logo).toContain('currentColor');

    const checker = await readSkillSupportingFile(skill!, 'scripts/check_html.mjs');
    expect(checker).toContain('#!/usr/bin/env node');
  });

  it('readSkillSupportingFile не выходит за каталог скилла и не падает на отсутствии', async () => {
    expect(await readSkillSupportingFile(skill!, '../SKILL.md')).toBeUndefined();
    expect(await readSkillSupportingFile(skill!, 'assets/nope.css')).toBeUndefined();
  });
});

describe('builtin synth-html-report: scripts/check_html.mjs', () => {
  it('валидный отчёт — exit 0 и «OK» в выводе', () => {
    const file = join(tmp, 'report.html');
    const html = [
      '<!DOCTYPE html>',
      '<html lang="ru">',
      '<head><meta charset="utf-8" /><title>Отчёт</title>',
      '<style>body { color: #111; }</style></head>',
      '<body>',
      '<nav class="toc"><a href="#s1">Раздел</a></nav>',
      '<h2 id="s1">Раздел</h2>',
      '<table><tr><td>x</td></tr></table>',
      '<div class="callout ok"><span class="badge ok">ok</span></div>',
      '<script>if (1 < 2) { console.log("<div>"); }</script>',
      '</body>',
      '</html>',
    ].join('\n');
    writeFileSync(file, html, 'utf-8');

    const script = join(skill!.dir, 'scripts', 'check_html.mjs');
    const out = execFileSync(process.execPath, [script, file], { encoding: 'utf-8' });
    expect(out).toContain('OK');
    expect(out).toContain('Разделов h2: 1');
  });

  it('битый отчёт — exit 1 (незакрытый тег и якорь без id)', async () => {
    const script = join(skill!.dir, 'scripts', 'check_html.mjs');

    const anchorFile = join(tmp, 'anchor.html');
    await writeFile(
      anchorFile,
      '<!DOCTYPE html>\n<html lang="ru">\n<head><meta charset="utf-8"><style>a{}</style></head>\n'
      + '<body><a href="#missing">x</a></body>\n</html>\n',
      'utf-8',
    );
    const anchorRun = spawnSync(process.execPath, [script, anchorFile], { encoding: 'utf-8' });
    expect(anchorRun.status).toBe(1);
    expect(anchorRun.stdout).toContain('не находит id');

    const tagFile = join(tmp, 'tag.html');
    await writeFile(
      tagFile,
      '<!DOCTYPE html>\n<html lang="ru">\n<head><meta charset="utf-8"><style>a{}</style></head>\n'
      + '<body><div>\n',
      'utf-8',
    );
    const tagRun = spawnSync(process.execPath, [script, tagFile], { encoding: 'utf-8' });
    expect(tagRun.status).toBe(1);
    expect(tagRun.stdout).toContain('не закрыт <div>');
  });

  it('без аргумента — exit 2 (неверное использование)', () => {
    const script = join(skill!.dir, 'scripts', 'check_html.mjs');
    const run = spawnSync(process.execPath, [script], { encoding: 'utf-8' });
    expect(run.status).toBe(2);
  });
});
