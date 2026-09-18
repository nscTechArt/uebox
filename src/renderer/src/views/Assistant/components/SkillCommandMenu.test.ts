import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import type { AgentV3SkillSummary } from '@/api/agentV3'
import SkillCommandMenu from './SkillCommandMenu.vue'
import { BUILTIN_SLASH_COMMANDS } from './slashCommands'

const skills: AgentV3SkillSummary[] = [
  { name: 'first-skill', description: 'First', source: 'user', enabled: true },
  { name: 'second-skill', description: 'Second', source: 'plugin', enabled: true }
]

type ExposedMenu = {
  onKeydown: (event: KeyboardEvent) => boolean
}

/** 空查询时命令组全列出来，技能接在后面。跟着注册表走，加命令不用改这里 */
const COMMAND_COUNT = BUILTIN_SLASH_COMMANDS.length

describe('SkillCommandMenu', () => {
  it('支持方向键定位、回车选择和 Esc 关闭', async () => {
    // 'skill' 匹配两条技能、匹配不到命令，列表里就只有技能
    const wrapper = mount(SkillCommandMenu, {
      props: { skills, query: 'skill' }
    })
    const menu = wrapper.vm as unknown as ExposedMenu

    expect(menu.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(true)
    await nextTick()
    expect(wrapper.findAll('[role="option"]')[1].attributes('aria-selected')).toBe('true')

    expect(menu.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual(skills[1])

    expect(menu.onKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  /**
   * 命令在上、技能在下，而且**两组共用一个滚动区**。
   *
   * 各自设最大高度的话，命令组把技能组往下顶，加起来超过面板高度就被容器的
   * `overflow: hidden` 裁掉 —— 技能明明在下面，却滚不到、看不见。
   */
  it('命令组排在技能组前面，两组同在一个滚动区里', () => {
    const wrapper = mount(SkillCommandMenu, {
      props: { skills, query: '' }
    })

    const groups = wrapper.findAll('.skill-group-label').map((node) => node.text())
    expect(groups).toHaveLength(2)

    const html = wrapper.html()
    expect(html.indexOf(groups[0])).toBeLessThan(html.indexOf(groups[1]))

    // 两组都在同一个滚动容器里，谁也不会被裁掉
    const scroll = wrapper.get('.skill-menu-scroll')
    expect(scroll.findAll('.skill-command-list')).toHaveLength(2)

    // DOM 顺序：第一条选项是命令，最后一条是技能
    const options = wrapper.findAll('[role="option"]')
    expect(options[0].text()).toContain('goal')
    expect(options[options.length - 1].text()).toContain(skills[skills.length - 1].name)
  })

  /**
   * 命令和技能拉平成一条来导航：命令在前，技能在后。
   *
   * 从命令组末尾按 ↓ 要直接走进技能组，中间不能有一次「按了没反应」。
   */
  it('方向键从命令组一路走进技能组', async () => {
    const wrapper = mount(SkillCommandMenu, {
      props: { skills, query: '' }
    })
    const menu = wrapper.vm as unknown as ExposedMenu

    const options = (): ReturnType<typeof wrapper.findAll> => wrapper.findAll('[role="option"]')
    expect(options()).toHaveLength(COMMAND_COUNT + skills.length)

    // 从命令组最后一条再按一下，应该落到技能组第一条
    for (let i = 0; i < COMMAND_COUNT; i += 1) {
      menu.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    }
    await nextTick()
    expect(options()[COMMAND_COUNT].attributes('aria-selected')).toBe('true')

    menu.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual(skills[0])
  })

  /**
   * 这是原来那张截图的场景：打 `/goa`，面板只会说「未找到匹配技能」。
   * 现在它得把 `/goal` 列出来，而且回车能选中。
   */
  it('打到一半的命令能被搜到并选中', async () => {
    const wrapper = mount(SkillCommandMenu, {
      props: { skills, query: 'goa' }
    })
    const menu = wrapper.vm as unknown as ExposedMenu

    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('goal')

    expect(menu.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
    expect(wrapper.emitted('select-command')?.[0]?.[0]).toMatchObject({ name: 'goal' })
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  /**
   * 命令是本地常量，技能要走一次 IPC。让确定的东西陪着不确定的东西一起等，
   * 结果就是打 /goal 时先盯半秒「加载中」。
   */
  it('技能还在加载时，命令照样列出来、照样能选', () => {
    const wrapper = mount(SkillCommandMenu, {
      props: { skills: [], query: 'goal', loading: true }
    })
    const menu = wrapper.vm as unknown as ExposedMenu

    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    expect(menu.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
    expect(wrapper.emitted('select-command')?.[0]?.[0]).toMatchObject({ name: 'goal' })
  })

  /** 命令命中了就不该再说「没有技能」—— 面板明明给出了东西 */
  it('命令有命中时不显示空态', () => {
    const wrapper = mount(SkillCommandMenu, {
      props: { skills: [], query: 'goal' }
    })

    expect(wrapper.find('.skill-menu-state').exists()).toBe(false)
  })

  it('加载失败时给出可重试入口', async () => {
    const wrapper = mount(SkillCommandMenu, {
      props: { skills: [], query: '', error: 'offline' }
    })

    await wrapper.get('.skill-menu-retry').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('什么都没命中时不吞回车，加载中则阻止误发送', async () => {
    const wrapper = mount(SkillCommandMenu, {
      props: { skills, query: 'routing-stats' }
    })
    const menu = wrapper.vm as unknown as ExposedMenu

    expect(menu.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)

    await wrapper.setProps({ loading: true })
    expect(menu.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
  })
})
