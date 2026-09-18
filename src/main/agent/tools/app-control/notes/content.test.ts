import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<number, Record<string, unknown>>()

// 说明存在保管库里（assetNote），不是公共库那张 note 表 ——
// 它跟着资产和文件夹走，保管库拷走时必须一起走
vi.mock('../../../../sqliteDataBase', () => ({
  getVaultDatabase: () => ({})
}))

vi.mock('../../../../sqliteDataBase/models/assetNote', () => ({
  getAssetNoteById: (_db: unknown, id: number) => store.get(id),
  searchAssetNotes: () => [...store.values()],
  createAssetNote: () => 1,
  updateAssetNote: () => true,
  deleteAssetNote: () => true
}))

vi.mock('../../../../sqliteDataBase/models/assetData', () => ({
  getAssetDataByKey: () => undefined,
  updateAssetData: () => true
}))

vi.mock('../../../../sqliteDataBase/models/assetFolder', () => ({
  getAssetFolderByKey: () => undefined,
  updateAssetFolder: () => true
}))

import { getNoteAction, searchNotesAction } from './NotesController'

function seed(id: number, contentLength: number): void {
  store.set(id, {
    id,
    title: `笔记 ${id}`,
    content: 'x'.repeat(contentLength),
    created_at: '2026-01-01',
    updated_at: '2026-01-01'
  })
}

/**
 * 笔记正文的读取路径。
 *
 * 原来是「列表只给 200 字预览 + 详情硬截 2000 字」：想读一篇笔记要两次调用，
 * 换回来的还可能是半截正文，而且**没有任何办法拿到后半截**。这是 Router
 * 时代的省法，现在只剩下往返成本。
 */
describe('笔记正文', () => {
  beforeEach(() => store.clear())

  it('note_get 返回完整正文，多长都不截', async () => {
    seed(1, 50_000)
    const result = await getNoteAction({ id: 1 })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.note?.content).toHaveLength(50_000)
    expect(result.note?.contentTruncated).toBeUndefined()
  })

  it('列表默认给开头一段，并**明说**这是截断的', async () => {
    seed(1, 5_000)
    const result = await searchNotesAction({})

    expect(result.success).toBe(true)
    if (!result.success) return
    const note = result.notes?.[0]
    expect(note?.content).toHaveLength(400)
    // 关键：调用方能分辨「笔记就这么短」和「后面还有」
    expect(note?.contentTruncated).toBe(true)
    expect(note?.contentLength).toBe(5_000)
    expect(result.message).toContain('full=true')
  })

  it('短笔记在列表里原样给全，不标截断', async () => {
    seed(1, 120)
    const result = await searchNotesAction({})

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.notes?.[0].content).toHaveLength(120)
    expect(result.notes?.[0].contentTruncated).toBeUndefined()
    expect(result.message ?? '').not.toContain('full=true')
  })

  /** 一个参数换掉「一篇一次 note_get」的整串往返 */
  it('full=true 时列表直接给全文', async () => {
    seed(1, 5_000)
    const result = await searchNotesAction({ full: true })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.notes?.[0].content).toHaveLength(5_000)
    expect(result.notes?.[0].contentTruncated).toBeUndefined()
  })
})
