/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ProfileObjectStorage from './ProfileObjectStorage.vue'
import {
  DEFAULT_OBJECT_STORAGE_CONFIG,
  type ObjectStorageConfigView
} from '@core/shared/objectStorage'

/**
 * 对象存储由创作者 Token Plan 提供（`uebox` 预设）时：没有表单可填，
 * 连接那一层换成一行说明、用量和「怎么换回自己的桶」，文件那一层照旧。
 */

function mountWith(view: ObjectStorageConfigView): ReturnType<typeof mount> {
  window.api = {
    objectStorage: {
      get: vi.fn(async () => view),
      list: vi.fn(async () => ({
        success: true,
        objects: [{ key: 'a.png', size: 1024 * 1024, lastModified: '' }],
        usage: {
          quotaBytes: 10 * 1024 ** 3,
          usedBytes: 1024 * 1024,
          objectCount: 1,
          retentionDays: 30
        }
      }))
    }
  } as unknown as typeof window.api
  return mount(ProfileObjectStorage, {
    global: { stubs: { 'a-input-number': true, 'a-form': true } }
  })
}

describe('ProfileObjectStorage：套餐存储', () => {
  it('不要密钥表单；显示套餐提供、用量、保留天数和换回的办法', async () => {
    const wrapper = mountWith({
      ...DEFAULT_OBJECT_STORAGE_CONFIG,
      enabled: true,
      preset: 'uebox',
      hasSecret: false
    })
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('UEBox Token Plan 提供，不用填密钥')
    expect(text).toContain('已用 1.0 MB / 10.00 GB')
    expect(text).toContain('最后一次用到后留 30 天')
    expect(text).toContain('重新导入')
    expect(text).not.toContain('AccessKey')
  })
})
