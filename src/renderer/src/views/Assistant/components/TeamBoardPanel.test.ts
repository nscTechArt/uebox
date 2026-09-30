import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import TeamBoardPanel from './TeamBoardPanel.vue'
import type { TeamStateView } from '@core/shared/agentTeam'

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
    { id: 't1', title: '灰盒关卡', status: 'done', owner: '地编', evidence: 'a.png', updatedAt: 1 },
    { id: 't2', title: '波次系统', status: 'doing', owner: '玩法主程', updatedAt: 2 },
    { id: 't3', title: '存档', status: 'blocked', updatedAt: 3 }
  ],
  mail: [
    { id: 'm1', from: '试玩', to: 'producer', text: '第三波卡死', at: 1 },
    { id: 'm2', from: '试玩', to: '玩法主程', text: '塔没伤害', at: 2, deliveredAt: 3, readAt: 4 }
  ]
}

describe('TeamBoardPanel', () => {
  it('收起时一行说清：几个人、几件完成、验收结论', () => {
    const wrapper = mount(TeamBoardPanel, { props: { team } })
    const head = wrapper.find('.team-board-head')
    expect(head.attributes('aria-expanded')).toBe('false')
    expect(head.text()).toContain('2')
    expect(head.text()).toContain('1/3')
    expect(wrapper.find('.team-board-body').exists()).toBe(false)
  })

  it('展开后：进行中和卡住的排前面，完成的带证据；留言新的在上，制作人显示成中文', async () => {
    const wrapper = mount(TeamBoardPanel, { props: { team } })
    await wrapper.find('.team-board-head').trigger('click')

    const titles = wrapper.findAll('.task-title').map((node) => node.text())
    expect(titles).toEqual(['波次系统', '存档', '灰盒关卡'])
    expect(wrapper.find('.task-detail').text()).toContain('a.png')

    const members = wrapper.findAll('.members li')
    expect(members).toHaveLength(2)
    expect(members[1].attributes('title')).toBe('找 bug')

    const routes = wrapper.findAll('.mail-route').map((node) => node.text())
    expect(routes[0]).toBe('试玩 → 玩法主程')
    expect(routes[1]).not.toContain('producer')
    // 回执：读到了的显示已读，还在信箱里的照实说
    const receipts = wrapper.findAll('.mail-receipt').map((node) => node.text())
    expect(receipts).toEqual(['已读', '在信箱里'])
  })

  /** 2026-09-26：队员标了完成，证据里自己写着没做完；用户看到「完成」就信了 */
  it('验收通过之前，队员标的完成叫「自报完成」；通过之后才叫完成', async () => {
    const before = mount(TeamBoardPanel, { props: { team } })
    await before.find('.team-board-head').trigger('click')
    const doneTag = (w: typeof before): string =>
      w
        .findAll('.task')
        .find((node) => node.text().includes('灰盒关卡'))!
        .find('.task-line')
        .text()
    expect(doneTag(before)).toContain('自报完成')

    const after = mount(TeamBoardPanel, { props: { team: { ...team, verdict: 'pass' } } })
    await after.find('.team-board-head').trigger('click')
    expect(doneTag(after)).not.toContain('自报')
    expect(doneTag(after)).toContain('完成')
  })

  /** 2026-09-30 真机：第一轮标的「卡住」一直挂着，用户分不清是现在卡着还是早就过去了 */
  it('这一轮开始后没人动过的「进行中 / 卡住」灰掉标「上一轮」；卡住的显示原因、能重开', async () => {
    const wrapper = mount(TeamBoardPanel, {
      props: {
        team: {
          ...team,
          roundStartedAt: 10,
          board: [
            { id: 't2', title: '波次系统', status: 'doing', updatedAt: 20 },
            { id: 't3', title: '存档', status: 'blocked', note: '等你定死亡规则', updatedAt: 3 }
          ]
        }
      }
    })
    await wrapper.find('.team-board-head').trigger('click')
    const [fresh, old] = wrapper.findAll('.task')
    expect(fresh!.classes()).not.toContain('task--old')
    expect(old!.classes()).toContain('task--old')
    expect(old!.find('.task-when').text()).toContain('上一轮')
    expect(old!.text()).toContain('卡住原因：等你定死亡规则')

    await old!.find('.task-reopen').trigger('click')
    expect(wrapper.emitted('reopen')).toEqual([['t3']])
    expect(fresh!.find('.task-reopen').exists()).toBe(false)
  })

  it('验收之后又改过工程：不再挂红牌，改成「改动后未重验」；完成也回到「自报完成」', async () => {
    const wrapper = mount(TeamBoardPanel, {
      props: { team: { ...team, verdict: 'pass', verdictStale: true } }
    })
    expect(wrapper.find('.team-board-head').text()).toContain('改动后未重验')
    await wrapper.find('.team-board-head').trigger('click')
    expect(wrapper.text()).toContain('自报完成')
  })

  it('结束团队模式：正在跑的时候按钮不可点', async () => {
    const idle = mount(TeamBoardPanel, { props: { team } })
    await idle.find('.team-board-head').trigger('click')
    await idle.find('.team-board-foot button').trigger('click')
    expect(idle.emitted('end')).toHaveLength(1)

    const running = mount(TeamBoardPanel, { props: { team, running: true } })
    await running.find('.team-board-head').trigger('click')
    expect(running.find('.team-board-foot button').attributes('disabled')).toBeDefined()
  })
})
