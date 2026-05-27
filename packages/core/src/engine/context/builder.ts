import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, ProfileData, StickyNote } from '@synth/shared';
import type { ProfileStore } from '@synth/shared';
import { ContextConfig } from './config.js';
import { InterviewManager } from './interview.js';
import type { DebugCollector } from '../../debug.js';

export interface BuildSystemPromptParams {
  agentRole?: string;
  agentContextFile?: string;
  historyMessages?: Message[];
  userId?: string;
  projectName?: string;
  tsmMode?: 'simple' | 'orchestrator';
  language?: string;
  showInterview?: boolean;
  stickyNotes?: StickyNote[];
}

export interface ContextBuilderOptions {
  profilesStore?: ProfileStore;
  projectDataDir?: string;
  debugCollector?: DebugCollector;
  defaultLanguage?: string;
}

export class ContextBuilder {
  private readonly _config: ContextConfig;
  private readonly _profiles?: ProfileStore;
  private readonly _projectDataDir?: string;
  private readonly _debug?: DebugCollector;
  private readonly _defaultLanguage: string;

  constructor(config: ContextConfig, options?: ContextBuilderOptions) {
    this._config = config;
    this._profiles = options?.profilesStore;
    this._projectDataDir = options?.projectDataDir;
    this._debug = options?.debugCollector;
    this._defaultLanguage = options?.defaultLanguage || 'ru';
  }

  async buildSystemPrompt(params: BuildSystemPromptParams): Promise<string> {
    const parts: string[] = [];
    const lang = params.language || this._getLanguage(params.userId);
    const showInterview = params.showInterview ?? true;
    const agentRole = params.agentRole;

    if (this._debug) {
      this._debug.addContext('context.build', {
        agentRole: agentRole ?? null,
        userId: params.userId ?? null,
        projectName: params.projectName ?? null,
        tsmMode: params.tsmMode ?? 'simple',
        language: lang,
      });
    }

    // 1. Role prompt
    if (agentRole) {
      const rolePrompt = this._config.getRolePrompt(agentRole, params.agentContextFile, lang);
      if (rolePrompt) {
        parts.push(rolePrompt);
        this._debugAdd('role', { agentRole, loaded: true, language: lang });
      } else {
        const desc = this._config.getRolesDescription(lang);
        if (desc) parts.push(desc);
        this._debugAdd('role', { agentRole, loaded: false, language: lang });
      }

    // 2. Participants notice
    if (params.historyMessages && this._hasMultipleParticipants(params.historyMessages)) {
      const notice = this._config.getParticipantsNotice(lang);
      if (notice) {
        parts.push(notice);
        this._debugAdd('participants_notice', { loaded: true, language: lang });
      }
    }

    // 2.5. Sticky notes (если есть активные)
    const notesPart = this._getStickyNotesPart(params.stickyNotes, lang);
    if (notesPart) parts.push(notesPart);
  } else {
      const desc = this._config.getRolesDescription(lang);
      if (desc) parts.push(desc);
      this._debugAdd('role', { agentRole: null, descriptionUsed: true });
    }

    // 3. Additional context (enabled user files)
    const additional = this._getAdditionalContext();
    if (additional) parts.push(additional);

    // 4. Profile prompt
    const profile = await this._getProfilePrompt(params.userId, lang);
    if (profile) parts.push(profile);

    // 5. Project prompt
    const project = this._getProjectPrompt(params.projectName);
    if (project) parts.push(project);

    // 6. Interview prompt
    if (showInterview && params.userId && this._profiles) {
      const profile = await this._profiles.loadProfile(params.userId);
      const intManager = new InterviewManager(this._profiles, this._config);
      if (intManager.shouldStartInterview(profile, showInterview)) {
        const interview = this._config.getInterviewTemplate(lang);
        if (interview) {
          if (this._getAnsweredCount(profile?.notes ?? '') === 0) {
            parts.push(interview);
            this._debugAdd('interview', { shown: true, language: lang });
          }
        }
      }
    }

    const result = parts.join('\n\n');

    this._debugAdd('system_prompt', {
      agentRole: agentRole ?? null,
      language: lang,
      partsCount: parts.length,
      totalLength: result.length,
    });

    return result;
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

    return `\n\n[ДОПОЛНИТЕЛЬНЫЙ КОНТЕКСТ]\n${contextParts.join('\n\n')}\n`;
  }

  private async _getProfilePrompt(userId: string | undefined, language: string): Promise<string | null> {
    if (!userId || !this._profiles) return null;

    const profile = await this._profiles.loadProfile(userId);
    if (!profile) return null;

    const template = this._config.getUserContextTemplate(language);
    if (!template) return null;

    let about = profile.notes || '';
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

  private _getProjectPrompt(projectName: string | undefined): string | null {
    if (!projectName || !this._projectDataDir) return null;

    const infoPath = join(this._projectDataDir, projectName, 'info.md');

    if (!existsSync(infoPath)) return null;

    try {
      const content = readFileSync(infoPath, 'utf-8');
      this._debugAdd('project', { projectName, found: true });
      return `\n\n[ПРОЕКТ: ${projectName}]\n${content}\n`;
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

  private _getAnsweredCount(notes: string): number {
    if (!notes) return 0;
    const matches = notes.match(/\[ОТВЕТ\]/g);
    return matches ? matches.length : 0;
  }
}
