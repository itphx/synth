/**
 * Вложения сообщений (ADR-115): сервис, определение MIME, вычищение метаданных
 * и GC осиротевших объектов.
 */

export {
  AttachmentService,
  AttachmentError,
  isAttachmentPath,
  partTypeOf,
  sanitizeFileName,
  ATTACHMENT_DIR,
  ATTACHMENT_SIDECAR_SUFFIX,
} from './service.js';
export type {
  AttachmentServiceDeps,
  AttachmentErrorCode,
  BuiltMediaPart,
  ResolvedAttachment,
  UploadedAttachmentMeta,
} from './service.js';
export { sniffMime, looksLikeSvg, normalizeMime } from './sniff-mime.js';
export { stripMetadata } from './strip-metadata.js';
export { startAttachmentPruner } from './prune.js';
export type { AttachmentPrunerOptions } from './prune.js';
