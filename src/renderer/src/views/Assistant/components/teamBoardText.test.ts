import { describe, expect, it } from 'vitest'

import { inlineSegments, parseTeamMail } from './teamBoardText'

describe('parseTeamMail', () => {
  it('交活留言：拆出类别、模型、正文，写操作和快照收进附注，叮嘱模型的半句去掉', () => {
    const view = parseTeamMail(
      '【交活】阿场景（mimo-v2.6-pro） 回话：\nT1 完成。关卡已落盘。\n\n' +
        '【本次子任务的写操作】ue_set_property ×9；ue_save ×3。这些改动**已经发生**，需要的话自己回读确认，或用 ue_undo 回滚。\n' +
        '【快照】已存 1311883（阿场景：任务 T1）',
      '阿场景'
    )
    expect(view).toEqual({
      kind: 'delivery',
      model: 'mimo-v2.6-pro',
      body: 'T1 完成。关卡已落盘。',
      extras: [
        { label: 'writes', text: 'ue_set_property ×9；ue_save ×3' },
        { label: 'snapshot', text: '已存 1311883（阿场景：任务 T1）' }
      ]
    })
  })

  it('没干完：去掉「谁这件活停下了」，厂商 JSON 只留 message', () => {
    const view = parseTeamMail(
      '【没干完】阿实体 这件活停下了：403: {"message":"You\'ve reached your 5-hour usage limit.","type":"access_terminated_error"}',
      '阿实体'
    )
    expect(view.kind).toBe('stopped')
    expect(view.body).toBe("403 · You've reached your 5-hour usage limit.")
    expect(view.extras).toEqual([])
  })

  it('认不出的格式原样当正文', () => {
    expect(parseTeamMail('[中枢] 骨架已建好', '阿中枢')).toEqual({
      body: '[中枢] 骨架已建好',
      extras: []
    })
  })
})

describe('inlineSegments', () => {
  it('只认粗体和行内代码，其余原样', () => {
    expect(inlineSegments('放在 `/Game/Maps` 下，**已经发生**。<b>x</b>')).toEqual([
      { text: '放在 ', kind: 'plain' },
      { text: '/Game/Maps', kind: 'code' },
      { text: ' 下，', kind: 'plain' },
      { text: '已经发生', kind: 'bold' },
      { text: '。<b>x</b>', kind: 'plain' }
    ])
  })
})
