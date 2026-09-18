import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeRejectedDrops, filterDroppedPaths, hasRejectedDrops } from './droppedPathGuard'

const TEMP = 'C:\\Users\\dev\\AppData\\Local\\Temp'

function mockClassify(
  impl: (paths: string[]) => Promise<Array<{ path: string; verdict: string }>>
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl)
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: { classifyDroppedPaths: fn }
  }
  return fn
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('filterDroppedPaths', () => {
  it('空数组不惊动主进程', async () => {
    const fn = mockClassify(async () => [])

    const result = await filterDroppedPaths([])

    expect(fn).not.toHaveBeenCalled()
    expect(result.accepted).toEqual([])
    expect(hasRejectedDrops(result.rejected)).toBe(false)
  })

  it('按主进程的判定分流', async () => {
    mockClassify(async () => [
      { path: 'D:\\Assets\\Rocks', verdict: 'ok' },
      { path: 'Pack (Update)\\Inner', verdict: 'not-absolute' },
      { path: `${TEMP}\\7zO8C3A1B2F\\Mesh.fbx`, verdict: 'archive-temp' }
    ])

    const result = await filterDroppedPaths(['a', 'b', 'c'])

    expect(result.accepted).toEqual(['D:\\Assets\\Rocks'])
    expect(result.rejected['not-absolute']).toEqual(['Pack (Update)\\Inner'])
    expect(result.rejected['archive-temp']).toEqual([`${TEMP}\\7zO8C3A1B2F\\Mesh.fbx`])
  })

  it('体检本身失败时全部放行 —— 这是防呆，不是权限门', async () => {
    mockClassify(async () => {
      throw new Error('IPC 挂了')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await filterDroppedPaths(['D:\\Assets\\Rocks'])

    expect(result.accepted).toEqual(['D:\\Assets\\Rocks'])
    expect(hasRejectedDrops(result.rejected)).toBe(false)
  })
})

describe('describeRejectedDrops', () => {
  it('没被挡下的东西就不说话', () => {
    expect(describeRejectedDrops({ 'not-absolute': [], 'archive-temp': [] })).toEqual([])
  })

  it('两种原因各合并成一条，带上条数', () => {
    expect(describeRejectedDrops({ 'not-absolute': ['a', 'b'], 'archive-temp': ['c'] })).toEqual([
      { key: 'dragImportGuard.fromArchive', params: { count: 2 } },
      { key: 'dragImportGuard.fromExtractorTemp', params: { count: 1 } }
    ])
  })
})
