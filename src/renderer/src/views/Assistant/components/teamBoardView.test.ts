import { describe, expect, it } from 'vitest'

import type { TeamMail, TeamStateView } from '@core/shared/agentTeam'

import {
  mailRole,
  memberStatus,
  recentSteps,
  shortTarget,
  statusRank,
  summarizeReport
} from './teamBoardView'

describe('shortTarget', () => {
  it('工程目录下的去掉工程目录；别处留最后两段；太长中间省略', () => {
    const root = 'I:/UEBox Project/07/UEBox_Test_TASK_2'
    expect(shortTarget('I:/UEBox Project/07/UEBox_Test_TASK_2/Content', root)).toBe('Content')
    expect(
      shortTarget('I:\\UEBox Project\\07\\UEBox_Test_TASK_2\\Config\\DefaultEngine.ini', root)
    ).toBe('Config/DefaultEngine.ini')
    expect(shortTarget('D:/Other/Proj/Source/CityLife/Hero.cpp')).toBe('Source/CityLife/Hero.cpp')
    expect(shortTarget('D:/Other/Proj/Source/CityLife/Gameplay/Hero.cpp')).toBe(
      'Source/…/Gameplay/Hero.cpp'
    )
    expect(shortTarget('D:/Downloads/a/b/c.txt')).toBe('…/b/c.txt')
    expect(shortTarget('/Game/Maps/Arena')).toBe('…/Maps/Arena')
    expect(shortTarget('x'.repeat(60))).toHaveLength(39)
  })
})

describe('summarizeReport', () => {
  it('去掉开头客套话和分隔线，取第一个标题和第一句像样的话', () => {
    const report = summarizeReport(
      '任务已完成，报告全文如下（已同步任务板）。\n\n---\n# UEBox_Test_TASK_2 资产统计报告\n\n- 工程：UEBox_Test_TASK_2\n- 统计范围：`/Game`（Content 目录），共 12,661 个资产\n\n## 分类\n...'
    )
    expect(report.title).toBe('UEBox_Test_TASK_2 资产统计报告')
    expect(report.summary).toBe('工程：UEBox_Test_TASK_2')
    expect(report.body.startsWith('# UEBox')).toBe(true)
    expect(report.sections).toBe(2)
  })

  it('没有标题就拿第一句当摘要；粗体单行当标题', () => {
    expect(summarizeReport('关卡已经搭好了，灯光也调过一遍。').summary).toBe(
      '关卡已经搭好了，灯光也调过一遍。'
    )
    const bold = summarizeReport('**配置统计**\n引擎版本 5.7.4，启用了 Lumen 和 Nanite')
    expect(bold.title).toBe('配置统计')
    expect(bold.summary).toBe('引擎版本 5.7.4，启用了 Lumen 和 Nanite')
  })
})

describe('mailRole', () => {
  const mail = (from: string, to: string, text: string, replyTo?: string): TeamMail => ({
    id: 'm',
    from,
    to,
    text,
    at: 1,
    ...(replyTo ? { replyTo } : {})
  })
  it('按前缀、方向、回复、问句分', () => {
    expect(mailRole(mail('甲', 'producer', '【交活】甲 回话：\n好了'))).toBe('delivery')
    expect(mailRole(mail('甲', 'producer', '【没干完】甲 这件活停下了：403'))).toBe('stopped')
    expect(mailRole(mail('producer', '甲', '去统计资产'))).toBe('instruction')
    expect(mailRole(mail('producer', '甲', '收到', 'm1'))).toBe('reply')
    expect(mailRole(mail('甲', '乙', '你那边好了吗？'))).toBe('question')
    expect(mailRole(mail('甲', 'producer', '我先看看'))).toBe('note')
  })
})

describe('memberStatus', () => {
  const base: TeamStateView = {
    objective: '',
    verdict: null,
    verdictStale: false,
    deliveries: 0,
    members: [{ name: '甲', persona: '', tier: 'strong', readOnly: true, hiredAt: 1 }],
    board: [],
    mail: []
  }
  const live = (
    over: Partial<NonNullable<TeamStateView['live']>>
  ): NonNullable<TeamStateView['live']> => ({
    running: [],
    waiting: [],
    awaited: [],
    assignments: [],
    recent: [],
    ...over
  })

  it('正在干：只认这件活开工后的那条；还没动静就是「已接收」', () => {
    const team = {
      ...base,
      live: live({ running: ['甲'], assignments: [{ member: '甲', text: '统计', since: 10 }] })
    }
    expect(memberStatus(team, '甲', [])).toEqual({ kind: 'received', at: 10 })
    expect(
      memberStatus(team, '甲', [{ member: '甲', text: '调用 list_local_dir I:/P/Content', at: 5 }])
        .kind
    ).toBe('received')
    expect(
      memberStatus(team, '甲', [{ member: '甲', text: '调用 list_local_dir I:/P/Content', at: 12 }])
    ).toEqual({
      kind: 'tool',
      tool: 'list_local_dir',
      target: 'I:/P/Content',
      at: 12
    })
    expect(memberStatus(team, '甲', [{ member: '甲', text: '我先看看目录', at: 12 }]).kind).toBe(
      'thinking'
    )
  })

  it('交付过的闲人说交了什么；停工、受阻排最前', () => {
    const delivered = {
      ...base,
      mail: [
        {
          id: 'm',
          from: '甲',
          to: 'producer',
          at: 3,
          text: '【交活】甲 回话：\n# 资产统计报告\n共 3 个'
        }
      ]
    }
    expect(memberStatus(delivered, '甲', [])).toEqual({
      kind: 'delivered',
      title: '资产统计报告',
      at: 3
    })
    const stopped = {
      ...base,
      mail: [{ id: 'm', from: '甲', to: 'producer', at: 3, text: '【没干完】甲 这件活停下了：403' }]
    }
    const status = memberStatus(stopped, '甲', [])
    expect(status.kind).toBe('stopped')
    expect(statusRank(status)).toBe(0)
    expect(statusRank(memberStatus(base, '甲', []))).toBe(3)
  })
})

describe('recentSteps', () => {
  it('同一个工具连着调合成一行；客套话不占行；隔一分钟以上才写时间', () => {
    const steps = recentSteps(
      [
        { member: '甲', text: '调用 read_local_file A.cpp', at: 0 },
        { member: '甲', text: '调用 read_local_file B.cpp', at: 10_000 },
        { member: '乙', text: '调用 ue_save', at: 11_000 },
        { member: '甲', text: '任务已完成，报告全文如下。', at: 20_000 },
        { member: '甲', text: '数据齐了，查一下任务板', at: 30_000 },
        { member: '甲', text: '调用 team_board update', at: 120_000 }
      ],
      '甲'
    )
    expect(steps.map((s) => s.tool || s.text)).toEqual([
      'team_board',
      '数据齐了，查一下任务板',
      'read_local_file'
    ])
    expect(steps[2]!.targets).toEqual(['A.cpp', 'B.cpp'])
    expect(steps.map((s) => s.showTime)).toEqual([true, true, false])
  })
})
