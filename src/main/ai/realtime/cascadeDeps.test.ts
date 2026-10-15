/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

// 这三样一 import 就拖进 electron；这里只测「配齐没有」的判断
vi.mock('../piCompletion', () => ({ resolveBinding: vi.fn(), resolveModel: vi.fn() }))
vi.mock('../speech', () => ({ synthesizeSpeech: vi.fn() }))
vi.mock('../judge', () => ({ judge: vi.fn() }))
vi.mock('../store', () => ({ readSettings: vi.fn() }))
vi.mock('../../agent-v3/core/piModel', () => ({ thinkingOffFields: vi.fn() }))
vi.mock('../stt', () => ({
  hasSttAdapter: (baseUrl: string) => /^https?:\/\//.test(baseUrl),
  openSttSession: vi.fn(),
  resolveSttBinding: vi.fn()
}))

import { missingForCascade } from './cascadeDeps'
import { VOICE_PIPELINE_BRAIN_ROLES } from '../../../shared/aiProvider'
import { ROLE_FALLBACK } from '../types'

const providers = [
  { id: 'odd-stt', kind: 'stt', baseUrl: 'wss://example.com/asr', models: [] },
  { id: 'local-stt', kind: 'stt', baseUrl: 'http://127.0.0.1:50000/api/v1/asr', models: [] },
  { id: 'doubao-tts', kind: 'tts', baseUrl: 'https://openspeech.bytedance.com', models: [] },
  { id: 'deepseek', kind: 'chat', baseUrl: 'https://api.deepseek.com/v1', models: [] }
]

const settings = (roles: Record<string, { providerId: string; modelId: string }>): never =>
  ({ providers, roles }) as never

describe('missingForCascade', () => {
  it('识别、合成、对话模型都配了：齐了', () => {
    expect(
      missingForCascade(
        settings({
          stt: { providerId: 'local-stt', modelId: 'SenseVoiceSmall' },
          tts: { providerId: 'doubao-tts', modelId: 'seed-tts-2.0' },
          chat: { providerId: 'deepseek', modelId: 'deepseek-chat' }
        })
      )
    ).toEqual([])
  })

  it('只配了 Agent 没配对话：一样算齐', () => {
    expect(
      missingForCascade(
        settings({
          stt: { providerId: 'local-stt', modelId: 'm' },
          tts: { providerId: 'doubao-tts', modelId: 'm' },
          agent: { providerId: 'deepseek', modelId: 'm' }
        })
      )
    ).toEqual([])
  })

  it('一样都没配：三样都报', () => {
    expect(missingForCascade(settings({}))).toEqual(['stt', 'tts', 'chat'])
  })

  it('绑定指向已删掉的服务商：算没配', () => {
    expect(
      missingForCascade(
        settings({
          stt: { providerId: 'gone', modelId: 'm' },
          tts: { providerId: 'doubao-tts', modelId: 'm' },
          chat: { providerId: 'deepseek', modelId: 'm' }
        })
      )
    ).toEqual(['stt'])
  })

  it('识别绑的是认不得的地址：算没配（开通话也开不起来）', () => {
    expect(
      missingForCascade(
        settings({
          stt: { providerId: 'odd-stt', modelId: 'm' },
          tts: { providerId: 'doubao-tts', modelId: 'm' },
          chat: { providerId: 'deepseek', modelId: 'm' }
        })
      )
    ).toEqual(['stt'])
  })

  /** 设置页和主进程各拿一份「脑子从哪几个角色取」，对不上的话界面会说能通、实际打不通 */
  it('脑子的候选角色和主进程的回落链一致', () => {
    expect([...VOICE_PIPELINE_BRAIN_ROLES]).toEqual([...ROLE_FALLBACK.agent])
  })
})
