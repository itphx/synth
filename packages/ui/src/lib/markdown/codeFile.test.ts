import { describe, expect, it } from 'vitest'

import { codeFileExtension, codeFileName, DEFAULT_CODE_EXTENSION } from './codeFile'

describe('codeFileExtension: алиасы fence-языков', () => {
  it.each([
    ['ts', 'ts'],
    ['mts', 'ts'],
    ['cts', 'ts'],
    ['tsx', 'tsx'],
    ['js', 'js'],
    ['mjs', 'js'],
    ['jsx', 'jsx'],
    ['sh', 'sh'],
    ['shell', 'sh'],
    ['shellscript', 'sh'],
    ['zsh', 'sh'],
    ['console', 'sh'],
    ['py', 'py'],
    ['yml', 'yml'],
    ['jsonc', 'json'],
    ['json5', 'json'],
    ['patch', 'diff'],
    ['md', 'md'],
    ['mdx', 'md'],
    ['htm', 'html'],
    ['xhtml', 'html'],
    ['xml', 'html'],
    ['scss', 'css'],
    ['less', 'css'],
    ['sql', 'sql'],
    // Канонические имена тоже принимаются (```typescript).
    ['typescript', 'ts'],
    ['bash', 'sh'],
    ['markdown', 'md'],
  ])('%s → %s', (lang, expected) => {
    expect(codeFileExtension(lang)).toBe(expected)
  })

  it('регистр и хвостовые параметры fence не мешают', () => {
    expect(codeFileExtension('TS')).toBe('ts')
    expect(codeFileExtension('ts title="app.ts"')).toBe('ts')
    expect(codeFileExtension('  py  ')).toBe('py')
  })

  it('неизвестный язык → txt', () => {
    expect(codeFileExtension('mermaid')).toBe(DEFAULT_CODE_EXTENSION)
    expect(codeFileExtension('brainfuck')).toBe('txt')
  })

  it('пустой, отсутствующий и text → txt', () => {
    expect(codeFileExtension('')).toBe('txt')
    expect(codeFileExtension('   ')).toBe('txt')
    expect(codeFileExtension(undefined)).toBe('txt')
    expect(codeFileExtension('text')).toBe('txt')
  })
})

describe('codeFileName', () => {
  it('имя файла — code.<ext>', () => {
    expect(codeFileName('ts')).toBe('code.ts')
    expect(codeFileName('patch')).toBe('code.diff')
    expect(codeFileName('yml')).toBe('code.yml')
  })

  it('неизвестный и пустой язык — code.txt', () => {
    expect(codeFileName('mermaid')).toBe('code.txt')
    expect(codeFileName(undefined)).toBe('code.txt')
  })
})
