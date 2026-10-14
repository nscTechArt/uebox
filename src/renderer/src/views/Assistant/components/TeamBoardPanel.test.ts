import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

import TeamBoardPanel from './TeamBoardPanel.vue'
import { setOfficeStyle } from './teamOffice/officeStyle'
import type { TeamModelCandidate, TeamStateView } from '@core/shared/agentTeam'

const now = Date.now()
const min = (n: number): number => now - n * 60_000

const team: TeamStateView = {
  objective: '统计一下当前项目的信息',
  verdict: 'pass',
  verdictAt: min(90),
  verdictStale: false,
  deliveries: 1,
  roundStartedAt: min(60),
  members: [
    { name: '资产统计员', persona: '统计资产', tier: 'strong', readOnly: true, hiredAt: 1 },
    { name: '配置统计员', persona: '统计配置', tier: 'strong', readOnly: true, hiredAt: 2 }
  ],
  board: [
    { id: 't1', title: '统计配置', owner: '配置统计员', status: 'done', updatedAt: min(30) },
    {
      id: 't2',
      title: '核对重定向器',
      owner: '资产统计员',
      status: 'blocked',
      note: '等你确认删不删',
      updatedAt: min(5)
    }
  ],
  mail: [
    { id: 'm1', from: '配置统计员', to: '资产统计员', text: '你好，我是配置统计员。', at: min(20) },
    {
      id: 'm2',
      from: 'producer',
      to: '资产统计员',
      text: '提醒：编辑器崩溃过一次，已重启。',
      at: min(3),
      readAt: min(2)
    },
    {
      id: 'm3',
      from: 'producer',
      to: '配置统计员',
      text: '提醒：编辑器崩溃过一次，已重启。',
      at: min(3)
    }
  ],
  jobs: [
    {
      id: 'j1',
      member: '配置统计员',
      brief: '统计引擎配置和插件',
      startedAt: min(50),
      endedAt: min(30),
      outcome: 'done',
      report:
        '任务已完成，报告全文如下。\n\n# 配置统计报告\n\n- 引擎 5.7\n- 插件 23 个\n\n## 模块\n\n- NeonHarbor'
    },
    { id: 'j2', member: '资产统计员', brief: '统计全部资产', startedAt: min(10) }
  ],
  events: [{ kind: 'crashed', at: min(4), detail: 'Assertion failed' }],
  live: {
    running: ['producer', '资产统计员'],
    waiting: [],
    awaited: [],
    assignments: [{ member: '资产统计员', text: '统计全部资产', since: min(10) }],
    recent: []
  }
}

/** 正文渲染器、办公室换成小壳：这里只测任务板 */
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

const labelOf = (wrapper: VueWrapper, selector: string): string[] =>
  wrapper.findAll(`${selector} [aria-label]`).map((el) => el.attributes('aria-label')!)

afterEach(() => setOfficeStyle('v2'))

describe('TeamBoardPanel 摘要行', () => {
  it('输入框上方一行：几个人、到哪一步、交回几份；点它要求在右侧面板打开', async () => {
    const wrapper = mount(TeamBoardPanel, { props: { team, running: true } })
    const head = wrapper.find('.team-board-head')
    expect(head.text()).toContain('2 人')
    expect(head.text()).toContain('1 项受阻')
    expect(head.text()).toContain('交回 1/2')
    expect(wrapper.find('.team-board-body').exists()).toBe(false)
    await head.trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('验收标签只挂这一轮、没人在跑时的结论；改过工程就是「改动后未重验」', () => {
    // 上一轮的验收：不挂
    expect(
      mount(TeamBoardPanel, { props: { team } }).find('.team-board-head').text()
    ).not.toContain('验收通过')
    const thisRound = { ...team, verdictAt: min(1), live: undefined, jobs: team.jobs!.slice(0, 1) }
    expect(
      mount(TeamBoardPanel, { props: { team: thisRound } })
        .find('.team-board-head')
        .text()
    ).toContain('验收通过')
    // 有人在跑：不挂
    expect(
      mount(TeamBoardPanel, { props: { team: thisRound, running: true } })
        .find('.team-board-head')
        .text()
    ).not.toContain('验收通过')
    expect(
      mount(TeamBoardPanel, { props: { team: { ...thisRound, verdictStale: true } } })
        .find('.team-board-head')
        .text()
    ).toContain('改动后未重验')
  })

  it('右侧面板里：打开时重读一次模型名单；正在跑的时候不能结束团队模式', async () => {
    const wrapper = docked()
    expect(wrapper.emitted('open-models')).toHaveLength(1)
    await wrapper.find('.team-board-end').trigger('click')
    expect(wrapper.emitted('end')).toHaveLength(1)
    const running = docked({ running: true })
    expect(running.find('.team-board-end').attributes('disabled')).toBeDefined()
  })
})

describe('像素画风：委托板', () => {
  it('委托条说现在：有受阻项就说受阻；进度格一件活一格', () => {
    const wrapper = docked({ running: true })
    expect(labelOf(wrapper, '.q-banner')).toContain('1 项受阻')
    expect(wrapper.findAll('.pip').map((pip) => pip.classes())).toEqual([
      ['pip', 'is-done'],
      ['pip', 'is-writing']
    ])
    // 上一轮的验收不盖章
    expect(wrapper.find('.stamp').exists()).toBe(false)
  })

  it('角色卡：气泡说此刻在干嘛；交过活的说交了什么、右上角记几份', () => {
    const wrapper = docked({ running: true })
    const cards = wrapper.findAll('.crew-card')
    expect(cards).toHaveLength(2)
    // 资产统计员名下有受阻项：要人看一眼
    expect(cards[0]!.classes()).toContain('is-alert')
    expect(cards[0]!.find('.bubble').text()).toContain('等你确认删不删')
    expect(cards[1]!.find('.bubble').text()).toContain('已交付「配置统计报告」')
    expect(cards[1]!.find('.card-loot').attributes('title')).toBe('本轮交回 1 份')
  })

  it('点角色卡：详情插在这一行下面——手上的活、往来（群发的合成一条）、名下受阻的能重开', async () => {
    const wrapper = docked({ running: true })
    await wrapper.findAll('.crew-card')[0]!.trigger('click')
    const detail = wrapper.find('.crew-detail')
    expect(detail.exists()).toBe(true)
    expect(detail.find('.detail-job').text()).toBe('统计全部资产')
    const thread = detail.findAll('.thread-item').map((item) => item.text())
    expect(thread.some((line) => line.includes('制作人 → 资产统计员、配置统计员'))).toBe(true)
    expect(thread.some((line) => line.includes('Assertion failed'))).toBe(true)
    await detail.find('.mini-task .q-btn').trigger('click')
    expect(wrapper.emitted('reopen')).toEqual([['t2']])
    await wrapper.findAll('.crew-card')[0]!.trigger('click')
    expect(wrapper.find('.crew-detail').exists()).toBe(false)
  })

  it('成果架：交回的是卷轴，在写的、停下的是空格；点卷轴就地展开，标题不重复、可看全文', async () => {
    const wrapper = docked({ running: true })
    const slots = wrapper.findAll('.slot')
    expect(slots[0]!.text()).toContain('配置统计报告')
    expect(slots[1]!.classes()).toContain('is-writing')
    await slots[0]!.trigger('click')
    const scroll = wrapper.find('.scroll-open')
    expect(scroll.find('.parch-title').text()).toBe('配置统计报告')
    const body = scroll.find('.md-stub').text()
    expect(body.startsWith('- 引擎 5.7')).toBe(true)
    expect(scroll.find('.parch-body').classes()).toContain('is-clamped')
    await scroll.findAll('.q-link')[0]!.trigger('click')
    expect(wrapper.find('.parch-body').classes()).not.toContain('is-clamped')
    await wrapper.findAll('.scroll-open .q-link')[1]!.trigger('click')
    expect(wrapper.find('.scroll-open').exists()).toBe(false)
  })

  it('任务板、日志默认收着：日志只露最新一条；交付那条点了展开那份卷轴', async () => {
    const wrapper = docked({ running: true })
    const [board, log] = wrapper.findAll('.q-fold-box')
    expect(board!.find('.board-list').exists()).toBe(false)
    expect(board!.text()).toContain('1 项受阻')
    expect(log!.findAll('.log-item')).toHaveLength(1)
    await log!.find('.fold-head').trigger('click')
    const items = wrapper.findAll('.log-item')
    expect(items.length).toBeGreaterThan(3)
    const delivered = items.find((item) => item.classes().includes('is-delivered'))!
    await delivered.find('button').trigger('click')
    expect(wrapper.find('.scroll-open .parch-title').text()).toBe('配置统计报告')
  })

  it('还没招人、还没派活：说清楚在等什么', () => {
    const empty = { ...team, members: [], jobs: [], board: [], mail: [], events: [] }
    const wrapper = docked({ team: empty, running: true })
    expect(wrapper.text()).toContain('制作人还没有招人')
    expect(wrapper.text()).toContain('制作人正在安排活')
  })
})

describe('简约画风：泳道', () => {
  it('一人一条：此刻在干嘛、时间轴上一件活一段；点一条就地展开交回的成果', async () => {
    setOfficeStyle('v1')
    const wrapper = docked({ running: true })
    expect(wrapper.find('.quest').exists()).toBe(false)
    const lanes = wrapper.findAll('.lane')
    expect(lanes).toHaveLength(2)
    expect(lanes[1]!.findAll('.track-mark')).toHaveLength(1)
    expect(lanes[0]!.findAll('.track-bar.is-writing')).toHaveLength(1)
    expect(wrapper.findAll('.track-crash').length).toBeGreaterThan(0)

    await lanes[1]!.find('.lane-row').trigger('click')
    const body = wrapper.find('.lane-body')
    expect(body.find('.report-title').text()).toBe('配置统计报告')
    expect(body.find('.md-stub').exists()).toBe(false)
    await body.find('.report-head').trigger('click')
    expect(wrapper.find('.lane-body .md-stub').text().startsWith('- 引擎 5.7')).toBe(true)
  })

  it('点时间轴上的菱形：展开这个人和那份成果', async () => {
    setOfficeStyle('v1')
    const wrapper = docked({ running: true })
    await wrapper.find('.track-mark').trigger('click')
    expect(wrapper.find('.lane.is-open .md-stub').exists()).toBe(true)
  })
})

describe('队员的模型（打开角色详情后出现）', () => {
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
      .findAll('.crew-card')
      .find((card) => card.text().includes(name))!
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
