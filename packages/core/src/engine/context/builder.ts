import { join } from 'node:path';
import type { Message, StickyNote } from '@itphx/synth-shared';
import type { ProfileData, ProfileStore } from '@itphx/synth-shared';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';
import { isInterviewCompleted } from './interview.js';
import { joinPromptBlocks, sortPromptBlocks, type PromptBlock } from './prompt-blocks.js';
import type { DebugCollector } from '../../debug.js';

export interface BuildSystemPromptParams {
  agentRole?: string;
  agentContextFile?: string;
  historyMessages?: Message[];
  userId?: string;
  projectName?: string;
  language?: string;
  showInterview?: boolean;
  /**
   * Интервью уместно в этом ходе: первое сообщение сессии И от пользователя
   * (не Scheduler/системное). Вычисляет оркестратор, builder только гейтит —
   * блок не должен литься в каждую сессию.
   */
  interviewEligible?: boolean;
  stickyNotes?: StickyNote[];
  summaryContent?: string;
  /**
   * ADR-107: память доступна в текущей сессии (плагин активен, тулы памяти не
   * отключены, проект не выключил память). Только тогда в промпт попадает
   * инструкция prompts/system/MEMORY.{lang}.md.
   */
  memoryAvailable?: boolean;
}

export interface ContextBuilderOptions {
  profilesStore?: ProfileStore;
  projectDataDir?: string;
  debugCollector?: DebugCollector;
  defaultLanguage?: string;
}

export class ContextBuilder {
  private readonly _config: ContextFileRepository;
  private readonly _profiles?: ProfileStore;
  private readonly _projectDataDir?: string;
  private readonly _debug?: DebugCollector;
  private readonly _defaultLanguage: string;

  constructor(config: ContextFileRepository, options?: ContextBuilderOptions) {
    this._config = config;
    this._profiles = options?.profilesStore;
    this._projectDataDir = options?.projectDataDir;
    this._debug = options?.debugCollector;
    this._defaultLanguage = options?.defaultLanguage || 'ru';
  }

  /**
   * ADR-070 §2.1: собирает «сырые» блоки системного промпта с тирами.
   * Пустой `content` означает, что блок не отправляется. Порядок блоков
   * фиксирован, финальную сортировку по тирам делает `sortPromptBlocks`.
   */
  async buildBaseBlocks(params: BuildSystemPromptParams): Promise<PromptBlock[]> {
    const lang = params.language || this._getLanguage(params.userId);
    const showInterview = params.showInterview ?? true;
    const agentRole = params.agentRole;

    if (this._debug) {
      this._debug.addContext('context.build', {
        agentRole: agentRole ?? null,
        userId: params.userId ?? null,
        projectName: params.projectName ?? null,
        language: lang,
      });
    }

    // 1. Role prompt (stable)
    let roleContent = '';
    if (agentRole) {
      const rolePrompt = this._config.getRolePrompt(agentRole, params.agentContextFile, lang);
      if (rolePrompt) {
        roleContent = rolePrompt;
        this._debugAdd('role', { agentRole, loaded: true, language: lang });
      } else {
        roleContent = this._config.getRolesDescription(lang);
        this._debugAdd('role', { agentRole, loaded: false, language: lang });
      }
    } else {
      roleContent = this._config.getRolesDescription(lang);
      this._debugAdd('role', { agentRole: null, descriptionUsed: true });
    }

    // 2. Participants notice (volatile). Сохранено текущее условие: notice
    // добавляется только при заданном agentRole.
    let participantsContent = '';
    if (agentRole && params.historyMessages && this._hasMultipleParticipants(params.historyMessages)) {
      const notice = this._config.getParticipantsNotice(lang);
      if (notice) {
        participantsContent = notice;
        this._debugAdd('participants_notice', { loaded: true, language: lang });
      }
    }

    // 3. Sticky notes (volatile). Сохранено текущее условие: только при agentRole.
    let stickyContent = '';
    if (agentRole) {
      stickyContent = this._getStickyNotesPart(params.stickyNotes, lang) ?? '';
    }

    // 4. Compressed dialog (summary, volatile)
    let summaryContent = '';
    if (params.summaryContent) {
      const template = this._config.getCompressedDialogTemplate(lang);
      summaryContent = template.replace('{content}', params.summaryContent);
      this._debugAdd('summary', { included: true, language: lang });
    }

    // 5. Additional context (enabled user files, stable)
    const additionalContent = this._getAdditionalContext();

    // 6. Profile prompt (context)
    const profileContent = (await this._getProfilePrompt(params.userId, lang)) ?? '';

    // 7. Project prompt (context)
    const projectContent = (await this._getProjectPrompt(params.projectName)) ?? '';

    // 8. Memory guide (context). Инструкция нужна только при доступной памяти:
    // иначе модель видела бы советы про отсутствующие инструменты.
    let memoryContent = '';
    if (params.memoryAvailable) {
      memoryContent = this._config.getMemoryInstructions(lang);
      if (memoryContent) this._debugAdd('memory', { loaded: true, language: lang });
    }

    // 9. Interview prompt (volatile)
    // Блок показывается, только если: интервью включено настройкой сессии И
    // ход признан подходящим (`interviewEligible`: первое сообщение сессии от
    // пользователя, не Scheduler/системное) И профиль найден И интервью ещё
    // не помечено пройденным (`interviewCompleted`). Раньше блок лился в каждую
    // сессию и гейтился по числу ответов в `notes` — это неверно.
    let interviewContent = '';
    if (showInterview && params.interviewEligible && params.userId && this._profiles) {
      const profile = await this._resolveProfile(params.userId);
      if (profile && !isInterviewCompleted(profile)) {
        const interview = this._config.getInterviewTemplate(lang);
        if (interview) {
          interviewContent = interview;
          this._debugAdd('interview', { shown: true, language: lang });
        }
      }
    }

    const blocks: PromptBlock[] = [
      { key: 'role', tier: 'stable', order: 10, content: roleContent, provenance: agentRole ? `roles/${agentRole}` : 'roles' },
      { key: 'additional', tier: 'stable', order: 20, content: additionalContent, provenance: 'context' },
      { key: 'profile', tier: 'context', order: 10, content: profileContent, provenance: 'profile' },
      { key: 'project.info', tier: 'context', order: 20, content: projectContent, provenance: params.projectName ? `projects/${params.projectName}/info.md` : 'projects' },
      // Подключаем блок только при доступной памяти: иначе в манифесте
      // появлялась бы пустая «инструкция», хотя инструментов у агента нет.
      ...(params.memoryAvailable
        ? [{ key: 'memory.guide', tier: 'context' as const, order: 25, content: memoryContent, provenance: 'prompts/system/MEMORY' }]
        : []),
      { key: 'sticky', tier: 'volatile', order: 10, content: stickyContent, provenance: 'stickyNotes' },
      { key: 'participants', tier: 'volatile', order: 20, content: participantsContent, provenance: 'history' },
      { key: 'summary', tier: 'volatile', order: 30, content: summaryContent, provenance: 'summary' },
      { key: 'interview', tier: 'volatile', order: 90, content: interviewContent, provenance: 'interview' },
    ];

    const emitted = blocks.filter((block) => block.content !== '');
    const result = joinPromptBlocks(sortPromptBlocks(emitted));

    this._debugAdd('system_prompt', {
      agentRole: agentRole ?? null,
      language: lang,
      partsCount: emitted.length,
      totalLength: result.length,
    });

    return blocks;
  }

  /**
   * ADR-036: инструкция по работе с обфусцированными секретами (⟦SYNTH_SECRET_N⟧).
   * Делегирует ContextConfig.getGatewayInstructions (prompts/system/GATEWAY.{lang}.md).
   */
  getGatewayInstructions(language = 'ru'): string {
    return this._config.getGatewayInstructions(language);
  }

  private _getLanguage(_userId?: string): string {
    return this._defaultLanguage;
  }

  private _debugAdd(key: string, data: Record<string, unknown>): void {
    if (this._debug) {
      this._debug.addContext(`context.${key}`, data);
    }
  }

  private _getAdditionalContext(): string {
    const enabledFiles = this._config.getEnabledFiles();
    if (enabledFiles.length === 0) return '';

    const contextParts: string[] = [];
    const loadedFiles: Array<Record<string, unknown>> = [];

    for (const filename of enabledFiles) {
      const content = this._config.getFile(filename, 'user');
      if (content) {
        contextParts.push(content.content);
        loadedFiles.push({
          filename,
          size: content.content.length,
          source: content.isOverridden ? 'user' : 'system',
        });
      }
    }

    if (contextParts.length === 0) return '';

    this._debugAdd('additional_context', {
      filesLoaded: contextParts.length,
      filesRequested: enabledFiles.length,
      files: loadedFiles,
    });

    if (this._debug) {
      this._debug.captureContextFiles(loadedFiles);
    }

    return `\n\n[ADDITIONAL CONTEXT]\n${contextParts.join('\n\n')}\n`;
  }

  /**
   * Резолвинг профиля: `userId` в сессии может быть username (`admin`), а не
   * id-профиля (UUID). Сначала пробуем id, затем — фолбэк по username.
   * Используется и для профиля в промпте, и для блока интервью.
   */
  private async _resolveProfile(userId: string | undefined): Promise<ProfileData | null> {
    if (!userId || !this._profiles) return null;
    return (await this._profiles.loadProfile(userId))
      ?? (await this._profiles.getProfileByUsername(userId));
  }

  private async _getProfilePrompt(userId: string | undefined, language: string): Promise<string | null> {
    const profile = await this._resolveProfile(userId);
    if (!profile) return null;

    const template = this._config.getUserContextTemplate(language);
    if (!template) return null;

    let about = profile.notes || '';
    // Legacy-guard: до введения поля `interviewCompleted` интервью писалось в
    // свободный `notes` с меткой `[ИНТЕРВЬЮ]`; хвост от неё не является «о вас»
    // и не должен попадать в профиль. Новые профили метку не используют.
    if (about.includes('[ИНТЕРВЬЮ]')) {
      about = about.split('[ИНТЕРВЬЮ]')[0]!.trim();
    }

    const content = template
      .replace(/\{username\}/g, profile.username || '')
      .replace(/\{email\}/g, profile.email || '')
      .replace(/\{roles\}/g, profile.roles.join(', '))
      .replace(/\{about\}/g, about);

    this._debugAdd('profile', {
      userId: profile.id,
      username: profile.username,
      email: profile.email,
      roles: profile.roles.join(', '),
      hasAbout: about.length > 0,
    });

    return `\n\n${content}\n`;
  }

  private async _getProjectPrompt(projectName: string | undefined): Promise<string | null> {
    if (!projectName || !this._projectDataDir) return null;

    const infoPath = join(this._projectDataDir, projectName, 'info.md');
    const { readFile } = await import('node:fs/promises');

    try {
      const content = await readFile(infoPath, 'utf-8');
      this._debugAdd('project', { projectName, found: true });
      return `\n\n[PROJECT: ${projectName}]\n${content}\n`;
    } catch {
      this._debugAdd('project', { projectName, found: false });
      return null;
    }
  }

  private _hasMultipleParticipants(messages: Message[]): boolean {
    const agents = new Set<string>();
    const users = new Set<string>();

    for (const msg of messages) {
      if (msg.disabled) continue;
      if (msg.role === 'assistant' && msg.agentRole) {
        agents.add(msg.agentRole);
      } else if (msg.role === 'user' && msg.author) {
        users.add(msg.author);
      }
    }

    return agents.size > 1 || users.size > 1;
  }

  private _getStickyNotesPart(stickyNotes: StickyNote[] | undefined, language: string): string | null {
    if (!stickyNotes || stickyNotes.length === 0) return null;

    const activeNotes = stickyNotes.filter((n) => !n.disabled);
    if (activeNotes.length === 0) return null;

    const template = this._config.getStickyNotesTemplate(language);
    if (!template) return null;

    const notesText = activeNotes.map((n) => n.content).join('\n\n---\n\n');
    const content = template.replace('{notes}', notesText);

    this._debugAdd('sticky_notes', { count: activeNotes.length, language });
    return `\n\n${content}\n`;
  }
}
