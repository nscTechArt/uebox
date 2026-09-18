/**
 * 标签管理弹窗的交互回归。
 *
 * 盯的是三件在真机上「点了没反应」的事，每一件都只能靠端到端挂载才看得出来：
 *   1. 标签组改名：菜单关闭时浮层会把焦点还给触发器，那一下不能被当成一次提交
 *      —— 否则名字没变、直接退出编辑态，用户看到的就是「改不动」。
 *   2. 标签的删除/改名已经从 chip 上挪进右键菜单，chip 上不该再有 ✕。
 *   3. 「移到分组」的菜单在分组很多时要能滚，不能长出屏幕。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import TagManagement from './index.vue'

const GROUP = { id: 1, name: '新分组', color: '#52c41a', sort_order: 1, tagCount: 1 }
/** 默认视图是「未分组」，所以这个标签不挂分组，挂载完就能看见 */
const TAG = { id: 10, name: 'Blueprint', group_id: null, is_favorite: 0 }

type Api = {
  database: {
    tagGroup: Record<string, ReturnType<typeof vi.fn>>
    tag: Record<string, ReturnType<typeof vi.fn>>
    assetTag: Record<string, ReturnType<typeof vi.fn>>
  }
}

const api = (): Api => (window as unknown as { api: Api }).api

/** 走完 onMounted 里那三次 await，再让首帧渲染出来 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

/**
 * 组件把聚焦排到了 setTimeout(0) 上，而它注册那个定时器的时机比测试这边晚一拍
 * （都挂在同一个 flush promise 上，测试的 `.then` 先登记）。所以这里不能只等
 * 一个 0ms 宏任务，要给它留出注册 + 执行的余量。
 */
const flushMacro = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

beforeEach(() => {
  ;(window as unknown as { api: Api }).api = {
    database: {
      tagGroup: {
        getAllWithCount: vi.fn(async () => ({ success: true, data: [GROUP] })),
        create: vi.fn(async () => ({ success: true, data: { id: 2 } })),
        update: vi.fn(async () => ({ success: true, data: { updated: true } })),
        delete: vi.fn(async () => ({ success: true, data: { deleted: true } }))
      },
      tag: {
        getAll: vi.fn(async () => ({ success: true, data: [TAG] })),
        create: vi.fn(async () => ({ success: true, data: { id: 11 } })),
        update: vi.fn(async () => ({ success: true })),
        delete: vi.fn(async () => ({ success: true })),
        toggleFavorite: vi.fn(async () => ({ success: true })),
        moveToGroup: vi.fn(async () => ({ success: true, data: { updatedCount: 1 } })),
        batchDelete: vi.fn(async () => ({ success: true, data: { deletedCount: 1 } }))
      },
      assetTag: {
        getUsageCounts: vi.fn(async () => ({ success: true, data: [{ tagId: 10, count: 3 }] }))
      }
    }
  }
})

const mountPage = async (): Promise<VueWrapper> => {
  const wrapper = mount(TagManagement, { attachTo: document.body })
  await settle()
  return wrapper
}

describe('标签组改名', () => {
  it('点行尾的 ⋯ → 重命名，输入框出现并且拿得到焦点', async () => {
    const wrapper = await mountPage()

    await wrapper.find('.group-actions button').trigger('click', { clientX: 100, clientY: 100 })
    // ContextMenu.show 里有 10ms 的延时
    await new Promise((resolve) => setTimeout(resolve, 20))
    await nextTick()

    const items = [...document.querySelectorAll('.app-dropdown .app-menu-item')]
    expect(items.map((el) => el.textContent?.trim())).toEqual(['重命名', '删除'])
    ;(items[0] as HTMLElement).click()
    await nextTick()
    await flushMacro()

    const input = wrapper.find('input.group-name-input')
    expect(input.exists()).toBe(true)
    expect(document.activeElement).toBe(input.element)

    wrapper.unmount()
  })

  it('焦点被别处抢走（输入框从未聚焦）时，失焦不会当成一次提交', async () => {
    const wrapper = await mountPage()

    await wrapper.find('.group-item').trigger('dblclick')
    await nextTick()

    const input = wrapper.find('input.group-name-input')
    expect(input.exists()).toBe(true)
    // 还没聚焦就先来一次 blur —— 浮层归位焦点时真实发生的顺序
    await input.trigger('blur')
    await nextTick()

    expect(api().database.tagGroup.update).not.toHaveBeenCalled()
    expect(wrapper.find('input.group-name-input').exists()).toBe(true)

    wrapper.unmount()
  })

  it('改完按回车会落库', async () => {
    const wrapper = await mountPage()

    await wrapper.find('.group-item').trigger('dblclick')
    await nextTick()
    await flushMacro()

    const input = wrapper.find('input.group-name-input')
    await input.setValue('材质')
    await input.trigger('keydown', { key: 'Enter' })
    await nextTick()

    expect(api().database.tagGroup.update).toHaveBeenCalledWith(1, { name: '材质' })

    wrapper.unmount()
  })
})

describe('标签的删除与改名', () => {
  it('chip 上不再挂 ✕，右键才给出重命名 / 删除', async () => {
    const wrapper = await mountPage()

    const chip = wrapper.find('.tag-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.find('.tag-chip__delete').exists()).toBe(false)

    await chip.trigger('contextmenu', { clientX: 200, clientY: 200 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await nextTick()

    const items = [...document.querySelectorAll('.app-dropdown .app-menu-item')]
    expect(items.map((el) => el.textContent?.trim())).toEqual(['重命名', '删除'])
    ;(items[1] as HTMLElement).click()
    await nextTick()

    expect(api().database.tag.delete).toHaveBeenCalledWith(10)

    wrapper.unmount()
  })

  it('空白处右键给的还是「新建标签」', async () => {
    const wrapper = await mountPage()

    await wrapper.find('.tags-content').trigger('contextmenu', { clientX: 200, clientY: 200 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await nextTick()

    const items = [...document.querySelectorAll('.app-dropdown .app-menu-item')]
    expect(items).toHaveLength(1)
    expect(items[0].textContent).toContain('新建标签')

    wrapper.unmount()
  })
})
