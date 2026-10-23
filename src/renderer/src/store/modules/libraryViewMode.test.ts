import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlueprintLibraryStore } from './blueprintLibraryStore'
import { useMaterialLibraryStore } from './materialLibraryStore'

/**
 * 库的网格 / 列表选择要在重启后保留：它属于界面偏好，存在 localStorage 中。
 * 这里的「重启」指换一个 pinia 重新创建 store，localStorage 不清空。
 *
 * 保管库需模拟成可用的空库：没有 preload 时，hydrate 只在有旧数据时才读取界面偏好，
 * 那是浏览器调试用的路径，不是用户实际走的路径。
 */
describe('library view mode survives a restart', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('api', {
      libraryPackage: {
        scan: vi.fn(async () => ({ success: true, data: { entries: [], problems: [] } })),
        readMeta: vi.fn(async () => ({
          success: true,
          data: JSON.stringify({ migrated: { blueprint: true, material: true } })
        })),
        writeMeta: vi.fn(async () => ({ success: true, data: true })),
        create: vi.fn(async () => ({ success: true, data: null })),
        update: vi.fn(async () => ({ success: true, data: null })),
        rename: vi.fn(async () => ({ success: true, data: null })),
        delete: vi.fn(async () => ({ success: true, data: true })),
        writeFile: vi.fn(async () => ({ success: true, data: true })),
        readFile: vi.fn(async () => ({ success: true, data: null }))
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('remembers the blueprint gallery view mode', async () => {
    setActivePinia(createPinia())
    const before = useBlueprintLibraryStore()
    await before.ready
    before.setGalleryViewMode('list')
    await before.flushPersistence()

    setActivePinia(createPinia())
    const after = useBlueprintLibraryStore()
    await after.ready
    expect(after.galleryViewMode).toBe('list')
  })

  it('remembers the material gallery view mode', async () => {
    setActivePinia(createPinia())
    const before = useMaterialLibraryStore()
    await before.ready
    before.setViewMode('list')
    await before.flushPersistence()

    setActivePinia(createPinia())
    const after = useMaterialLibraryStore()
    await after.ready
    expect(after.viewMode).toBe('list')
  })

  it('falls back to grid when the saved blueprint view mode is unknown', async () => {
    localStorage.setItem('blueprint-library-ui', JSON.stringify({ galleryViewMode: 'card' }))

    setActivePinia(createPinia())
    const store = useBlueprintLibraryStore()
    await store.ready
    expect(store.galleryViewMode).toBe('grid')
  })
})
