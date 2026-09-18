/**
 * 文件夹语义跟旧的「集合」差一条，但正是用户抱怨的那条：
 * 集合剩 ≤1 个成员会自动解散，文件夹不会。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useBlueprintLibraryStore } from './blueprintLibraryStore'
import type { Blueprint } from '@renderer/views/BlueprintLibrary/types/blueprint'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

function seed(): {
  store: ReturnType<typeof useBlueprintLibraryStore>
  a: Blueprint
  b: Blueprint
} {
  const store = useBlueprintLibraryStore()
  const a = store.createBlueprint({ name: 'A', blueprintType: 'Actor', engineVersion: '5.5' })
  const b = store.createBlueprint({ name: 'B', blueprintType: 'Actor', engineVersion: '5.5' })
  return { store, a, b }
}

describe('moveBlueprintsToFolder', () => {
  it('移进文件夹：两边都更新', () => {
    const { store, a } = seed()
    const folder = store.createFolder('角色')

    store.moveBlueprintsToFolder([a.id], folder.id)

    expect(store.blueprints.find((bp) => bp.id === a.id)?.collectionId).toBe(folder.id)
    expect(store.collections.find((c) => c.id === folder.id)?.blueprintIds).toEqual([a.id])
  })

  it('移回根目录：清掉归属，但文件夹留着', () => {
    const { store, a } = seed()
    const folder = store.createFolder('角色')
    store.moveBlueprintsToFolder([a.id], folder.id)

    store.moveBlueprintsToFolder([a.id], '')

    expect(store.blueprints.find((bp) => bp.id === a.id)?.collectionId).toBeUndefined()
    // 这一条就是跟旧集合的分界线：拿走最后一个成员，文件夹不该消失
    expect(store.collections.some((c) => c.id === folder.id)).toBe(true)
  })

  it('剩一个成员也不解散 —— 旧的 removeFromCollection 会在这里把文件夹删掉', () => {
    const { store, a, b } = seed()
    const folder = store.createFolder('角色')
    store.moveBlueprintsToFolder([a.id, b.id], folder.id)

    store.moveBlueprintsToFolder([b.id], '')

    expect(store.collections.find((c) => c.id === folder.id)?.blueprintIds).toEqual([a.id])
  })

  it('换文件夹时从原来那个里摘干净，不会两边都挂着', () => {
    const { store, a } = seed()
    const from = store.createFolder('旧')
    const to = store.createFolder('新')
    store.moveBlueprintsToFolder([a.id], from.id)

    store.moveBlueprintsToFolder([a.id], to.id)

    expect(store.collections.find((c) => c.id === from.id)?.blueprintIds).toEqual([])
    expect(store.collections.find((c) => c.id === to.id)?.blueprintIds).toEqual([a.id])
  })

  it('目标 key 是脏的就什么都不做 —— 静默丢回根目录会把用户的整理搞乱', () => {
    const { store, a } = seed()
    const folder = store.createFolder('角色')
    store.moveBlueprintsToFolder([a.id], folder.id)

    store.moveBlueprintsToFolder([a.id], '不存在的文件夹')

    expect(store.blueprints.find((bp) => bp.id === a.id)?.collectionId).toBe(folder.id)
  })

  it('空列表直接返回', () => {
    const { store } = seed()
    expect(() => store.moveBlueprintsToFolder([], 'whatever')).not.toThrow()
  })
})

describe('createFolder', () => {
  it('新建的空文件夹会留在列表里', () => {
    const store = useBlueprintLibraryStore()
    const folder = store.createFolder('空的')
    expect(store.collections.find((c) => c.id === folder.id)?.blueprintIds).toEqual([])
  })
})
