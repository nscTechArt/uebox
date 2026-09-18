import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import ImagePreviewArea from './ImagePreviewArea.vue'
import { openImageViewer } from '@renderer/services/imageViewer'

vi.mock('@renderer/services/imageViewer', () => ({
  openImageViewer: vi.fn()
}))

function mountPreview(images: string[]): ReturnType<typeof mount> {
  return mount(ImagePreviewArea, {
    props: { images, isLoading: false }
  })
}

describe('ImagePreviewArea result reveal', () => {
  it('等浏览器真正加载到图片后才揭示生成结果', async () => {
    const wrapper = mountPreview(['local-resource://vault/generated.png'])
    const image = wrapper.find('img.preview-image')

    expect(image.classes()).not.toContain('is-ready')
    expect(wrapper.find('.result-preparing-state').exists()).toBe(true)

    await image.trigger('load')

    expect(image.classes()).toContain('is-ready')
    expect(wrapper.find('.result-preparing-state').exists()).toBe(false)
  })

  it('图片加载失败时不留下永久透明的预览位', async () => {
    const wrapper = mountPreview(['local-resource://vault/missing.png'])
    const image = wrapper.find('img.preview-image')

    await image.trigger('error')

    expect(image.classes()).toContain('is-ready')
    expect(wrapper.find('.result-preparing-state').exists()).toBe(false)
  })

  it('切换到下一张时重新等待那张图片加载完成', async () => {
    const wrapper = mountPreview([
      'local-resource://vault/first.png',
      'local-resource://vault/second.png'
    ])

    await wrapper.find('img.preview-image').trigger('load')
    await wrapper.find('.nav-btn.next').trigger('click')

    const secondImage = wrapper.find('img.preview-image')
    expect(secondImage.attributes('src')).toBe('local-resource://vault/second.png')
    expect(secondImage.classes()).not.toContain('is-ready')
    expect(wrapper.find('.result-preparing-state').exists()).toBe(true)

    await secondImage.trigger('load')

    expect(secondImage.classes()).toContain('is-ready')
    expect(wrapper.find('.result-preparing-state').exists()).toBe(false)
  })

  it('从历史记录放大后以当前图片为起点翻阅完整历史', async () => {
    const historyItems = [
      { src: 'local-resource://vault/newest.png' },
      { src: 'local-resource://vault/current.png' },
      { src: 'local-resource://vault/older.png' }
    ]
    const wrapper = mount(ImagePreviewArea, {
      props: {
        images: ['local-resource://vault/current.png'],
        viewerItems: historyItems,
        isLoading: false
      }
    })

    await wrapper.find('img.preview-image').trigger('click')

    expect(openImageViewer).toHaveBeenCalledWith({
      items: historyItems,
      index: 1
    })
  })
})

describe('ImagePreviewArea toolbar actions', () => {
  it('动作作用在当前翻到的那张，而不是永远第一张', async () => {
    const wrapper = mountPreview([
      'local-resource://vault/front.png',
      'local-resource://vault/left.png'
    ])

    await wrapper.find('.nav-btn.next').trigger('click')
    await wrapper.findAll('.toolbar .tool-btn')[2].trigger('click')

    expect(wrapper.emitted('action')).toEqual([[{ key: 'download', index: 1 }]])
  })

  it('生成失败时工具栏仍在 —— 那条记录照样能回填参数、删掉', () => {
    const wrapper = mount(ImagePreviewArea, {
      props: { images: [], isLoading: false, error: '模型返回了错误', prompt: '一把剑' }
    })

    expect(wrapper.find('.toolbar').exists()).toBe(true)
    // 没有图，平铺的转参考/复制/下载都不该出现，只剩「⋯」
    expect(wrapper.findAll('.toolbar .tool-btn')).toHaveLength(1)
    expect(wrapper.find('.toolbar .tool-btn.icon-only').exists()).toBe(true)
  })

  it('还没生成过任何东西时不摆工具栏', () => {
    const wrapper = mount(ImagePreviewArea, { props: { images: [], isLoading: false } })

    expect(wrapper.find('.toolbar').exists()).toBe(false)
    expect(wrapper.find('.empty-state').exists()).toBe(true)
  })
})
