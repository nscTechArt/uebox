import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { libraryPackageAPI } from './libraryPackage'

/**
 * 真机上用户看到的是「有 4 项没能存进保管库」，副标题说多半是切了保管库或者
 * 包目录被改名 —— 全是无辜的。真正的原因是条目从 `ref<Entry[]>` 里取出来就是
 * 深响应式代理，Proxy 过不了 Electron IPC 的结构化克隆。
 *
 * 这里用 `structuredClone` 模拟 IPC 边界：不拍平的代理必须抛（证明模拟忠实），
 * API 层真正发出去的东西必须过得去。
 */
function installApi(): { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => ({ success: true, data: null }))
  const update = vi.fn(async () => ({ success: true, data: null }))
  window.api = { libraryPackage: { create, update } } as unknown as typeof window.api
  return { create, update }
}

describe('libraryPackageAPI 的 IPC 入参', () => {
  beforeEach(() => {
    window.api = undefined as unknown as typeof window.api
  })

  it('create 的 payload 是响应式代理时先拍成纯对象', async () => {
    const { create } = installApi()
    const entries = ref([{ id: 'm1', name: '水面', graph: { nodes: [{ id: 'n1' }] } }])
    const entry = entries.value[0]

    // 忠实性检查：不拍平就直接 structuredClone，和 Electron 一样会炸
    expect(() => structuredClone(entry)).toThrow()

    await libraryPackageAPI.create({
      library: 'material',
      id: entry.id,
      name: entry.name,
      payload: entry
    })

    const arg = create.mock.calls[0][0]
    expect(() => structuredClone(arg)).not.toThrow()
    expect(arg.payload).toEqual({ id: 'm1', name: '水面', graph: { nodes: [{ id: 'n1' }] } })
  })

  it('update 的 patch 是响应式代理时先拍成纯对象', async () => {
    const { update } = installApi()
    const entries = ref([{ id: 'm1', name: '水面', graph: { nodes: [] } }])
    const entry = entries.value[0]

    await libraryPackageAPI.update('C:/vault/水面.uematerial', {
      name: entry.name,
      payload: entry,
      cover: ''
    })

    const patch = update.mock.calls[0][1]
    expect(() => structuredClone(patch)).not.toThrow()
    // 清封面靠的就是这个显式空串，拍平不能把它弄丢
    expect(patch.cover).toBe('')
    expect(patch.name).toBe('水面')
  })
})
