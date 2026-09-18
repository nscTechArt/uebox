import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LibraryCard from './LibraryCard.vue'

function mountCard(
  props: Record<string, unknown> = {},
  slots: Record<string, string> = {}
): VueWrapper {
  return mount(LibraryCard, { props: { name: 'BP_Door', ...props }, slots })
}

describe('LibraryCard', () => {
  it('渲染名称、次要信息与统计，缺省的行不占位', () => {
    const wrapper = mountCard({ meta: 'Actor · UE 5.5', stats: '42 节点' })

    expect(wrapper.find('.card-name').text()).toBe('BP_Door')
    expect(wrapper.find('.card-name').attributes('title')).toBe('BP_Door')
    expect(wrapper.find('.card-meta').text()).toBe('Actor · UE 5.5')
    expect(wrapper.find('.card-stats').text()).toBe('42 节点')

    const bare = mountCard()
    expect(bare.find('.card-meta').exists()).toBe(false)
    expect(bare.find('.card-stats').exists()).toBe(false)
  })

  it('给了 cover / footnote 插槽就渲染进对应位置', () => {
    const wrapper = mountCard(
      {},
      {
        cover: '<div class="card-cover"><span class="fav-badge">★</span></div>',
        footnote: '<div class="card-tags"><span class="tag">#输入</span></div>'
      }
    )

    expect(wrapper.find('.card-cover .fav-badge').exists()).toBe(true)
    expect(wrapper.find('.card-info .card-tags .tag').text()).toBe('#输入')
  })

  /**
   * 菜单挂在卡片上、不在封面里 —— 封面是 overflow:hidden 的，
   * 下拉放进去会被裁掉。没给 menu 插槽时整个按钮都不该出现。
   */
  it('只有给了 menu 插槽才长出「⋯」按钮，且菜单不在封面里', () => {
    const withoutMenu = mountCard({}, { cover: '<div class="card-cover" />' })
    expect(withoutMenu.find('.menu-trigger').exists()).toBe(false)

    const withMenu = mountCard(
      {},
      {
        cover: '<div class="card-cover" />',
        menu: '<div class="menu-item">编辑</div>'
      }
    )
    expect(withMenu.find('.menu-trigger').exists()).toBe(true)
    expect(withMenu.find('.card-cover .card-menu').exists()).toBe(false)
    expect(withMenu.find('.menu-dropdown .menu-item').text()).toBe('编辑')
  })

  /**
   * 合并预览要整块替换封面与信息区，不能和它们并排渲染 ——
   * 否则拖拽合并时卡片会变成上下两截。
   */
  it('body 插槽整块替换封面与信息区', () => {
    const wrapper = mountCard(
      {},
      {
        body: '<div class="merge-preview" />',
        cover: '<div class="card-cover" />'
      }
    )

    expect(wrapper.find('.merge-preview').exists()).toBe(true)
    expect(wrapper.find('.card-cover').exists()).toBe(false)
    expect(wrapper.find('.card-info').exists()).toBe(false)
  })

  it('create 模式只渲染加号与文案', () => {
    const wrapper = mount(LibraryCard, {
      props: { create: true },
      slots: { default: '新建蓝图' }
    })

    expect(wrapper.classes()).toContain('is-create')
    expect(wrapper.find('.create-icon').text()).toBe('+')
    expect(wrapper.find('.create-text').text()).toBe('新建蓝图')
    expect(wrapper.find('.card-info').exists()).toBe(false)
  })

  /**
   * 拖放状态类由调用方通过 :class 落到根节点上，组件不自己管状态。
   * 这条守的是「attrs 会落到根节点」这个前提 —— 一旦哪天加了第二个根节点，
   * 类名和点击监听都会静默丢掉。
   */
  it('外部传入的 class 与监听落在根节点上', async () => {
    const wrapper = mount(LibraryCard, {
      props: { name: 'BP_Door' },
      attrs: { class: 'merging', draggable: 'true' }
    })

    expect(wrapper.classes()).toContain('library-card')
    expect(wrapper.classes()).toContain('merging')
    expect(wrapper.attributes('draggable')).toBe('true')

    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })
})
