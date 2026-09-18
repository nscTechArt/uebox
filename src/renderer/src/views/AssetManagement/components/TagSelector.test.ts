/**
 * 资产筛选里的标签选择器。
 *
 * 盯的是「三种状态各长什么样」：这块原来自己画了一套胶囊，和标签管理里的 chip
 * 是两种东西；现在统一走 AppTag，状态只靠颜色档位分，盒子尺寸不随状态变。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import Antd from 'ant-design-vue'
import TagSelector from './TagSelector.vue'

vi.mock('@renderer/api/tagGroup', () => ({
  default: { getAll: vi.fn(async () => [{ id: 1, name: '新分组' }]) }
}))

const TAGS = [
  { id: 1, name: 'SkeletalMesh' },
  { id: 2, name: 'Material' }
]

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    database: { tag: { getAll: vi.fn(async () => ({ success: true, data: TAGS })) } }
  }
})

const mountInline = async (): Promise<ReturnType<typeof mount>> => {
  const wrapper = mount(TagSelector, {
    props: { modelValue: [], inlineMode: true },
    global: { plugins: [Antd] }
  })
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
  return wrapper
}

describe('TagSelector 的标签样式', () => {
  it('标签走 AppTag，不再是自绘的 .tag-item', async () => {
    const wrapper = await mountInline()

    expect(wrapper.find('.tag-item').exists()).toBe(false)
    // 「无标签」+ 两个标签
    expect(wrapper.findAll('.app-tag')).toHaveLength(3)
    expect(wrapper.findAll('.app-tag--medium')).toHaveLength(3)

    wrapper.unmount()
  })

  it('左键 = 包含（强调实色），右键 = 排除（危险实色），再点一次回到中性', async () => {
    const wrapper = await mountInline()
    const tagOf = (name: string): ReturnType<typeof wrapper.find> =>
      wrapper.findAll('.app-tag').find((el) => el.text().includes(name))!

    // 起手：中性、未选中
    expect(tagOf('SkeletalMesh').classes()).toContain('app-tag--neutral')
    expect(tagOf('SkeletalMesh').classes()).not.toContain('app-tag--selected')

    await tagOf('SkeletalMesh').trigger('click')
    await nextTick()
    expect(tagOf('SkeletalMesh').classes()).toContain('app-tag--selected')
    expect(tagOf('SkeletalMesh').classes()).toContain('app-tag--neutral')

    await tagOf('Material').trigger('contextmenu')
    await nextTick()
    expect(tagOf('Material').classes()).toContain('app-tag--selected')
    expect(tagOf('Material').classes()).toContain('app-tag--danger')

    // 再点一次取消
    await tagOf('SkeletalMesh').trigger('click')
    await nextTick()
    expect(tagOf('SkeletalMesh').classes()).not.toContain('app-tag--selected')

    wrapper.unmount()
  })

  it('「无标签」是虚线档，选中时也保持虚线', async () => {
    const wrapper = await mountInline()
    const noTags = wrapper.findAll('.app-tag')[0]

    expect(noTags.text()).toContain('无标签')
    expect(noTags.classes()).toContain('app-tag--dashed')

    await noTags.trigger('click')
    await nextTick()
    const after = wrapper.findAll('.app-tag')[0]
    expect(after.classes()).toContain('app-tag--dashed')
    expect(after.classes()).toContain('app-tag--selected')

    wrapper.unmount()
  })
})
