import { describe, it, expect } from 'vitest'
import {
  ACCEPTED_ATTACHMENT_EXTENSIONS,
  ACCEPTED_ATTACHMENT_TYPES,
  ATTACHMENT_ACCEPT,
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
