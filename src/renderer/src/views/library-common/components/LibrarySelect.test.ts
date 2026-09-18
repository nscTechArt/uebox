import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import LibrarySelect from './LibrarySelect.vue'

describe('LibrarySelect', () => {
  it('未初始化的筛选值回落为空串，不产生无效 prop 警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(LibrarySelect, {
      props: {
        modelValue: undefined,
        options: [{ value: '', label: '全部类型' }],
        label: '蓝图类型'
      }
    })

    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('')
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Invalid prop'))
    warn.mockRestore()
  })
})
