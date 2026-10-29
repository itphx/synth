import { describe, it, expect } from 'vitest'
import {
  canDeleteOccupiedPath,
  repoOccupiedAction,
  repoOccupiedDetails,
} from './gitOccupancy'

/**
 * ADR-076: 409 «путь занят» различает три состояния, и каждому нужно своё
 * действие. Разбор `details` — чистый, поэтому проверяется без React и сети.
 */
describe('repoOccupiedAction — действие по 409 «путь занят»', () => {
  it('repo → зарегистрировать существующий', () => {
    expect(repoOccupiedAction({ path: 'app', occupied: 'repo' })).toBe('register')
  })

  it('stub → удалить и повторить', () => {
    expect(repoOccupiedAction({ path: 'app', occupied: 'stub' })).toBe('delete-and-retry')
  })

  it('dir → указать другой путь', () => {
    expect(repoOccupiedAction({ path: 'app', occupied: 'dir', entries: 3 })).toBe('choose-path')
  })

  it('undefined → нет действия (прежний текст без кнопок)', () => {
    expect(repoOccupiedAction(undefined)).toBeNull()
  })

  it('неизвестное занятие пути → нет действия', () => {
    expect(repoOccupiedAction({ path: 'app', occupied: 'something-else' })).toBeNull()
    expect(repoOccupiedAction({ occupied: null })).toBeNull()
  })

  it('не-объект в details не ломает разбор', () => {
    expect(repoOccupiedAction('repo')).toBeNull()
    expect(repoOccupiedAction(42)).toBeNull()
    expect(repoOccupiedAction([])).toBeNull()
  })
})

describe('repoOccupiedDetails — разбор details', () => {
  it('переносит path/occupied/entries', () => {
    expect(repoOccupiedDetails({ path: 'busy', occupied: 'dir', entries: 2 })).toEqual({
      path: 'busy',
      occupied: 'dir',
      entries: 2,
    })
  })

  it('entries только у dir и только числом', () => {
    expect(repoOccupiedDetails({ path: 'app', occupied: 'repo' })).toEqual({ path: 'app', occupied: 'repo' })
    expect(repoOccupiedDetails({ path: 'app', occupied: 'dir', entries: '2' })).toEqual({
      path: 'app',
      occupied: 'dir',
    })
  })

  it('path не строка → пустая строка (не падаем)', () => {
    expect(repoOccupiedDetails({ occupied: 'stub' })).toEqual({ path: '', occupied: 'stub' })
  })
})

describe('canDeleteOccupiedPath — можно ли удалять занятый путь', () => {
  it('обычный путь — можно', () => {
    expect(canDeleteOccupiedPath({ path: 'app', occupied: 'stub' })).toBe(true)
  })

  it('корень workspace ("" и ".") — нельзя', () => {
    expect(canDeleteOccupiedPath({ path: '', occupied: 'stub' })).toBe(false)
    expect(canDeleteOccupiedPath({ path: '.', occupied: 'stub' })).toBe(false)
    expect(canDeleteOccupiedPath({ path: '   ', occupied: 'stub' })).toBe(false)
  })

  it('нет details — нельзя', () => {
    expect(canDeleteOccupiedPath(null)).toBe(false)
  })
})
