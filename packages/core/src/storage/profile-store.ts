import { readFile, writeFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileData } from '@itphx/synth-shared';
import type { ProfileStore, CreateProfileParams } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';
import { info, warning } from '../logger.js';

interface SerializedProfile {
  id: string;
  username: string;
  email?: string;
  phone?: string;
  roles: string[];
  team_roles: string[];
  is_active: boolean;
  preferences: Record<string, unknown>;
  notes: string;
  interview_completed: boolean;
  interview_completed_at?: string;
  display_name?: string;
  created_at: string;
  updated_at: string;
  last_login?: string;
}

export class FileProfileStore implements ProfileStore {
  private readonly _profilesDir: string;

  constructor(options: { dataDir: string }) {
    this._profilesDir = join(options.dataDir, 'auth', 'profiles');
  }

  private _profilePath(id: string): string {
    return join(this._profilesDir, `${id}.json`);
  }

  private _serialize(profile: ProfileData): SerializedProfile {
    return {
      id: profile.id,
      username: profile.username,
      email: profile.email,
      phone: profile.phone,
      roles: profile.roles,
      team_roles: profile.teamRoles,
      is_active: profile.isActive,
      preferences: profile.preferences,
      notes: profile.notes,
      interview_completed: profile.interviewCompleted,
      interview_completed_at: profile.interviewCompletedAt,
      display_name: profile.displayName,
      created_at: profile.createdAt,
      updated_at: profile.updatedAt,
      last_login: profile.lastLogin,
    };
  }

  private _deserialize(data: SerializedProfile): ProfileData {
    // Backfill для legacy-профилей: до появления поля статус интервью хранился
    // текстовой меткой `[ИНТЕРВЬЮ]` в свободном `notes`. Если новый флаг не
    // сохранён, но метка есть — считаем интервью пройденным. Время завершения
    // для legacy берём из `updated_at` (иного ориентира нет).
    const legacyInterview = String(data.notes ?? '').includes('[ИНТЕРВЬЮ]');
    const interviewCompleted = data.interview_completed ?? legacyInterview;
    const interviewCompletedAt = data.interview_completed_at
      ?? (legacyInterview ? data.updated_at : undefined);

    return {
      id: data.id,
      username: data.username,
      email: data.email,
      phone: data.phone,
      roles: data.roles,
      teamRoles: data.team_roles,
      isActive: data.is_active,
      preferences: data.preferences,
      notes: data.notes,
      interviewCompleted,
      interviewCompletedAt,
      displayName: data.display_name,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      lastLogin: data.last_login,
    };
  }

  async loadProfile(id: string): Promise<ProfileData | null> {
    try {
      const path = this._profilePath(id);
      if (!existsSync(path)) return null;
      const raw = await readFile(path, 'utf-8');
      return this._deserialize(JSON.parse(raw));
    } catch (e) {
      warning('PROFILE', `Failed to load profile ${id}: ${e}`);
      return null;
    }
  }

  async saveProfile(profile: ProfileData): Promise<void> {
    await mkdir(this._profilesDir, { recursive: true });

    const serialized = this._serialize({
      ...profile,
      updatedAt: new Date().toISOString(),
    });

    const tmpPath = `${this._profilePath(profile.id)}.tmp.${generateId()}`;
    await writeFile(tmpPath, JSON.stringify(serialized, null, 2), 'utf-8');
    await rename(tmpPath, this._profilePath(profile.id));
  }

  async listProfiles(): Promise<ProfileData[]> {
    try {
      if (!existsSync(this._profilesDir)) return [];
      const entries = await readdir(this._profilesDir, { withFileTypes: true });
      const profiles: ProfileData[] = [];
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        const profile = await this.loadProfile(e.name.replace('.json', ''));
        if (profile) profiles.push(profile);
      }
      return profiles.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    } catch {
      return [];
    }
  }

  async deleteProfile(id: string): Promise<boolean> {
    try {
      const path = this._profilePath(id);
      if (!existsSync(path)) return false;
      await unlink(path);
      return true;
    } catch (e) {
      warning('PROFILE', `Failed to delete profile ${id}: ${e}`);
      return false;
    }
  }

  async getProfileByUsername(username: string): Promise<ProfileData | null> {
    const profiles = await this.listProfiles();
    return profiles.find(p => p.username === username) ?? null;
  }

  async getProfileByEmail(email: string): Promise<ProfileData | null> {
    const profiles = await this.listProfiles();
    return profiles.find(p => p.email === email) ?? null;
  }

  async getOrCreateProfile(params: CreateProfileParams): Promise<ProfileData> {
    const existing = await this.getProfileByUsername(params.username);
    if (existing) {
      if (params.email) existing.email = params.email;
      if (params.roles) existing.roles = params.roles;
      if (params.teamRoles) existing.teamRoles = params.teamRoles;
      if (params.interviewCompleted !== undefined) existing.interviewCompleted = params.interviewCompleted;
      await this.saveProfile(existing);
      return existing;
    }

    const now = new Date().toISOString();
    const profile: ProfileData = {
      id: generateId(),
      username: params.username,
      email: params.email,
      roles: params.roles ?? ['USER'],
      teamRoles: params.teamRoles ?? [],
      isActive: true,
      preferences: {},
      notes: '',
      interviewCompleted: params.interviewCompleted ?? false,
      displayName: params.username,
      createdAt: now,
      updatedAt: now,
    };

    await this.saveProfile(profile);
    info('PROFILE', `Created profile for ${params.username} (${profile.id})`);
    return profile;
  }

  async updateLastLogin(id: string): Promise<void> {
    const profile = await this.loadProfile(id);
    if (!profile) return;
    profile.lastLogin = new Date().toISOString();
    await this.saveProfile(profile);
  }
}
