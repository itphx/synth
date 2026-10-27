import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextConfig } from './config.js';

describe('ContextConfig.getModePrompt (ADR-025)', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-mode-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('встроенный файл prompts/system/MODE_{X}.ru.md существует и загружается (ru)', async () => {
    const config = new ContextConfig({ userDataDir });
    const prompt = config.getModePrompt('plan', 'ru');
    expect(prompt).not.toBeNull();
    expect(prompt!).toContain('[MODE: PLAN]');
    expect(prompt!).toContain('Ты работаешь');

    const act = config.getModePrompt('act', 'ru');
    expect(act).not.toBeNull();
    expect(act!).toContain('[MODE: ACT]');

    const yolo = config.getModePrompt('yolo', 'ru');
    expect(yolo).not.toBeNull();
    expect(yolo!).toContain('[MODE: YOLO]');
  });

  it('getModePrompt(mode, en) возвращает английский контент из MODE_{X}.en.md', async () => {
    const config = new ContextConfig({ userDataDir });

    const plan = config.getModePrompt('plan', 'en')!;
    expect(plan).toContain('[MODE: PLAN]');
    expect(plan).toContain('You are working in **plan** mode');
    expect(plan).not.toContain('Ты работаешь');

    const act = config.getModePrompt('act', 'en')!;
    expect(act).toContain('[MODE: ACT]');
    expect(act).toContain('You are working in **act** mode');

    const yolo = config.getModePrompt('yolo', 'en')!;
    expect(yolo).toContain('[MODE: YOLO]');
    expect(yolo).toContain('You are working in **yolo** mode');
  });

  it('неизвестный язык → null (нет MODE_PLAN.fr.md и базового MODE_PLAN.md)', async () => {
    const config = new ContextConfig({ userDataDir });
    const prompt = config.getModePrompt('plan', 'fr');
    expect(prompt).toBeNull();
  });

  it('встроенный промпт описывает другие режимы и ограничения', async () => {
    const config = new ContextConfig({ userDataDir });
    const prompt = config.getModePrompt('plan', 'ru')!;
    expect(prompt).toContain('act');
    expect(prompt).toContain('yolo');
    expect(prompt).toContain('Не вноси никаких изменений');
  });

  it('override из system-категории приоритетнее встроенного', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'MODE_PLAN.md'), 'ПОЛЬЗОВАТЕЛЬСКИЙ ПРОМПТ PLAN', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    const prompt = config.getModePrompt('plan', 'ru');
    expect(prompt).toBe('ПОЛЬЗОВАТЕЛЬСКИЙ ПРОМПТ PLAN');
  });

  it('локализованный override MODE_PLAN.en.md приоритетнее пользовательского override базового имени MODE_PLAN.md', async () => {
    // Базового системного файла MODE_PLAN.md нет, но пользовательский override
    // базового имени ({userDataDir}/user/system/MODE_PLAN.md) по-прежнему возможен
    // через _resolveOverridePath и проверяется первым (до встроенной локализации).
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'MODE_PLAN.md'), 'BASE OVERRIDE', 'utf-8');
    await writeFile(join(userDataDir, 'user', 'system', 'MODE_PLAN.en.md'), 'EN OVERRIDE', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    expect(config.getModePrompt('plan', 'en')).toBe('EN OVERRIDE');
    // для другого языка локализованный файл не подходит — fallback на базовый override
    expect(config.getModePrompt('plan', 'ru')).toBe('BASE OVERRIDE');
  });

  it('локализованный override MODE_PLAN.en.md приоритетнее системного en-файла', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'MODE_PLAN.en.md'), 'ПОЛЬЗОВАТЕЛЬСКИЙ EN OVERRIDE', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    expect(config.getModePrompt('plan', 'en')).toBe('ПОЛЬЗОВАТЕЛЬСКИЙ EN OVERRIDE');
  });

  it('неизвестный режим → null (fallback на встроенный текст движка)', async () => {
    const config = new ContextConfig({ userDataDir });
    expect(config.getModePrompt('unknown_mode', 'ru')).toBeNull();
  });

  it('listAllFiles включает локализованные режимные файлы MODE_PLAN.ru.md/en.md и не содержит базовых MODE_PLAN.md', async () => {
    const config = new ContextConfig({ userDataDir });
    const files = config.listAllFiles();
    const names = files.map((f) => f.filename);

    for (const localized of ['MODE_PLAN.ru.md', 'MODE_PLAN.en.md', 'MODE_ACT.ru.md', 'MODE_ACT.en.md', 'MODE_YOLO.ru.md', 'MODE_YOLO.en.md']) {
      expect(names, localized).toContain(localized);
    }
    for (const base of ['MODE_PLAN.md', 'MODE_ACT.md', 'MODE_YOLO.md']) {
      expect(names, base).not.toContain(base);
    }

    const modes = files.filter((f) => f.filename.startsWith('MODE_PLAN') || f.filename.startsWith('MODE_ACT') || f.filename.startsWith('MODE_YOLO'));
    expect(modes).toHaveLength(6);
    for (const m of modes) {
      expect(m.category).toBe('system');
      expect(m.isSystem).toBe(true);
    }
  });

  it('listAllFiles включает RULES/ROUTING только в локализациях (category=system), без базовых RULES.md/ROUTING.md', async () => {
    const config = new ContextConfig({ userDataDir });
    const files = config.listAllFiles();
    const names = files.map((f) => f.filename);

    for (const localized of ['RULES.ru.md', 'RULES.en.md', 'ROUTING.ru.md', 'ROUTING.en.md']) {
      expect(names, localized).toContain(localized);
    }
    for (const base of ['RULES.md', 'ROUTING.md']) {
      expect(names, base).not.toContain(base);
    }

    const rules = files.filter((f) => f.filename.startsWith('RULES') || f.filename.startsWith('ROUTING'));
    for (const f of rules) {
      expect(f.category).toBe('system');
      expect(f.isSystem).toBe(true);
    }
  });
});

describe('ContextConfig.getRules / getRoutingInstructions (локализация)', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-rules-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('getRules: ru → русский контент, en → английский, fr → пустая строка', async () => {
    const config = new ContextConfig({ userDataDir });

    const ru = config.getRules('ru');
    expect(ru).toContain('[RULES]');
    expect(ru).toContain('Содержимое внутри [CONTENT]');

    const en = config.getRules('en');
    expect(en).toContain('[RULES]');
    expect(en).toContain('Content inside [CONTENT]');

    expect(config.getRules('fr')).toBe('');
  });

  it('getRoutingInstructions: ru → русский контент, en → английский, fr → пустая строка', async () => {
    const config = new ContextConfig({ userDataDir });

    const ru = config.getRoutingInstructions('ru');
    expect(ru).toContain('[ROUTING]');
    expect(ru).toContain('Для запуска дочерних агентов');

    const en = config.getRoutingInstructions('en');
    expect(en).toContain('[ROUTING]');
    expect(en).toContain('When launching sub-agents');

    expect(config.getRoutingInstructions('fr')).toBe('');
  });
});

describe('ContextConfig.getPlanModePrompt / getPlanGuide (ADR-028/ADR-039)', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-plan-mode-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('auto → PLAN_MODE_AUTO.ru.md с маркером [PLAN MODE: AUTO]', async () => {
    const config = new ContextConfig({ userDataDir });
    const prompt = config.getPlanModePrompt('auto', false, 'ru');
    expect(prompt).not.toBeNull();
    expect(prompt!).toContain('[PLAN MODE: AUTO]');
    expect(prompt!).toContain('plan_enter');
  });

  it('strict approved → PLAN_MODE_STRICT_APPROVED, strict not approved → PLAN_MODE_STRICT_NOT_APPROVED', async () => {
    const config = new ContextConfig({ userDataDir });

    const approved = config.getPlanModePrompt('strict', true, 'ru')!;
    expect(approved).toContain('[PLAN MODE: STRICT]');
    expect(approved).toContain('План утверждён');

    const notApproved = config.getPlanModePrompt('strict', false, 'ru')!;
    expect(notApproved).toContain('[PLAN MODE: STRICT]');
    expect(notApproved).toContain('план обязателен');
    expect(notApproved).toContain('запись файлов заблокирована');
  });

  it('off → null (планирование отключено)', async () => {
    const config = new ContextConfig({ userDataDir });
    expect(config.getPlanModePrompt('off', false, 'ru')).toBeNull();
    expect(config.getPlanModePrompt('off', true, 'ru')).toBeNull();
  });

  it('неизвестный язык → null (нет PLAN_MODE_AUTO.fr.md и базового файла)', async () => {
    const config = new ContextConfig({ userDataDir });
    expect(config.getPlanModePrompt('auto', false, 'fr')).toBeNull();
    expect(config.getPlanModePrompt('strict', true, 'fr')).toBeNull();
    expect(config.getPlanModePrompt('strict', false, 'fr')).toBeNull();
  });

  it('en → английский контент из PLAN_MODE_*.en.md', async () => {
    const config = new ContextConfig({ userDataDir });

    const auto = config.getPlanModePrompt('auto', false, 'en')!;
    expect(auto).toContain('[PLAN MODE: AUTO]');
    expect(auto).toContain('plan_enter');
    expect(auto).not.toContain('Ты работаешь');

    const approved = config.getPlanModePrompt('strict', true, 'en')!;
    expect(approved).toContain('The plan is approved');

    const notApproved = config.getPlanModePrompt('strict', false, 'en')!;
    expect(notApproved).toContain('A plan is mandatory');
  });

  it('override из system-категории приоритетнее встроенного', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'PLAN_MODE_AUTO.md'), 'ПОЛЬЗОВАТЕЛЬСКИЙ AUTO', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    expect(config.getPlanModePrompt('auto', false, 'ru')).toBe('ПОЛЬЗОВАТЕЛЬСКИЙ AUTO');
  });

  it('локализованный override приоритетнее базового override', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'PLAN_MODE_AUTO.md'), 'BASE OVERRIDE', 'utf-8');
    await writeFile(join(userDataDir, 'user', 'system', 'PLAN_MODE_AUTO.en.md'), 'EN OVERRIDE', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    expect(config.getPlanModePrompt('auto', false, 'en')).toBe('EN OVERRIDE');
    expect(config.getPlanModePrompt('auto', false, 'ru')).toBe('BASE OVERRIDE');
  });

  it('getPlanGuide: ru → русский контент, en → английский, fr → null', async () => {
    const config = new ContextConfig({ userDataDir });

    const ru = config.getPlanGuide('ru');
    expect(ru).not.toBeNull();
    expect(ru!).toContain('[PLAN GUIDE]');
    expect(ru!).toContain('project.plan');
    expect(ru!).toContain('session.todos');

    const en = config.getPlanGuide('en');
    expect(en).not.toBeNull();
    expect(en!).toContain('[PLAN GUIDE]');
    expect(en!).toContain('The plan belongs to the project');

    expect(config.getPlanGuide('fr')).toBeNull();
  });

  it('getPlanGuide: override из system-категории приоритетнее встроенного', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'PLAN_GUIDE.md'), 'ПОЛЬЗОВАТЕЛЬСКИЙ GUIDE', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    expect(config.getPlanGuide('ru')).toBe('ПОЛЬЗОВАТЕЛЬСКИЙ GUIDE');
  });

  it('listAllFiles включает локализованные PLAN_MODE_* и PLAN_GUIDE, без базовых', async () => {
    const config = new ContextConfig({ userDataDir });
    const names = config.listAllFiles().map((f) => f.filename);

    for (const localized of [
      'PLAN_MODE_AUTO.ru.md', 'PLAN_MODE_AUTO.en.md',
      'PLAN_MODE_STRICT_APPROVED.ru.md', 'PLAN_MODE_STRICT_APPROVED.en.md',
      'PLAN_MODE_STRICT_NOT_APPROVED.ru.md', 'PLAN_MODE_STRICT_NOT_APPROVED.en.md',
      'PLAN_GUIDE.ru.md', 'PLAN_GUIDE.en.md',
    ]) {
      expect(names, localized).toContain(localized);
    }
    for (const base of [
      'PLAN_MODE_AUTO.md', 'PLAN_MODE_STRICT_APPROVED.md',
      'PLAN_MODE_STRICT_NOT_APPROVED.md', 'PLAN_GUIDE.md',
    ]) {
      expect(names, base).not.toContain(base);
    }
  });
});

describe('ContextConfig.getModePolicy (ADR-070 §3.1)', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-mode-policy-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('ru → [MODE POLICY], en → английский, fr → null', async () => {
    const config = new ContextConfig({ userDataDir });
    const ru = config.getModePolicy('ru');
    expect(ru).toContain('[MODE POLICY]');
    expect(ru).toContain('plan');
    const en = config.getModePolicy('en');
    expect(en).toContain('[MODE POLICY]');
    expect(config.getModePolicy('fr')).toBeNull();
  });

  it('override из system-категории приоритетнее встроенного', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'MODE_POLICY.md'), 'ПОЛЬЗОВАТЕЛЬСКАЯ ПОЛИТИКА', 'utf-8');
    const config = new ContextConfig({ userDataDir });
    expect(config.getModePolicy('ru')).toBe('ПОЛЬЗОВАТЕЛЬСКАЯ ПОЛИТИКА');
  });
});

describe('ContextConfig.getSchedulerNotice (ADR-051)', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-scheduler-notice-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('ru → русский контент (статический, без {name}), en → английский, fr → пустая строка', async () => {
    const config = new ContextConfig({ userDataDir });

    const ru = config.getSchedulerNotice('ru');
    expect(ru).toContain('Scheduler');
    expect(ru).toContain('планировщик');
    expect(ru).not.toContain('{name}');
    expect(ru).not.toContain('{');

    const en = config.getSchedulerNotice('en');
    expect(en).toContain('Scheduler');
    expect(en.toLowerCase()).toContain('scheduler');
    expect(en).not.toContain('планировщик');
    expect(en).not.toContain('{');

    expect(config.getSchedulerNotice('fr')).toBe('');
  });

  it('override из system-категории приоритетнее встроенного', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'SCHEDULER.md'), 'ПОЛЬЗОВАТЕЛЬСКИЙ SCHEDULER', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    expect(config.getSchedulerNotice('ru')).toBe('ПОЛЬЗОВАТЕЛЬСКИЙ SCHEDULER');
  });
});

describe('ContextConfig.getSchedulerTurnNotice (ADR-051)', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-scheduler-turn-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('ru → русское пояснение, en → английское, fr → пустая строка', async () => {
    const config = new ContextConfig({ userDataDir });

    const ru = config.getSchedulerTurnNotice('ru');
    expect(ru).toContain('Scheduler');
    expect(ru.length).toBeGreaterThan(0);

    const en = config.getSchedulerTurnNotice('en');
    expect(en).toContain('Scheduler');
    expect(en).not.toContain('планировщик');

    expect(config.getSchedulerTurnNotice('fr')).toBe('');
  });

  it('override из system-категории приоритетнее встроенного', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'SCHEDULER_TURN.md'), 'ПОЛЬЗОВАТЕЛЬСКИЙ TURN', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    expect(config.getSchedulerTurnNotice('ru')).toBe('ПОЛЬЗОВАТЕЛЬСКИЙ TURN');
  });
});

describe('ContextConfig.getMaxStepsPrompt (финальный шаг-отчёт по лимиту шагов)', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-max-steps-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('ru → требование «только текст», en → английское, fr → пустая строка', async () => {
    const config = new ContextConfig({ userDataDir });

    const ru = config.getMaxStepsPrompt('ru');
    expect(ru).toContain('КРИТИЧНО');
    expect(ru).toContain('ЛИМИТ ШАГОВ');
    expect(ru).toContain('НЕ вызывай инструменты');
    expect(ru).toContain('{limit}');

    const en = config.getMaxStepsPrompt('en');
    expect(en).toContain('MAXIMUM STEPS REACHED');
    expect(en).toContain('DO NOT call any tools');
    expect(en).not.toContain('вызывай инструменты');

    expect(config.getMaxStepsPrompt('fr')).toBe('');
  });

  it('override из system-категории приоритетнее встроенного', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'MAX_STEPS.md'), 'ПОЛЬЗОВАТЕЛЬСКИЙ MAX_STEPS', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    expect(config.getMaxStepsPrompt('ru')).toBe('ПОЛЬЗОВАТЕЛЬСКИЙ MAX_STEPS');
  });

  it('локализованный override приоритетнее встроенного', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(join(userDataDir, 'user', 'system', 'MAX_STEPS.en.md'), 'EN OVERRIDE', 'utf-8');

    const config = new ContextConfig({ userDataDir });
    expect(config.getMaxStepsPrompt('en')).toBe('EN OVERRIDE');
  });
});

describe('ContextConfig.getAttachmentsDroppedTemplate (ADR-115)', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-attachments-dropped-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('ru → блок [ATTACHMENTS NOT DELIVERED] с {items}, en → английский, fr → пустая строка', async () => {
    const config = new ContextConfig({ userDataDir });

    const ru = config.getAttachmentsDroppedTemplate('ru');
    expect(ru).toContain('[ATTACHMENTS NOT DELIVERED]');
    expect(ru).toContain('{items}');
    expect(ru).toContain('modality');
    expect(ru).toContain('limit');
    expect(ru).toContain('unavailable');
    expect(ru).toContain('read_file');

    const en = config.getAttachmentsDroppedTemplate('en');
    expect(en).toContain('[ATTACHMENTS NOT DELIVERED]');
    expect(en).toContain('{items}');
    expect(en).not.toContain('рабочем каталоге проекта');

    // Локализованного файла для неизвестного языка нет — шаблона нет.
    expect(config.getAttachmentsDroppedTemplate('fr')).toBe('');
  });

  it('override из system-категории приоритетнее встроенного', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(
      join(userDataDir, 'user', 'system', 'ATTACHMENTS_DROPPED.md'),
      'ПОЛЬЗОВАТЕЛЬСКИЙ ATTACHMENTS {items}',
      'utf-8',
    );

    const config = new ContextConfig({ userDataDir });
    expect(config.getAttachmentsDroppedTemplate('ru')).toBe('ПОЛЬЗОВАТЕЛЬСКИЙ ATTACHMENTS {items}');
  });

  it('локализованный override приоритетнее базового', async () => {
    await mkdir(join(userDataDir, 'user', 'system'), { recursive: true });
    await writeFile(
      join(userDataDir, 'user', 'system', 'ATTACHMENTS_DROPPED.en.md'),
      'EN ATTACHMENTS {items}',
      'utf-8',
    );

    const config = new ContextConfig({ userDataDir });
    expect(config.getAttachmentsDroppedTemplate('en')).toBe('EN ATTACHMENTS {items}');
  });

  it('нет файла (неизвестная категория промптов) → пустая строка', async () => {
    // Пустой каталог системных промптов: шаблона нет — вызывающий код берёт
    // техническую строку (en fallback в hydrate).
    const emptyPrompts = await mkdtemp(join(tmpdir(), 'synth-empty-prompts-'));
    try {
      const config = new ContextConfig({ userDataDir, systemPromptsDir: emptyPrompts });
      expect(config.getAttachmentsDroppedTemplate('ru')).toBe('');
    } finally {
      await rm(emptyPrompts, { recursive: true, force: true });
    }
  });
});

describe('ContextConfig.getInterviewTemplate (онбординг)', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-interview-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('ru: [INTERVIEW] + вопросы [Q1]..[Q5] + инструкция про profile_update', async () => {
    const config = new ContextConfig({ userDataDir });
    const ru = config.getInterviewTemplate('ru');
    expect(ru).toContain('[INTERVIEW]');
    for (const q of ['[Q1]', '[Q2]', '[Q3]', '[Q4]', '[Q5]']) {
      expect(ru, q).toContain(q);
    }
    expect(ru).toContain('profile_update');
    expect(ru).toContain('interview_completed=true');
  });

  it('en: английский контент, fr → пустая строка', async () => {
    const config = new ContextConfig({ userDataDir });
    const en = config.getInterviewTemplate('en');
    expect(en).toContain('[INTERVIEW]');
    expect(en).toContain('[Q1]');
    expect(en).toContain('profile_update');
    expect(en).not.toContain('Как вас зовут');

    expect(config.getInterviewTemplate('fr')).toBe('');
  });
});
