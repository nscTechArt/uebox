import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * YouTube 的本地解析。
 *
 * 守两件事：
 *
 * 1. 没配 Key 时返回 null，由调用方显示配置提示。
 * 2. **只认 Gemini 的 Key。** youtube.com 的链接只有 Gemini 能直接读，拿别家的
 *    Key 去调，错误信息会很难懂。
 *
 * B 站不在这里：它解析出直链之后走 `urlAnalyzer`，见那边的测试。
 */

const keys: Record<string, string | undefined> = {}

vi.mock('../../ai/providerKey', () => ({
  resolveProviderApiKey: async (providerId: string) => keys[providerId]
}))
vi.mock('electron', () => ({ net: { request: vi.fn() } }))

const { analyzeYouTubeLocally, YOUTUBE_KEY_HINT } = await import('./localVideoAnalysis')

beforeEach(() => {
  vi.clearAllMocks()
  keys.google = undefined
  keys.alibaba = undefined
})

describe('YouTube 本地解析', () => {
  it('没配 Gemini Key 时返回 null，让调用方回落', async () => {
    expect(await analyzeYouTubeLocally('https://youtu.be/abc')).toBeNull()
  })

  /** 阿里云的 Key 解不了 YouTube —— 只有 Gemini 能直接读 youtube.com 链接 */
  it('只有阿里云的 Key 时仍然返回 null', async () => {
    keys.alibaba = 'sk-qwen'
    expect(await analyzeYouTubeLocally('https://youtu.be/abc')).toBeNull()
  })
})

describe('缺 Key 的提示', () => {
  /** 社区版没有登录这回事，提示里出现「登录」就是把用户引向一扇不存在的门 */
  it('写明去哪申请、配哪家，不提登录', () => {
    for (const hint of [YOUTUBE_KEY_HINT]) {
      expect(hint).not.toContain('登录')
      expect(hint).toContain('设置 → 模型')
      expect(hint).toMatch(/https:\/\//)
    }
  })
})
