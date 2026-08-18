import type { ProfileData, InterviewQuestion } from '@itphx/shared';
import type { ProfileStore } from '@itphx/shared';
import { ContextConfig } from './config.js';

export class InterviewManager {
  private readonly _profiles: ProfileStore;
  private readonly _config: ContextConfig;

  constructor(profilesStore: ProfileStore, config: ContextConfig) {
    this._profiles = profilesStore;
    this._config = config;
  }

  shouldStartInterview(profile: ProfileData | null, showInterview: boolean): boolean {
    if (!profile) return false;
    if (!showInterview) return false;
    if (profile.notes.includes('[ИНТЕРВЬЮ]')) return false;
    return true;
  }

  isInterviewCompleted(profile: ProfileData | null): boolean {
    if (!profile) return true;
    return profile.notes.includes('[ИНТЕРВЬЮ]');
  }

  getNextQuestion(profile: ProfileData, language = 'ru'): InterviewQuestion | null {
    const template = this._config.getInterviewTemplate(language);
    if (!template) return null;

    const questions = this._parseQuestions(template);
    const answered = this._countAnsweredQuestions(profile.notes);

    if (answered >= questions.length) return null;
    return questions[answered]!;
  }

  async processAnswer(userId: string, answer: string, language = 'ru'): Promise<ProfileData | null> {
    const profile = await this._profiles.loadProfile(userId);
    if (!profile) return null;

    const template = this._config.getInterviewTemplate(language);
    if (!template) return null;

    const questions = this._parseQuestions(template);
    const answered = this._countAnsweredQuestions(profile.notes);
    if (answered >= questions.length) return profile;

    const question = questions[answered]!;

    if (!profile.notes.includes('[ИНТЕРВЬЮ]')) {
      profile.notes += '\n\n[ИНТЕРВЬЮ]';
    }

    profile.notes += `\n[ВОПРОС ${question.id}]\n${question.question}\n[ОТВЕТ]\n${answer}`;

    await this._profiles.saveProfile(profile);
    return profile;
  }

  async completeInterview(userId: string): Promise<void> {
    const profile = await this._profiles.loadProfile(userId);
    if (!profile) return;

    if (!profile.notes.includes('[ИНТЕРВЬЮ]')) {
      profile.notes += '\n\n[ИНТЕРВЬЮ]';
      await this._profiles.saveProfile(profile);
    }
  }

  parseQuestions(language = 'ru'): InterviewQuestion[] {
    const template = this._config.getInterviewTemplate(language);
    return this._parseQuestions(template);
  }

  private _parseQuestions(template: string): InterviewQuestion[] {
    const questions: InterviewQuestion[] = [];
    const regex = /## (q\d+)\s*\n\s*([\s\S]*?)(?=\n## q|\n*$)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(template)) !== null) {
      const id = match[1]!;
      const question = match[2]!.trim();
      const order = parseInt(id.substring(1), 10);
      questions.push({ id, question, order });
    }

    questions.sort((a, b) => a.order - b.order);
    return questions;
  }

  private _countAnsweredQuestions(notes: string): number {
    if (!notes) return 0;
    const matches = notes.match(/\[ОТВЕТ\]/g);
    return matches ? matches.length : 0;
  }
}
