/**
 * Вложения сообщений (ADR-115): сервис, определение MIME, вычищение метаданных,
 * GC осиротевших объектов и материализация отброшенного вложения в workspace.
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
  AttachmentThumbnailMeta,
  AttachmentThumbnailProvider,
  AttachmentThumbnailView,
  BuiltMediaPart,
  ResolvedAttachment,
  UploadedAttachmentMeta,
} from './service.js';
export { sniffMime, looksLikeSvg, normalizeMime } from './sniff-mime.js';
export {
  UploadSessionStore,
  UploadSessionError,
  UPLOAD_SESSION_TTL_MS,
} from './uploads.js';
export type {
  AppendedUploadChunk,
  CreatedUploadSession,
  CreateUploadSessionInput,
  UploadSessionErrorCode,
  UploadSessionRecord,
  UploadSessionStoreDeps,
} from './uploads.js';
export { stripMetadata } from './strip-metadata.js';
export { startAttachmentPruner } from './prune.js';
export type { AttachmentPrunerOptions } from './prune.js';
export { materializeAttachment, sanitizeAttachmentName, ATTACHMENTS_DIR } from './materialize.js';
export type { MaterializeAttachmentInput } from './materialize.js';
export {
  ThumbnailService,
  THUMBNAIL_DIR,
  THUMBNAIL_SUFFIX,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_JPEG_QUALITY,
  THUMBNAIL_MAX_BYTES,
  jpegSize,
  parseFfmpegDurationMs,
} from './thumbnails.js';
export type {
  ThumbnailInput,
  ThumbnailMeta,
  ThumbnailServiceDeps,
  ThumbnailView,
} from './thumbnails.js';
export {
  AttachmentCompressor,
  COMPRESS_CACHE_DIR,
  MAX_COMPRESSED_BYTES,
  MAX_NATIVE_VIDEO_BYTES,
  MIN_VIDEO_BITRATE_KBPS,
  jpegQualityValue,
  resolveCompressTarget,
  resolveNativeAudioFormat,
  resolveVideoBitrateKbps,
} from './compress.js';
export type {
  AttachmentCompressInput,
  AttachmentCompressTarget,
  AttachmentCompressorDeps,
  CompressedAttachment,
  CompressFamily,
} from './compress.js';
export {
  deriveModalityText,
  deriveCacheKey,
  deriveCachePath,
  splitJpegFrames,
  DERIVE_CACHE_DIR,
  MAX_VIDEO_FRAMES,
  MAX_DERIVED_BYTES,
} from './derive.js';
export type {
  DeriveDeps,
  DeriveFailureReason,
  DeriveFamily,
  DeriveInput,
  DeriveResult,
} from './derive.js';
