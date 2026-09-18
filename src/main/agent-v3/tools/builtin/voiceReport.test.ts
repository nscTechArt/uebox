import { describe, expect, it, vi } from 'vitest'

import {
  MAX_FINAL_REPORT_CHARS,
  MAX_VOICE_REPORT_CHARS,
  createVoiceReportTool,
  type VoiceReport
} from './voiceReport'

function tool(report = vi.fn()): {
  /** 跑一次，返回回给模型的那段话 */
  run: (args: Record<string, unknown>) => Promise<string>
  report: ReturnType<typeof vi.fn>
} {
  const created = createVoiceReportTool({ sessionId: 's', report })
  return {
    report,
    run: async (args) => {
      const result = await created.execute('call-1', args)
      const first = result.content[0]
      return first?.type === 'text' ? first.text : ''
    }
  }
}

describe('voice_report', () => {
  it('把状态和那句话交给任务表，工具本身不等念完', async () => {
    const { run, report } = tool()

    const text = await run({ status: 'running', message: '找到工程了，正在打开。' })

    expect(report).toHaveBeenCalledWith({
      status: 'running',
      message: '找到工程了，正在打开。'
    } satisfies VoiceReport)
    expect(text).toContain('接着做')
  })

  // 做完那一次之后模型不该再报第二遍，也不该再等什么
  it('报了 done 就告诉模型到此为止', async () => {
    const { run } = tool()

    const text = await run({ status: 'done', message: '工程打开了。' })

    expect(text).toContain('到此为止')
  })

  // 中途进度有上限：报成一段话就是实况解说
  it('中途汇报超长直接拒掉，让模型改短', async () => {
    const { run, report } = tool()

    await expect(
      run({ status: 'running', message: '啊'.repeat(MAX_VOICE_REPORT_CHARS + 1) })
    ).rejects.toThrow()
    expect(report).not.toHaveBeenCalled()
  })

  /*
   * 真机上收尾压得太狠：屏幕上写的「…搬完了。下一步建议：打开 XX 确认，要我帮你打开吗？」
   * 念出来只剩前半句。用户没看屏幕，「接下来该说什么」只能从这一句里知道。
   */
  it('收尾那次给的额度宽一倍，结果和下一步能一起说完', async () => {
    const { run, report } = tool()
    const long = `搬完了：${'啊'.repeat(MAX_VOICE_REPORT_CHARS)}。下一步建议先打开确认一下，要我现在帮你打开吗？`
    expect(long.length).toBeGreaterThan(MAX_VOICE_REPORT_CHARS)
    expect(long.length).toBeLessThanOrEqual(MAX_FINAL_REPORT_CHARS)

    await run({ status: 'done', message: long })

    expect(report).toHaveBeenCalledWith({ status: 'done', message: long })
  })

  it('收尾也有天花板，超过就拒', async () => {
    const { run, report } = tool()

    await expect(
      run({ status: 'done', message: '啊'.repeat(MAX_FINAL_REPORT_CHARS + 1) })
    ).rejects.toThrow()
    expect(report).not.toHaveBeenCalled()
  })

  it('只是念一句，不进审批门', () => {
    const created = createVoiceReportTool({ sessionId: 's', report: vi.fn() })
    expect(created.unrealBox.risk).toBe('safe')
    // 加了 superRefine 之后 JSON Schema 还得生成得出来，否则整个工具注册不上
    expect(created.parameters).toMatchObject({ type: 'object' })
  })
})
