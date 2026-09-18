import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AddSourceModal from './AddSourceModal.vue'

beforeEach(() => {
  window.api = {
    ...window.api,
    websocket: { getProjects: vi.fn().mockResolvedValue([]), call: vi.fn() }
  } as never
})

function mountModal(): ReturnType<typeof mount> {
  return mount(AddSourceModal, {
    props: { open: true },
    global: {
      stubs: {
        // 弹层用 <Teleport to="body">，不打桩的话内容跑到 wrapper 之外，findAll 看不见
        teleport: true,
        'a-button': { template: '<button><slot /></button>' },
        'a-input': true,
        'a-textarea': true,
        'a-tooltip': { template: '<div><slot /></div>' },
        'a-spin': { template: '<div><slot /></div>' }
      }
    }
  })
}

function optionLabels(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.option-item').map((node) => node.text())
}

describe('AddSourceModal 的社区版边界', () => {
  it('社区版也有 B 站 / YouTube 入口 —— 两条都走 BYOK', () => {
    const labels = optionLabels(mountModal()).join(' ')

    expect(labels).toContain('YouTube')
    expect(labels).toContain('Bilibili')
  })

  it('社区版保留网页与微信公众号 —— 它们有本地路径', () => {
    const labels = optionLabels(mountModal()).join(' ')

    // 网页：BYOK Jina Key，缺 Key 时回落到主进程本地正文抽取
    expect(labels).toContain('网站')
    // 微信公众号：主进程 cheerio 本地解析，不经任何服务端
    expect(labels).toContain('微信公众号')
  })
})
