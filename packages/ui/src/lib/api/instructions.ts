// instructions: домен API v2 (ADR-095) — объект `instructionsApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

// --- Проектные инструкции (ADR-069 §9.3) ---

/** Статус файла в снимке (совпадает с core `InstructionsDiagnosticStatus`). */
export type InstructionFileStatus =
  | 'loaded'
  | 'truncated'
  | 'blocked'
  | 'dedup'
  | 'skipped'
  | 'untrusted'
  | 'skipped-install-tree'
  | 'excluded'
  | 'fetch-error'

/** Источник кандидата: merged chain, `config.sources` path или URL. */
export type InstructionSourceKind = 'chain' | 'path' | 'url'

/** Результат threat-scan (ADR-036) по файлу инструкций. */
export interface InstructionScanInfo {
  scanned: boolean
  blocked: boolean
  suspicious: boolean
  matches: string[]
}

/** Файл проектных инструкций в снимке прозрачности (ADR-069 §9.3). */
export interface InstructionFileInfo {
  /** Путь относительно workspace (`./AGENTS.md`, `../AGENTS.md`) или URL. */
  path: string
  kind: InstructionSourceKind
  label?: string
  url?: string
  chars: number
  truncated: boolean
  status: InstructionFileStatus
  scan?: InstructionScanInfo
}

/** Диагностика снимка проектных инструкций. */
export interface InstructionDiagnostic {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  path?: string
  kind?: InstructionSourceKind
}

/** ADR-069 §9.3: ответ GET /api/v2/context/instructions (снимок + id сессии). */
export interface InstructionsInfo {
  session_id?: string
  enabled: boolean
  cap: { chars: number; source: 'dynamic' | 'override'; contextWindow: number }
  files: InstructionFileInfo[]
  diagnostics: InstructionDiagnostic[]
}

export const instructionsApi = {
  /**
   * ADR-069 §9.3: снимок проектных инструкций сессии (read-only прозрачность).
   * Сессия без проекта → пустой снимок с диагностикой `no-project`.
   */
  async getSessionInstructions(sessionId: string): Promise<InstructionsInfo> {
    return fetchJSON<InstructionsInfo>(
      `${BASE_URL}/context/instructions?session_id=${encodeURIComponent(sessionId)}`,
    )
  },
}
