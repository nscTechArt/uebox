import { describe, expect, it } from 'vitest'

import {
  MAX_SPOKEN_CHARS,
  acceptCondensed,
  clipToSentences,
  stripMarkdownForSpeech,
  summarizeByRules
} from './spokenSummary'

/** 真机上被逐字念出来的那段：星号、路径、PID 全念，还在「SampleP」处硬截 */
const REAL_REPLY = [
  '截图这条路径走不通，原因现在清楚了：',
  '',
  '**当前状态**',
  '',
  '- **UALinkDev55 编辑器在跑**（PID 5256，`I:\\UnrealAgent\\UALinkDev55`），但它作为第二个独立实例启动，**没有连回盒子**。',
  '- 盒子这一轮的连接**仍指向 SampleProject**（`I:/UE Project/SampleProject_5_5`）。',
  '- 所以我的引擎工具只够得着 SampleProject；带界面的截图（HighResShot 路径）还要求连接的编辑器窗口在前台可见，当前不满足，超时了。'
].join('\n')

describe('stripMarkdownForSpeech', () => {
  it('去掉星号、列表符号、行内代码里的路径', () => {
    const spoken = stripMarkdownForSpeech(REAL_REPLY)

    expect(spoken).not.toContain('*')
    expect(spoken).not.toContain('`')
    expect(spoken).not.toContain('I:\\')
    expect(spoken).not.toContain('- ')
    expect(spoken).toContain('UALinkDev55 编辑器在跑')
    expect(spoken).toContain('没有连回盒子')
  })

  it('标题、链接、代码块都收拾干净', () => {
    const text = '## 结果\n\n看 [文档](https://x.y/z)。\n\n```ts\nconst a = 1\n```\n完事。'
    expect(stripMarkdownForSpeech(text)).toBe('结果 看 文档。 完事。')
  })
})

describe('clipToSentences', () => {
  it('短的原样', () => {
    expect(clipToSentences('做完了。')).toBe('做完了。')
  })

  it('超长的在句子边界切，不在半个词上硬截', () => {
    const text = `${'第一句话说得比较长一些。'.repeat(8)}最后这句装不下了。`
    const clipped = clipToSentences(text)

    expect(clipped.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS)
    expect(clipped.endsWith('。')).toBe(true)
    expect(clipped).not.toContain('……')
  })

  it('一句都装不下才硬截加省略号', () => {
    const clipped = clipToSentences('啊'.repeat(300))
    expect(clipped.length).toBe(MAX_SPOKEN_CHARS + 2)
    expect(clipped.endsWith('……')).toBe(true)
  })
})

describe('summarizeByRules', () => {
  it('真机那段念出来不再有星号和路径，而且在句子边界收口', () => {
    const spoken = summarizeByRules(REAL_REPLY)

    expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 2)
    expect(spoken).not.toMatch(/[*`]/)
    expect(spoken).not.toContain('SampleP……')
  })

  /*
   * 真机（2026-09-02）：Agent 屏幕上写的是「…搬完了。下一步建议：打开 XX 确认插件和资产
   * 都正常，要我现在帮你打开吗？」，念出来只剩前半句。用户没看屏幕，「接下来该说什么」
   * 只能从这一句里知道 —— 被压掉他就只能干等着。额度要够装下结果 + 下一步。
   */
  it('结果长到贴着上限时，末尾那句「要不要我…」也还在', () => {
    const outcome = `搬完了：${'插件和角色资产都搬进新工程了，'.repeat(8)}配置里也启用了。`
    const nextStep = '下一步建议先打开工程确认一下，要我现在帮你打开吗？'
    // 贴着上限但不超：这正是上一版会把下一步整句切掉的长度区间
    expect(outcome.length + nextStep.length).toBeGreaterThan(MAX_SPOKEN_CHARS - 20)
    expect(outcome.length + nextStep.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS)

    expect(summarizeByRules(`${outcome}${nextStep}`)).toContain('要我现在帮你打开吗？')
  })
})

describe('acceptCondensed', () => {
  it('模型压出来的一句干净就用', () => {
    expect(acceptCondensed('  截图没拍成，盒子连的还是另一个工程，你把编辑器切到前台再试。 ')).toBe(
      '截图没拍成，盒子连的还是另一个工程，你把编辑器切到前台再试。'
    )
  })

  // 宁可平淡也不能念出星号
  it('空的、超长的、带 markdown 或路径的都不要', () => {
    expect(acceptCondensed('')).toBeNull()
    expect(acceptCondensed(null)).toBeNull()
    expect(acceptCondensed('啊'.repeat(MAX_SPOKEN_CHARS + 1))).toBeNull()
    expect(acceptCondensed('**做完了**')).toBeNull()
    expect(acceptCondensed('文件在 I:\\UE\\a.uproject')).toBeNull()
  })
})
