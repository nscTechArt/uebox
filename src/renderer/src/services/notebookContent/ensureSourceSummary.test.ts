import { describe, expect, it, vi } from 'vitest'
import { ensureSourceSummary, type SummaryPatch } from './ensureSourceSummary'

function recorder(): { update: (updates: SummaryPatch) => Promise<void>; calls: SummaryPatch[] } {
  const calls: SummaryPatch[] = []
  return {
    calls,
    update: async (updates) => {
      calls.push(updates)
    }
  }
}

describe('ensureSourceSummary', () => {
  it('已经有能用的摘要就不再花一次钱', async () => {
    const { update, calls } = recorder()
    const condense = vi.fn()

    const outcome = await ensureSourceSummary(
      {
        id: 's1',
        content: 'x'.repeat(5000),
        summaryContent: 'y'.repeat(300),
        summaryStatus: 'completed'
      },
      update,
      condense
    )

    expect(outcome).toBe('already')
    expect(condense).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('生成成功就写回摘要，中途先把状态改成生成中', async () => {
    const { update, calls } = recorder()
    const condense = vi.fn().mockResolvedValue('压缩过的正文')

    const outcome = await ensureSourceSummary(
      { id: 's1', content: 'x'.repeat(5000) },
      update,
      condense
    )

    expect(outcome).toBe('generated')
    // 先转起来再出结果 —— 中间没有反馈的话用户会以为点了没用，然后再点一次
    expect(calls[0]).toEqual({ summaryStatus: 'processing' })
    expect(calls[1]).toEqual({ summaryContent: '压缩过的正文', summaryStatus: 'completed' })
  })

  it('压不出摘要时记成 failed，而不是抛异常打断用户切档位', async () => {
    const { update, calls } = recorder()
    const condense = vi.fn().mockResolvedValue(null)

    const outcome = await ensureSourceSummary(
      { id: 's1', content: 'x'.repeat(5000) },
      update,
      condense
    )

    expect(outcome).toBe('failed')
    expect(calls[1]).toEqual({ summaryContent: null, summaryStatus: 'failed' })
  })

  it('旧摘要太短的话当没有，重新生成', async () => {
    const { update } = recorder()
    const condense = vi.fn().mockResolvedValue('新的摘要正文')

    const outcome = await ensureSourceSummary(
      { id: 's1', content: 'x'.repeat(5000), summaryContent: '好的', summaryStatus: 'completed' },
      update,
      condense
    )

    expect(outcome).toBe('generated')
    expect(condense).toHaveBeenCalledTimes(1)
  })
})
