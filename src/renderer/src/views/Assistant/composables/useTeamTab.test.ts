import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'

import { useTeamTab } from './useTeamTab'

let nextSid = 0

function setup(): {
  sid: ReturnType<typeof ref<string>>
  hasTeam: ReturnType<typeof ref<boolean>>
  review: ReturnType<typeof ref<object | undefined>>
  browserOpen: ReturnType<typeof ref<boolean>>
  tab: ReturnType<typeof useTeamTab>
} {
  const sid = ref(`s${++nextSid}`)
  const hasTeam = ref(true)
  const review = ref<object | undefined>(undefined)
  const browserOpen = ref(false)
  const tab = useTeamTab(sid as never, hasTeam as never, review, browserOpen as never)
  return { sid, hasTeam, review, browserOpen, tab }
}

describe('useTeamTab', () => {
  it('点摘要行才出现，出现就在前面；关掉就没了', () => {
    const { tab } = setup()
    expect(tab.open.value).toBe(false)
    tab.show()
    expect(tab.open.value).toBe(true)
    expect(tab.active.value).toBe(true)
    tab.close()
    expect(tab.open.value).toBe(false)
    expect(tab.active.value).toBe(false)
  })

  it('点了网页页签就让位；网页关了、只剩它时又回到前面', () => {
    const { tab, browserOpen } = setup()
    browserOpen.value = true
    tab.show()
    tab.blur()
    expect(tab.active.value).toBe(false)
    browserOpen.value = false
    expect(tab.active.value).toBe(true)
  })

  it('新打开一次审查，审查到前面', async () => {
    const { tab, review } = setup()
    tab.show()
    review.value = { changes: [] }
    await nextTick()
    expect(tab.open.value).toBe(true)
    expect(tab.active.value).toBe(false)
  })

  it('各对话各记各的；团队模式结束页签跟着消失', async () => {
    const { tab, sid, hasTeam } = setup()
    const own = sid.value!
    tab.show()
    sid.value = 'other'
    await nextTick()
    expect(tab.open.value).toBe(false)
    sid.value = own
    await nextTick()
    expect(tab.open.value).toBe(true)
    hasTeam.value = false
    expect(tab.open.value).toBe(false)
  })

  /** 切走再切回来可能是一个新的页面实例，页签不能跟着没了 */
  it('换了页面实例，同一条对话的页签还在', () => {
    const first = setup()
    first.tab.show()
    const again = useTeamTab(first.sid as never, ref(true), ref(undefined), ref(true))
    expect(again.open.value).toBe(true)
    expect(again.active.value).toBe(true)
  })

  it('日志里点开的交付各占一个页签：点开就在前面，关掉回到团队任务', () => {
    const { tab } = setup()
    tab.show()
    tab.openReport({ id: 'j1', title: '报告一' })
    tab.openReport({ id: 'j2', title: '报告二' })
    tab.openReport({ id: 'j1', title: '报告一' })
    expect(tab.reports.value.map((r) => r.id)).toEqual(['j1', 'j2'])
    expect(tab.activeReport.value).toBe('j1')
    expect(tab.active.value).toBe(false)
    tab.closeReport('j1')
    expect(tab.activeReport.value).toBe(null)
    expect(tab.active.value).toBe(true)
  })

  it('团队任务关了交付还留着；都关完状态就清掉', () => {
    const { tab, browserOpen } = setup()
    tab.show()
    tab.openReport({ id: 'j1', title: '报告一' })
    tab.show()
    tab.close()
    expect(tab.open.value).toBe(false)
    expect(tab.activeReport.value).toBe('j1')
    browserOpen.value = true
    tab.blur()
    expect(tab.activeReport.value).toBe(null)
    tab.closeReport('j1')
    expect(tab.reports.value).toEqual([])
    tab.openReport({ id: 'j3', title: '报告三' })
    expect(tab.open.value).toBe(false)
    expect(tab.activeReport.value).toBe('j3')
  })
})
