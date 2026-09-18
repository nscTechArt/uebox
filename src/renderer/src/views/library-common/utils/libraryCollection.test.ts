import { describe, expect, it } from 'vitest'
import { sortLibraryEntries } from './libraryCollection'

const entries = [
  { id: 'a', name: 'Bravo', createdAt: 30, updatedAt: 5 },
  { id: 'b', name: 'alpha', createdAt: 20, updatedAt: 10 },
  { id: 'c', name: 'Charlie', createdAt: 10, updatedAt: 20 }
]

describe('sortLibraryEntries', () => {
  it('recent 按 updatedAt 降序', () => {
    expect(sortLibraryEntries(entries, 'recent').map((e) => e.id)).toEqual(['c', 'b', 'a'])
  })

  it('name 按名称字典序（不区分大小写）', () => {
    expect(sortLibraryEntries(entries, 'name').map((e) => e.id)).toEqual(['b', 'a', 'c'])
  })

  it('created 按 createdAt 降序', () => {
    expect(sortLibraryEntries(entries, 'created').map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('不改原数组', () => {
    const source = [...entries]
    sortLibraryEntries(source, 'name')
    expect(source.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })
})
