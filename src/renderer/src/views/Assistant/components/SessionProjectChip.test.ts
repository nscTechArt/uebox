import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useChatSidebarStore } from '@renderer/store/modules/chatSidebarStore'
import SessionProjectChip from './SessionProjectChip.vue'

/**
 * 顶栏那枚「归入项目」的胶囊。
 *
 * 守的是一条真实反馈：新开一条会话、一条消息都还没发就去切项目归属，
 * 点了没反应。原因是会话要等第一条消息才进 store，`setProject`
 * 找不到人就静默返回——界面上完全看不出来。
 */

/** AppDropdown 默认不渲染 overlay，测试里强制展开好点菜单项 */
const dropdownStub = {
  template: '<div><slot /><slot name="overlay" /></div>'
}

const menuStub = { template: '<div><slot /></div>' }
/** 提示气泡：只需要拿到 title，内容原样透出来 */
const tooltipStub = {
  props: ['title'],
  template: '<div class="tooltip-stub" :data-tip="title"><slot /></div>'
}
const menuItemStub = {
  emits: ['click'],
  template: '<div class="menu-item" @click="$emit(\'click\', $event)"><slot /></div>'
}

function mountChip(sessionId: string, pendingProjectName = ''): ReturnType<typeof mount> {
  return mount(SessionProjectChip, {
    props: { sessionId, pendingProjectName },
    global: {
      stubs: {
        AppDropdown: dropdownStub,
        AppTooltip: tooltipStub,
        AppMenu: menuStub,
        AppMenuItemGroup: menuStub,
        AppMenuItem: menuItemStub,
        AppMenuDivider: true
      }
    }
  })
}

describe('SessionProjectChip 切换项目归属', () => {
  it('会话还没进 store 时，点「归入项目」也要生效', async () => {
    const chatStore = useChatSessionsStore()
    const sidebarStore = useChatSidebarStore()
    sidebarStore.addManualProject({ projectName: 'dist' })

    // 刻意不 ensureSession：模拟「新建会话、还没发消息」
    expect(chatStore.sessionById('sid-new')).toBeNull()

    const wrapper = mountChip('sid-new')
    const items = wrapper.findAll('.menu-item')
    const dist = items.find((item) => item.text().includes('dist'))
    expect(dist).toBeDefined()

    await dist!.trigger('click')

    expect(chatStore.sessionById('sid-new')?.project?.projectName).toBe('dist')
  })

  it('会话已存在时照常改归属，并在胶囊上显示出来', async () => {
    const chatStore = useChatSessionsStore()
    const sidebarStore = useChatSidebarStore()
    chatStore.ensureSession('sid-old', '旧会话')
    chatStore.setProject('sid-old', { projectName: 'Alpha' })
    sidebarStore.addManualProject({ projectName: 'dist' })

    const wrapper = mountChip('sid-old')
    const dist = wrapper.findAll('.menu-item').find((item) => item.text().includes('dist'))
    await dist!.trigger('click')

    expect(chatStore.sessionById('sid-old')?.project?.projectName).toBe('dist')
    expect(wrapper.find('.chip-name').text()).toBe('dist')
  })

  /**
   * 引擎版本号长得像 `5.5.4-40574608+++UE5+Release-5.5`，
   * 塞进胶囊会把工程名整个挤出可视区，用户只看得到一串版本号。
   */
  it('胶囊上只显示工程名，长长的引擎版本号只出现在悬停提示里', () => {
    const chatStore = useChatSessionsStore()
    chatStore.ensureSession('sid-engine', '会话')
    chatStore.setProject('sid-engine', {
      projectName: 'UALinkDev55',
      engineVersion: '5.5.4-40574608+++UE5+Release-5.5'
    })

    const wrapper = mountChip('sid-engine')
    const chip = wrapper.find('.session-project-chip')

    expect(wrapper.find('.chip-name').text()).toBe('UALinkDev55')
    expect(chip.text()).not.toContain('5.5.4-40574608')
    // 提示走 AppTooltip，不是原生 title —— 原生那个没法跟主题走，
    // 而且延迟一秒才出来，跟应用里别处的提示气泡长得也不是一回事
    expect(wrapper.find('.tooltip-stub').attributes('data-tip')).toContain('5.5.4-40574608')
    expect(chip.attributes('title')).toBeUndefined()
  })

  /**
   * 侧边栏在工程标题上点「+」新建会话：会话要等第一条消息才进 store，
   * 在那之前归属只挂在路由的 `?project=` 上。胶囊不认它的话，用户明明是在
   * 这个工程下新建的会话，右上角却写着「未归属项目」。
   */
  it('会话还没建出来时，按侧边栏点「+」时选的工程显示', () => {
    const chatStore = useChatSessionsStore()
    expect(chatStore.sessionById('sid-pending')).toBeNull()

    const wrapper = mountChip('sid-pending', 'test222')

    expect(wrapper.find('.chip-name').text()).toBe('test222')
  })

  it('会话上已经定过归属时，以会话为准，不被待定值顶掉', () => {
    const chatStore = useChatSessionsStore()
    chatStore.ensureSession('sid-bound', '会话')
    chatStore.setProject('sid-bound', { projectName: 'Alpha' })

    const wrapper = mountChip('sid-bound', 'test222')

    expect(wrapper.find('.chip-name').text()).toBe('Alpha')
  })

  it('选择「不在项目中工作」后待定归属不再回来，首条消息也不会把它盖回去', async () => {
    const chatStore = useChatSessionsStore()

    const wrapper = mountChip('sid-drop', 'test222')
    const remove = wrapper
      .findAll('.menu-item')
      .find((item) => item.text().includes('不在项目中工作'))
    expect(remove).toBeDefined()

    await remove!.trigger('click')

    // null（明说不归属）而不是 undefined（还没定过）——stampSessionProject 看这个
    expect(chatStore.sessionById('sid-drop')?.project).toBeNull()
    expect(wrapper.find('.chip-name').text()).toBe('未归属项目')
  })

  it('预建出来的会话标题保持「未命名」，首条消息的自动改名才不会被顶掉', async () => {
    const chatStore = useChatSessionsStore()
    const sidebarStore = useChatSidebarStore()
    sidebarStore.addManualProject({ projectName: 'dist' })

    const wrapper = mountChip('sid-title')
    const dist = wrapper.findAll('.menu-item').find((item) => item.text().includes('dist'))
    await dist!.trigger('click')

    // useChatFlow.ensureSessionWithTitle 就是拿这个值判断「还没被命名过」
    expect(chatStore.sessionById('sid-title')?.title).toBe('AI会话')
  })
})
