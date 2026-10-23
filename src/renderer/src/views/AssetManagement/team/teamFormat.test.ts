/**
 * 团队工程的显示规则（界面方案 2.3、2.5、2.12、4.14），拿真的中文词表跑：
 * 界面上说的话和方案逐字对得上。
 */
import { describe, expect, it } from 'vitest'
import type { TeamNotification } from '@core/shared/teamProject'
import zhCN from '@renderer/i18n/locales/zh-CN'
import enUS from '@renderer/i18n/locales/en-US'
import {
  assetNameOf,
  checkText,
  checkoutLine,
  countsText,
  dayGroupTitle,
  formatDuration,
  formatTeamTime,
  notificationText,
  ofpaGroups,
  onlineState,
  pathsLabel,
  peopleText,
  projectRelativeOf,
  waitingText,
  type Translate
} from './teamFormat'

function translator(messages: Record<string, unknown>): Translate {
  return (key, params = {}) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        messages
      )
    if (typeof value !== 'string') return key
    return value.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
  }
}

const t = translator(zhCN as unknown as Record<string, unknown>)
const en = translator(enUS as unknown as Record<string, unknown>)

// 2026-09-30 周三 12:00（本机时区）
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime()
const at = (d: number, h: number, m: number, month = 8, year = 2026): number =>
  new Date(year, month, d, h, m).getTime()

describe('time (2.5)', () => {
  it('today, yesterday, this week, earlier, other years', () => {
    expect(formatTeamTime(at(30, 10, 12), NOW, t)).toBe('10:12')
    expect(formatTeamTime(at(29, 17, 12), NOW, t)).toBe('昨天 17:12')
    expect(formatTeamTime(at(25, 17, 12), NOW, t)).toBe('周五 17:12')
    expect(formatTeamTime(at(12, 9, 0), NOW, t)).toBe('9月12日')
    expect(formatTeamTime(at(25, 9, 0, 8, 2025), NOW, t)).toBe('2025年9月25日')
  })

  it('day group titles', () => {
    expect(dayGroupTitle(at(30, 9, 0), NOW, t)).toBe('今天')
    expect(dayGroupTitle(at(29, 9, 0), NOW, t)).toBe('昨天')
    expect(dayGroupTitle(at(22, 9, 0), NOW, t)).toBe('9月22日 周二')
  })
})

describe('durations and who (2.3)', () => {
  it('takes only the largest unit', () => {
    expect(formatDuration(40 * 60_000, t)).toBe('40 分钟')
    expect(formatDuration(2 * 3_600_000 + 59 * 60_000, t)).toBe('2 小时')
    expect(formatDuration(3 * 86_400_000 + 5, t)).toBe('3 天')
    expect(formatDuration(5_000, t)).toBe('1 分钟')
  })

  it('online state has only two words', () => {
    expect(onlineState({ online: true, lastSeenAt: null }, NOW)).toBe('online')
    expect(onlineState({ online: false, lastSeenAt: null }, NOW)).toBe('notToday')
    expect(onlineState({ online: false, lastSeenAt: at(29, 23, 0) }, NOW)).toBe('notToday')
    expect(onlineState({ online: false, lastSeenAt: at(30, 9, 0) }, NOW)).toBeNull()
  })

  it('writes the check-out line like the design', () => {
    const ajie = { id: 'ajie', name: '阿杰', online: true, lastSeenAt: NOW }
    const xiaowang = { id: 'xiaowang', name: '小王', online: false, lastSeenAt: null }
    expect(checkoutLine(ajie, NOW - 2 * 3_600_000, NOW, 'chendong', t)).toBe(
      '阿杰 已签出（2 小时，在线）'
    )
    expect(checkoutLine(xiaowang, NOW - 3 * 86_400_000, NOW, 'chendong', t)).toBe(
      '小王 已签出（3 天，今天没上线）'
    )
    expect(checkoutLine(ajie, NOW - 3 * 86_400_000, NOW, 'ajie', t)).toBe('你已签出（3 天）')
    expect(checkoutLine(ajie, NOW - 60_000 * 5, NOW, null, t, false)).toBe('阿杰 已签出（5 分钟）')
    expect(checkoutLine(ajie, NOW - 2 * 3_600_000, NOW, 'x', en)).toBe(
      '阿杰 has it checked out (2 h, online)'
    )
  })
})

describe('cards and checks', () => {
  it('counts skip zeros', () => {
    expect(countsText({ added: 3, modified: 12, deleted: 1 }, t)).toBe('新增 3 · 修改 12 · 删除 1')
    expect(countsText({ added: 0, modified: 1, deleted: 0 }, t)).toBe('修改 1')
  })

  it('who a pending submit waits for', () => {
    expect(
      waitingText(
        { waitingFor: { kind: 'admins', people: [], reasons: ['freeze'], folders: [] } },
        t
      )
    ).toBe('等管理员通过')
    expect(
      waitingText(
        {
          waitingFor: {
            kind: 'people',
            people: [
              { id: 'lina', name: '李娜' },
              { id: 'wanglei', name: '王磊' }
            ],
            reasons: ['folder'],
            folders: ['Config']
          }
        },
        t
      )
    ).toBe('等 李娜、王磊 通过')
    expect(waitingText({ waitingFor: null }, t)).toBeNull()
  })

  it('check lines read like the submit window', () => {
    expect(
      checkText(
        {
          rule: 'texture-max-size',
          level: 'block',
          path: 'Content/Env/T_Rock_07_D.uasset',
          folder: 'Content',
          params: { max: 4096 },
          value: 8192,
          setBy: { id: 'wanglei', name: '王磊' }
        },
        t
      )
    ).toBe('T_Rock_07_D 是 8192，上限 4096（王磊定的）。')
    expect(
      checkText(
        {
          rule: 'name-prefix',
          level: 'warn',
          path: 'Content/Env/Rocks/Rock_07.uasset',
          folder: '',
          params: {},
          value: 'SM_',
          setBy: null
        },
        t
      )
    ).toBe('Rock_07 建议加前缀 SM_。')
    expect(
      checkText(
        {
          rule: 'no-broken-references',
          level: 'block',
          path: 'Content/Env/Rocks/Rock_12.uasset',
          folder: '',
          params: {},
          value: ['/Game/Env/Materials/M_Missing'],
          setBy: null
        },
        t
      )
    ).toBe('缺引用：M_Missing')
  })

  it('small helpers', () => {
    expect(assetNameOf('Content/Maps/L_North.umap')).toBe('L_North')
    expect(peopleText([{ id: 'c', name: '陈东' }, { group: 'QA组' }])).toBe('陈东、QA组')
    expect(pathsLabel(['Content/Characters/Hero/SK_Hero.uasset'], t)).toBe('SK_Hero')
    expect(pathsLabel(['Content/a/X.uasset', 'Content/a/Y.uasset'], t)).toBe('X 等 2 个')
    expect(projectRelativeOf('D:\\p\\Content\\Env\\SM.uasset')).toBe('Content/Env/SM.uasset')
  })

  it('Actor files under __ExternalActors__ group by map', () => {
    const groups = ofpaGroups([
      { path: 'Content/SK_Hero.uasset', ofpa: null },
      {
        path: 'Content/__ExternalActors__/Maps/L_North/1/EF/a.uasset',
        ofpa: { map: 'Content/Maps/L_North.umap' }
      },
      {
        path: 'Content/__ExternalActors__/Maps/L_North/1/GH/b.uasset',
        ofpa: { map: 'Content/Maps/L_North.umap' }
      }
    ])
    expect(groups.map((group) => [group.map, group.items.length])).toEqual([
      [null, 1],
      ['Content/Maps/L_North.umap', 2]
    ])
  })
})

describe('tray notifications (4.14)', () => {
  const base = { id: '1', project: 'xinghai', at: NOW, key: 'k' }

  it('someone asks whether you are done', () => {
    expect(
      notificationText(
        {
          ...base,
          kind: 'ask.received',
          data: {
            ask: { from: { id: 'ajie', name: '阿杰' }, paths: ['Content/Env/M_Rock_01.uasset'] }
          }
        },
        t
      )
    ).toMatchObject({ body: '阿杰 想改 M_Rock_01，你改完了吗？' })
  })

  it('answers come back three ways', () => {
    const ask = (answer: Record<string, unknown>): TeamNotification => ({
      ...base,
      kind: 'ask.answered',
      data: {
        ask: { to: { id: 'xiaowang', name: '小王' }, paths: ['Content/SK_Hero.uasset'], answer }
      }
    })
    expect(notificationText(ask({ kind: 'submitted' }), t)?.body).toBe('小王 提交了 SK_Hero。')
    expect(notificationText(ask({ kind: 'released' }), t)?.body).toBe(
      '小王 取消了签出，SK_Hero 已为你签出。'
    )
    expect(notificationText(ask({ kind: 'still-editing', eta: '1h' }), t)?.body).toBe(
      '小王：还在改，大概 1 小时。'
    )
  })

  it('take-back, approvals, freeze, deliveries', () => {
    expect(
      notificationText(
        {
          ...base,
          kind: 'checkout.taken-back',
          data: {
            by: { id: 'wanglei', name: '王磊' },
            paths: ['Content/SK_Hero.uasset'],
            reason: ''
          }
        },
        t
      )?.body
    ).toBe('王磊 收回了你对 SK_Hero 的签出。你的改动还在你电脑上。')
    expect(
      notificationText({ ...base, kind: 'submit.approved', data: { submit: { number: 1540 } } }, t)
        ?.body
    ).toBe('#1540 通过了。签出已取消。')
    expect(
      notificationText(
        {
          ...base,
          kind: 'submit.rejected',
          data: {
            submit: {
              number: 1540,
              rejected: { by: { id: 'c', name: '陈东' }, at: NOW, reason: '法线方向反了' }
            }
          }
        },
        t
      )?.body
    ).toBe('#1540 被陈东打回：法线方向反了。改动还在你电脑上，改好再提交。')
    expect(
      notificationText(
        { ...base, kind: 'freeze.started', data: { freeze: { note: 'M3 提审，周五解冻' } } },
        t
      )?.body
    ).toBe('冻结了：M3 提审，周五解冻。之后的提交要等管理员通过。')
    expect(
      notificationText(
        {
          ...base,
          kind: 'delivery.decided',
          data: { delivery: { n: 7, counts: { approved: 297, rejected: 3 } } }
        },
        t
      )?.body
    ).toBe('交付 7：通过 297，打回 3。')
    expect(notificationText({ ...base, kind: 'submit.pending', data: {} }, t)).toMatchObject({
      body: '有 1 件等你处理。',
      action: 'open-inbox'
    })
    expect(notificationText({ ...base, kind: 'reference.sent', data: {} }, t)).toBeNull()
  })
})
