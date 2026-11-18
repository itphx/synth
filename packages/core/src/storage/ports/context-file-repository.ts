import type { ContextCategory, ContextFileContent, ContextFileInfo } from '@itphx/synth-shared';
import type { ExecutionEnvironmentKind } from '../../engine/context/environment.js';

/**
 * Порт файлов контекста/промптов (ADR-069/ADR-070, реализация — `ContextConfig`).
 *
 * Системные промпты + пользовательские override. Каталог `systemPromptsDir`
 * используется доменом (резолв промптов саб-агентов, `engine/tools/task/prompt`),
 * поэтому входит в порт; `userPromptsDir`/`userRolesDir` — деталь файловой
 * реализации. Геттеры синхронные (сборка промпта).
 * @future-backend — промпты из БД/объектного хранилища, собранные в кэш.
 */
export interface ContextFileRepository {
  /** Корень встроенных промптов (промпты саб-агентов).
   *  @future-backend — деталь файловой реализации. */
  readonly systemPromptsDir: string;
  listAllFiles(): ContextFileInfo[];
  getFile(filename: string, category: ContextCategory): ContextFileContent | null;
  saveFile(filename: string, content: string, category: ContextCategory): Promise<boolean>;
  deleteFile(filename: string, category: ContextCategory): Promise<boolean>;
  restoreFile(filename: string, category: ContextCategory): Promise<boolean>;
  getEnabledFiles(): string[];
  setEnabledFiles(files: string[]): void;

  getRolePrompt(agentId: string, contextFileOverride?: string, language?: string): string | null;
  getRolesDescription(language?: string): string;
  getInterviewTemplate(language?: string): string;
  getParticipantsNotice(language?: string): string;
  getSchedulerNotice(language?: string): string;
  getSchedulerTurnNotice(language?: string): string;
  /**
   * ADR-026: системный блок `[SUBAGENT]` (prompts/system/SUBAGENT.{lang}.md)
   * для system prompt нового дочернего прогона саб-агента.
   */
  getSubagentNotice(language?: string): string;
  /**
   * Правило поведения при разрешённой фоновой работе
   * (prompts/system/BACKGROUND.{lang}.md): уведомление о завершении придёт
   * автоматически, статус не опрашивать.
   */
  getBackgroundNotice(language?: string): string;
  /**
   * Требование «только текст» для финального шага-отчёта саб-агента по
   * лимиту шагов (prompts/system/MAX_STEPS.{lang}.md).
   */
  getMaxStepsPrompt(language?: string): string;
  /**
   * ADR-039: требование привести список задач саб-агента в актуальное
   * состояние перед финальным ответом (prompts/system/TODO_FINALIZE.{lang}.md).
   * Пустая строка — файла нет (блок не добавляется).
   */
  getTodoFinalizePrompt(language?: string): string;
  getSummarizerPrompt(language?: string): string;
  /**
   * Системный блок `[СРЕДА ИСПОЛНЕНИЯ]` (prompts/system/ENVIRONMENT.<kind>.{lang}.md):
   * где физически исполняются инструменты сессии (ADR-135/PROP-135).
   * Пустая строка — файла нет (блок в промпт не попадает).
   */
  getEnvironment(kind: ExecutionEnvironmentKind, language?: string): string;
  /** Профиль `compaction`: рабочее состояние по коду/проекту (prompts/system/COMPACTOR.{lang}.md). */
  getCompactorPrompt(language?: string): string;
  getUserContextTemplate(language?: string): string;
  getCompressedDialogTemplate(language?: string): string;
  /**
   * ADR-115: шаблон блока «вложения не доставлены» для LLM-сообщения
   * (prompts/system/ATTACHMENTS_DROPPED.{lang}.md, плейсхолдер `{items}`).
   * Пустая строка — шаблона нет (вызывающий код берёт техническую строку).
   */
  getAttachmentsDroppedTemplate(language?: string): string;
  /**
   * ADR-115: шаблон промпта для модели **обработки** вложения
   * (prompts/system/MEDIA_DERIVE.{lang}.md, плейсхолдеры `{modality}` и `{name}`).
   * Пустая строка — шаблона нет (вызывающий берёт техническую инструкцию).
   */
  getMediaDeriveTemplate(language?: string): string;
  getStickyNotesTemplate(language?: string): string;
  getRoutingInstructions(language?: string): string;
  /**
   * Правила защиты от prompt injection (`prompts/system/CONTENT_RULES.{lang}.md`).
   * Отдельный системный блок `content.rules` (composer), а не часть ролевых
   * промптов: роли правил больше не содержат, блок подключается один раз.
   */
  getContentRules(language?: string): string;
  /** @deprecated Читает `CONTENT_RULES` — используйте `getContentRules`. */
  getRules(language?: string): string;
  getGatewayInstructions(language?: string): string;
  /** ADR-107: инструкция по работе с памятью (prompts/system/MEMORY.{lang}.md). */
  getMemoryInstructions(language?: string): string;
  getSecurityMessage(
    messageId: string,
    language?: string,
    params?: Record<string, string>,
  ): string | null;
  getModePrompt(mode: string, language?: string): string | null;
  getPlanModePrompt(
    planMode: 'auto' | 'strict' | 'off',
    planApproved: boolean,
    language?: string,
  ): string | null;
  getPlanGuide(language?: string): string | null;
  getModePolicy(language?: string): string | null;
  getClassificationInstructions(language?: string): string;
}
