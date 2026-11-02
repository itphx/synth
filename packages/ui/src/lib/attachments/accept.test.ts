import { describe, it, expect } from 'vitest'
import {
  ACCEPTED_ATTACHMENT_EXTENSIONS,
  ACCEPTED_ATTACHMENT_TYPES,
  ATTACHMENT_ACCEPT,
  buildAttachmentAccept,
  getAttachmentFileExtension,
  isAcceptedAttachment,
} from './accept'

describe('ACCEPTED_ATTACHMENT_TYPES', () => {
  it('содержит базовые типы: png/jpeg/gif/webp, pdf, office, текст и конфиги', () => {
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('image/png')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('image/jpeg')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('image/gif')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('image/webp')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('application/pdf')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('text/*')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('application/json')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('application/yaml')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('application/toml')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('application/xml')
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('text/csv')
  })

  it('не содержит HEIC/HEIF — они конвертируются отдельно', () => {
    expect(ACCEPTED_ATTACHMENT_TYPES).not.toContain('image/heic')
    expect(ACCEPTED_ATTACHMENT_TYPES).not.toContain('image/heif')
  })

  it('содержит видео, аудио и avif', () => {
    expect(ACCEPTED_ATTACHMENT_TYPES).toContain('image/avif')
    for (const mime of ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']) {
      expect(ACCEPTED_ATTACHMENT_TYPES).toContain(mime)
    }
    for (const mime of [
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/flac',
      'audio/mp4',
      'audio/aac',
      'audio/opus',
    ]) {
      expect(ACCEPTED_ATTACHMENT_TYPES).toContain(mime)
    }
  })
})

describe('ACCEPTED_ATTACHMENT_EXTENSIONS', () => {
  it('содержит расширения из карты mime→ext и ручные расширения кода/конфигов', () => {
    expect(ACCEPTED_ATTACHMENT_EXTENSIONS).toContain('png')
    expect(ACCEPTED_ATTACHMENT_EXTENSIONS).toContain('docx')
    expect(ACCEPTED_ATTACHMENT_EXTENSIONS).toContain('ts')
    expect(ACCEPTED_ATTACHMENT_EXTENSIONS).toContain('tsx')
    expect(ACCEPTED_ATTACHMENT_EXTENSIONS).toContain('ipynb')
    expect(ACCEPTED_ATTACHMENT_EXTENSIONS).toContain('drawio')
  })

  it('содержит медиа-расширения (видео/аудио)', () => {
    for (const extension of ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'avif']) {
      expect(ACCEPTED_ATTACHMENT_EXTENSIONS).toContain(extension)
    }
  })

  it('не содержит heic/heif/exe/svg', () => {
    expect(ACCEPTED_ATTACHMENT_EXTENSIONS).not.toContain('heic')
    expect(ACCEPTED_ATTACHMENT_EXTENSIONS).not.toContain('heif')
    expect(ACCEPTED_ATTACHMENT_EXTENSIONS).not.toContain('exe')
    expect(ACCEPTED_ATTACHMENT_EXTENSIONS).not.toContain('svg')
  })
})

describe('ATTACHMENT_ACCEPT', () => {
  it('склеивает MIME-типы и расширения с точкой', () => {
    expect(ATTACHMENT_ACCEPT).toContain('image/png')
    expect(ATTACHMENT_ACCEPT).toContain('.docx')
    expect(ATTACHMENT_ACCEPT).toContain('.ts')
    expect(ATTACHMENT_ACCEPT.split(',').length).toBe(
      ACCEPTED_ATTACHMENT_TYPES.length + ACCEPTED_ATTACHMENT_EXTENSIONS.length,
    )
  })

  it('не упоминает heic', () => {
    expect(ATTACHMENT_ACCEPT).not.toContain('heic')
  })

  it('по умолчанию включает видео/аудио MIME и расширения', () => {
    expect(ATTACHMENT_ACCEPT).toContain('video/mp4')
    expect(ATTACHMENT_ACCEPT).toContain('audio/mpeg')
    expect(ATTACHMENT_ACCEPT).toContain('.mp4')
    expect(ATTACHMENT_ACCEPT).toContain('.mp3')
  })
})

describe('buildAttachmentAccept', () => {
  it('без аргументов совпадает с полным ATTACHMENT_ACCEPT', () => {
    expect(buildAttachmentAccept()).toBe(ATTACHMENT_ACCEPT)
  })

  it('выключенные видео/аудио исключают их MIME и расширения', () => {
    const accept = buildAttachmentAccept({ video: false, audio: false })

    expect(accept).not.toContain('video/mp4')
    expect(accept).not.toContain('audio/mpeg')
    expect(accept).not.toContain('.mp4')
    expect(accept).not.toContain('.m4v')
    expect(accept).not.toContain('.webm')
    expect(accept).not.toContain('.mp3')
    expect(accept).not.toContain('.ogg')
    expect(accept).not.toContain('.oga')
    // Остальные семейства на месте.
    expect(accept).toContain('image/png')
    expect(accept).toContain('application/pdf')
    expect(accept).toContain('.ts')
  })

  it('выключенное изображение убирает image/* и его расширения, но не трогает pdf', () => {
    const accept = buildAttachmentAccept({ image: false })

    expect(accept).not.toContain('image/png')
    expect(accept).not.toContain('.png')
    expect(accept).not.toContain('.avif')
    expect(accept).toContain('application/pdf')
    expect(accept).toContain('.pdf')
    expect(accept).toContain('video/mp4')
  })

  it('выключенный PDF убирает application/pdf и .pdf', () => {
    const accept = buildAttachmentAccept({ pdf: false })

    expect(accept).not.toContain('application/pdf')
    expect(accept).not.toContain('.pdf')
    expect(accept).toContain('image/png')
  })
})

describe('isAcceptedAttachment', () => {
  it('принимает png, pdf и docx', () => {
    expect(isAcceptedAttachment('photo.png', 'image/png')).toBe(true)
    expect(isAcceptedAttachment('photo.png')).toBe(true)
    expect(isAcceptedAttachment('manual.pdf', 'application/pdf')).toBe(true)
    expect(isAcceptedAttachment('manual.pdf')).toBe(true)
    expect(
      isAcceptedAttachment(
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true)
    expect(isAcceptedAttachment('report.docx')).toBe(true)
  })

  it('принимает текст и исходники', () => {
    expect(isAcceptedAttachment('notes.txt', 'text/plain')).toBe(true)
    expect(isAcceptedAttachment('config.yaml', 'application/yaml')).toBe(true)
    expect(isAcceptedAttachment('main.ts')).toBe(true)
  })

  it('не принимает svg и exe', () => {
    expect(isAcceptedAttachment('icon.svg', 'image/svg+xml')).toBe(false)
    expect(isAcceptedAttachment('icon.svg')).toBe(false)
    expect(isAcceptedAttachment('setup.exe', 'application/x-msdownload')).toBe(false)
    expect(isAcceptedAttachment('setup.exe')).toBe(false)
  })

  it('принимает видео и аудио по MIME и по расширению', () => {
    expect(isAcceptedAttachment('clip.mp4', 'video/mp4')).toBe(true)
    expect(isAcceptedAttachment('clip.mp4')).toBe(true)
    expect(isAcceptedAttachment('clip.m4v')).toBe(true)
    expect(isAcceptedAttachment('clip.webm', 'video/webm')).toBe(true)
    expect(isAcceptedAttachment('clip.mov')).toBe(true)
    expect(isAcceptedAttachment('sound.mp3', 'audio/mpeg')).toBe(true)
    expect(isAcceptedAttachment('sound.mp3')).toBe(true)
    expect(isAcceptedAttachment('sound.oga')).toBe(true)
    expect(isAcceptedAttachment('sound.flac')).toBe(true)
    expect(isAcceptedAttachment('photo.avif', 'image/avif')).toBe(true)
  })

  it('не принимает HEIC (нативной поддержки нет)', () => {
    expect(isAcceptedAttachment('photo.heic', 'image/heic')).toBe(false)
    expect(isAcceptedAttachment('photo.heic')).toBe(false)
    expect(isAcceptedAttachment('photo.heif', 'image/heif')).toBe(false)
  })
})

describe('getAttachmentFileExtension', () => {
  it('достаёт расширение без точки и в нижнем регистре', () => {
    expect(getAttachmentFileExtension('Photo.PNG')).toBe('png')
    expect(getAttachmentFileExtension('dir/sub/file.tar.gz')).toBe('gz')
    expect(getAttachmentFileExtension('noext')).toBe('')
  })

  it('точечный файл трактуется как расширение', () => {
    expect(getAttachmentFileExtension('.env')).toBe('env')
  })
})
