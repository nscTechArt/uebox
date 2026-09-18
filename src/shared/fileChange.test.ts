import { describe, expect, it } from 'vitest'
import { fileDiff, readFileChange, mergeFileChanges } from './fileChange'

describe('fileDiff', () => {
  it('merges one turn without mutating snapshots or swallowing external changes', () => {
    const first = { path: 'C:/x.js', before: 'a', after: 'b', created: false }
    expect(mergeFileChanges([first, { ...first, before: 'b', after: 'c' }])).toEqual([
      { ...first, after: 'c' }
    ])
    expect(first.after).toBe('b')
    expect(mergeFileChanges([first, { ...first, before: 'external', after: 'c' }])).toHaveLength(2)
  })
  it('keeps separated edits and both line numbers', () => {
    const rows = fileDiff('a\nb\nc\nd\n', 'a\nB\nc\nD\n')
    expect(rows.map((row) => row.kind)).toEqual(['same', 'remove', 'add', 'same', 'remove', 'add'])
    expect(rows[3]).toMatchObject({ text: 'c\n', oldLine: 3, newLine: 3 })
  })
  it.each([
    ['', 'new\n'],
    ['old\n', ''],
    ['a\n', 'a'],
    ['a\r\n', 'a\n'],
    ['same', 'same'],
    ['x\n'.repeat(1100), 'y\n'.repeat(1100)]
  ])('reconstructs both exact contents', (before, after) => {
    const rows = fileDiff(before, after)
    expect(
      rows
        .filter((row) => row.kind !== 'add')
        .map((row) => row.text)
        .join('')
    ).toBe(before)
    expect(
      rows
        .filter((row) => row.kind !== 'remove')
        .map((row) => row.text)
        .join('')
    ).toBe(after)
  })
  it('rejects malformed historical records', () => {
    expect(readFileChange({ path: 'x', before: 1, after: '' })).toBeUndefined()
    expect(readFileChange(null)).toBeUndefined()
  })
})
