import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

import TeamBoardPanel from './TeamBoardPanel.vue'
import type { TeamModelCandidate, TeamStateView } from '@core/shared/agentTeam'

const team: TeamStateView = {
  objective: '做一个塔防游戏',
  verdict: 'fail',
  verdictStale: false,
  deliveries: 1,
  members: [
    { name: '玩法主程', persona: '写塔和波次', tier: 'strong', readOnly: false, hiredAt: 1 },
    { name: '试玩', persona: '找 bug', tier: 'fast', readOnly: true, hiredAt: 2 }
  ],
  board: [
    {
      id: 't1',
      title: '灰盒关卡',
      status: 'done',
      owner: '玩法主程',
      evidence: 'a.png',
      updatedAt: 1
    },
    { id: 't2', title: '波次系统', status: 'doing', owner: '玩法主程', updatedAt: 2 },
    { id: 't3', title: '存档', status: 'blocked', note: '等你定死亡规则', updatedAt: 3 }
  ],
  mail: [
    {
      id: 'm1',
      from: '试玩',
      to: 'producer',
      at: 1,
      text: '【交活】试玩（mimo） 回话：\n任务已完成，报告全文如下。\n\n---\n# 试玩报告\n- 第三波卡死，塔没有伤害\n\n【快照】已存 42'
    },
    { id: 'm2', from: 'producer', to: '试玩', text: '去试玩第三波。别的先不管。', at: 2 }
  ]
}

/** 名册、留言、阅读视图都用到 Markdown 渲染器；测试里换成一个只吐原文的小壳 */
const stubs = {
  MarkdownRenderer: { props: ['content'], template: '<div class="md-stub">{{ content }}</div>' },
  TeamOffice: { template: '<div class="office-stub" />' }
}

function docked(props: Record<string, unknown> = {}): VueWrapper {
  return mount(TeamBoardPanel, {
    props: { team, docked: true, ...props },
    global: { stubs },
    attachTo: document.body
  })
}

describe('TeamBoardPanel 摘要行', () => {
  it('输入框上方只有一行：几个人、几件完成、验收结论；点它要求在右侧面板打开', async () => {
    const wrapper = mount(TeamBoardPanel, { props: { team } })
    const head = wrapper.find('.team-board-head')
    expect(head.text()).toContain('2')
    expect(head.text()).toContain('1/3')
    expect(wrapper.find('.team-board-body').exists()).toBe(false)
    await head.trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('右侧面板里：打开时重读一次模型名单；正在跑的时候不能结束团队模式', async () => {
    const wrapper = docked()
    expect(wrapper.emitted('open-models')).toHaveLength(1)
    await wrapper.find('.team-board-end').trigger('click')
    expect(wrapper.emitted('end')).toHaveLength(1)
    const running = docked({ running: true })
    expect(running.find('.team-board-end').attributes('disabled')).toBeDefined()
  })

  it('验收之后又改过工程：不再挂红牌，改成「改动后未重验」', () => {
    const wrapper = docked({ team: { ...team, verdict: 'pass', verdictStale: true } })
    expect(wrapper.find('.team-board-head').text()).toContain('改动后未重验')
  })
})

describe('成员', () => {
  it('一人一行说此刻在干嘛：在跑的翻成人话、路径变短，交过活的说交了什么', () => {
    const wrapper = docked({
      team: {
        ...team,
        live: {
          running: ['玩法主程'],
          waiting: [],
          awaited: [],
          assignments: [{ member: '玩法主程', text: '写波次', since: 5 }],
          recent: []
        }
      },
      activity: [
        { member: '玩法主程', text: '调用 read_local_file D:/Proj/Source/Game/Wave.cpp', at: 6 }
      ]
    })
    const rows = wrapper.findAll('.member-main')
    expect(rows).toHaveLength(2)
    const busy = rows.find((row) => row.text().includes('玩法主程'))!
    expect(busy.find('.member-status').text()).toContain('Source/Game/Wave.cpp')
    expect(busy.find('.member-status').text()).not.toContain('read_local_file')
    const tester = rows.find((row) => row.text().includes('试玩'))!
    expect(tester.find('.member-status').text()).toContain('已交付「试玩报告」')
    expect(tester.find('.member-lock').exists()).toBe(true)
  })

  it('点一行：选中他，展开最近几步；任务和留言只看他；再点或点标签上的 × 取消', async () => {
    const wrapper = docked({
      activity: [{ member: '玩法主程', text: '调用 blueprint_compile BP_Wave', at: 6 }]
    })
    const row = wrapper.findAll('.member-main').find((r) => r.text().includes('玩法主程'))!
    await row.trigger('click')
    expect(wrapper.find('.member-detail').exists()).toBe(true)
    expect(wrapper.find('.step-action').text()).toContain('BP_Wave')
    expect(wrapper.find('.filter-chip').text()).toContain('玩法主程')
    // 存档没有负责人，选了玩法主程就看不到它
    expect(wrapper.text()).not.toContain('存档')
    // 留言里没有玩法主程的往来
    expect(wrapper.findAll('.mail')).toHaveLength(0)
    await row.trigger('click')
    expect(wrapper.find('.member-detail').exists()).toBe(false)
  })
})

describe('任务', () => {
  it('受阻的排最前、带红标签和原因、能重开；完成的折起来', async () => {
    const wrapper = docked()
    const titles = wrapper.findAll('.tasks .task-title').map((node) => node.text())
    expect(titles).toEqual(['存档', '波次系统'])
    const blocked = wrapper.findAll('.task')[0]!
    expect(blocked.text()).toContain('受阻')
    expect(blocked.find('.task-note').text()).toContain('等你定死亡规则')
    await blocked.find('.task-reopen').trigger('click')
    expect(wrapper.emitted('reopen')).toEqual([['t3']])

    const fold = wrapper.find('.done-fold')
    expect(fold.text()).toContain('已完成 1 项')
    await fold.trigger('click')
    expect(wrapper.text()).toContain('灰盒关卡')
  })

  it('验收通过之前叫「自报完成」；点开才看证据', async () => {
    const wrapper = docked()
    await wrapper.find('.done-fold').trigger('click')
    const done = wrapper.findAll('.task').find((task) => task.text().includes('灰盒关卡'))!
    expect(done.find('.task-icon').attributes('aria-label')).toBe('自报完成')
    expect(done.find('.task-evidence').exists()).toBe(false)
    await done.find('.task-line').trigger('click')
    expect(done.find('.task-evidence').text()).toContain('a.png')

    const passed = docked({ team: { ...team, verdict: 'pass' } })
    await passed.find('.done-fold').trigger('click')
    const accepted = passed.findAll('.task').find((task) => task.text().includes('灰盒关卡'))!
    expect(accepted.find('.task-icon').attributes('aria-label')).toBe('完成')
  })

  it('这一轮开始后没人动过的「进行中 / 受阻」退到背景，标「上一轮」', () => {
    const wrapper = docked({ team: { ...team, roundStartedAt: 10 } })
    const old = wrapper.findAll('.task').find((task) => task.text().includes('存档'))!
    expect(old.classes()).toContain('is-old')
    expect(old.find('.task-when').text()).toContain('上一轮')
  })
})

describe('留言', () => {
  it('交付：标签 + 报告标题 + 一句摘要，客套话和分隔线去掉；指令只露第一句', () => {
    const wrapper = docked()
    const [instruction, delivery] = wrapper.findAll('.mail')
    expect(delivery!.find('.mail-head').text()).toContain('交付')
    expect(delivery!.find('.mail-title').text()).toBe('试玩报告')
    expect(delivery!.find('.mail-summary').text()).toBe('第三波卡死，塔没有伤害')
    expect(delivery!.text()).not.toContain('报告全文如下')
    expect(instruction!.find('.mail-head').text()).toContain('指令')
    expect(instruction!.find('.mail-summary').text()).toBe('去试玩第三波。')
    // 制作人发出去还没被读到：一个小圆点
    expect(instruction!.find('.unread-dot').exists()).toBe(true)
  })

  it('点开：Markdown 全文和附注；很长的报告能开阅读视图，返回后回到原位', async () => {
    const long =
      '# 很长的报告\n' + Array.from({ length: 4 }, (_, i) => `## 第 ${i} 节\n内容`).join('\n')
    const wrapper = docked({
      team: {
        ...team,
        mail: [
          { id: 'm9', from: '试玩', to: 'producer', at: 1, text: `【交活】试玩 回话：\n${long}` }
        ]
      }
    })
    await wrapper.find('.mail-preview').trigger('click')
    expect(wrapper.find('.md-stub').text()).toContain('第 3 节')
    await wrapper.find('.mail-action.is-primary').trigger('click')
    expect(wrapper.find('.reader').exists()).toBe(true)
    await wrapper.find('.reader-back').trigger('click')
    expect(wrapper.find('.reader').exists()).toBe(false)
  })
})

describe('队员的模型（选中那一行后出现）', () => {
  const choice = (
    providerId: string,
    modelId: string,
    name: string,
    providerName: string
  ): TeamModelCandidate => ({
    key: `${providerId}/${modelId}`,
    providerId,
    modelId,
    name,
    providerName,
    vision: false
  })
  const choices = [
    choice('anthropic', 'opus', 'Claude Opus', 'Anthropic'),
    choice('deepseek', 'v4', 'DeepSeek V4', 'DeepSeek')
  ]
  const withModels: TeamStateView = {
    ...team,
    members: [
      {
        name: '搭建',
        persona: '搭关卡',
        tier: 'strong',
        model: { providerId: 'deepseek', modelId: 'v4' },
        modelReason: '活多量大',
        modelBy: 'producer',
        readOnly: false,
        hiredAt: 1
      },
      {
        name: '审核',
        persona: '查',
        tier: 'strong',
        model: { providerId: 'openai', modelId: 'gpt-6' },
        readOnly: true,
        hiredAt: 2
      }
    ]
  }

  async function open(name: string, props: Record<string, unknown>): Promise<VueWrapper> {
    const wrapper = docked({ team: withModels, ...props })
    await wrapper
      .findAll('.member-main')
      .find((row) => row.text().includes(name))!
      .trigger('click')
    return wrapper
  }

  it('只有一个模型可选时不显示模型', async () => {
    const wrapper = await open('搭建', { modelChoices: choices.slice(0, 1), modelsLoaded: true })
    expect(wrapper.find('.member-model').exists()).toBe(false)
  })

  it('多个模型：显示名字和制作人的理由；名单里没有的标成用不了；没读到设置时不说', async () => {
    const first = await open('搭建', { modelChoices: choices, modelsLoaded: true })
    const chip = first.find('.member-model')
    expect(chip.text()).toBe('DeepSeek V4')
    expect(chip.attributes('title')).toContain('活多量大')
    const second = await open('审核', { modelChoices: choices, modelsLoaded: true })
    expect(second.find('.member-model').classes()).toContain('unavailable')
    const unknown = await open('审核', { modelChoices: choices, modelsLoaded: false })
    expect(unknown.find('.member-model').classes()).not.toContain('unavailable')
  })

  it('从菜单里换模型：报给外面；选回原来的不报', async () => {
    const wrapper = await open('搭建', { modelChoices: choices, modelsLoaded: true })
    await wrapper.find('.member-model').trigger('click')
    const items = wrapper.findAllComponents({ name: 'AppMenuItem' })
    expect(items.map((item) => item.text())).toEqual(['Claude Opus', 'DeepSeek V4'])
    await items[1]!.trigger('click')
    expect(wrapper.emitted('set-model')).toBeUndefined()
    await wrapper.find('.member-model').trigger('click')
    await wrapper.findAllComponents({ name: 'AppMenuItem' })[0]!.trigger('click')
    expect(wrapper.emitted('set-model')).toEqual([
      ['搭建', { providerId: 'anthropic', modelId: 'opus' }]
    ])
  })
})
