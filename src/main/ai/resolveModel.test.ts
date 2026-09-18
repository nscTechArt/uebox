import { describe, expect, it } from 'vitest'
import { findBinding, resolveRole, resolveRoleForRequest } from './resolveModel'
import type { AiProviderSettings, ModelConfig, ProviderConfig } from './types'

/** 一个不需要密钥的本地 provider，模型清单由各用例给 */
function provider(models: ModelConfig[]): ProviderConfig {
  return {
    id: 'p',
    displayName: 'P',
    kind: 'chat',
    protocol: 'openai-completions',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: { kind: 'none' },
    models
  }
}

const seeing = { id: 'sees-images', supportsVision: true }
const blind = { id: 'text-only', supportsVision: false }

function settings(
  roles: AiProviderSettings['roles'],
  models: ModelConfig[] = [seeing, blind]
): AiProviderSettings {
  return { version: 1, providers: [provider(models)], roles }
}

const chat = { providerId: 'p', modelId: 'chat-model' }
const agent = { providerId: 'p', modelId: 'agent-model' }
const vision = { providerId: 'p', modelId: 'vision-model' }

/** 绑到一个声明了「看得懂图」的模型上 */
const bindSeeing = { providerId: 'p', modelId: seeing.id }
/** 绑到一个纯文本模型上 */
const bindBlind = { providerId: 'p', modelId: blind.id }

describe('角色判定', () => {
  it('显式角色优先于 level', () => {
    expect(resolveRole({ role: 'summary', level: 'high' })).toBe('summary')
  })

  it('只给 level 时按 low/medium/high 映射到轻量任务/chat/agent', () => {
    expect(resolveRole({ level: 'low' })).toBe('summary')
    expect(resolveRole({ level: 'medium' })).toBe('chat')
    expect(resolveRole({ level: 'high' })).toBe('agent')
  })

  it('什么都不给时默认 chat', () => {
    expect(resolveRole({})).toBe('chat')
  })

  it('resolveRole 不管图片，那一步要查用户配了什么', () => {
    expect(resolveRole({ hasImages: true, role: 'agent' })).toBe('agent')
  })
})

describe('含图请求的选型', () => {
  it('主模型自己看得懂图就不换 —— 别为一张图把整轮对话换个模型', () => {
    const s = settings({ agent: bindSeeing, vision: bindSeeing })
    expect(resolveRoleForRequest(s, { role: 'agent', hasImages: true })).toBe('agent')
  })

  it('主模型是纯文本模型时才轮到「视觉」兜底', () => {
    const s = settings({ agent: bindBlind, vision: bindSeeing })
    expect(resolveRoleForRequest(s, { role: 'agent', hasImages: true })).toBe('vision')
  })

  it('没绑「视觉」时，从其它角色里找一个看得懂图的', () => {
    // 只在「轻量任务」上绑了个文本小模型，「对话」绑的却看得懂图 ——
    // 与其报「缺视觉模型」，不如用那个。
    const s = settings({ summary: bindBlind, chat: bindSeeing })
    expect(resolveRoleForRequest(s, { level: 'low', hasImages: true })).toBe('chat')
  })

  it('一个看得懂图的都没有 → 落到 vision，由调用方报「缺视觉模型」', () => {
    const s = settings({ chat: bindBlind })
    expect(resolveRoleForRequest(s, { hasImages: true })).toBe('vision')
  })

  it('什么都没绑时报「还没配模型」，而不是「缺视觉模型」', () => {
    expect(resolveRoleForRequest(settings({}), { hasImages: true })).toBe('chat')
  })

  it('能力位未知（模型不在清单里）按看不懂图算', () => {
    // 用户手改 models.json 删掉了模型，或改坏了 id。猜它能看图的话，
    // 图会被内核换成一句占位符，模型答「我看不到图片」—— 静默降级最难查。
    const s = settings({ agent: { providerId: 'p', modelId: '不在清单里' }, vision: bindSeeing })
    expect(resolveRoleForRequest(s, { role: 'agent', hasImages: true })).toBe('vision')
  })

  it('显式点名 vision 的调用照旧用「视觉」', () => {
    // 截图分析、参考图改写这类调用本身就是「来看图的」，不带 hasImages 也算。
    const s = settings({ chat: bindSeeing, vision: bindSeeing })
    expect(resolveRoleForRequest(s, { role: 'vision' })).toBe('vision')
  })

  it('没绑「视觉」时，显式点名 vision 的调用也回落到看得懂图的模型', () => {
    const s = settings({ chat: bindSeeing })
    expect(resolveRoleForRequest(s, { role: 'vision' })).toBe('chat')
  })

  it('不带图的请求完全不受影响', () => {
    const s = settings({ chat: bindBlind, vision: bindSeeing })
    expect(resolveRoleForRequest(s, { role: 'chat' })).toBe('chat')
    expect(resolveRoleForRequest(s, { level: 'low' })).toBe('summary')
  })
})

describe('绑定回落', () => {
  it('只配了 chat 一个模型，全应用都能跑起来', () => {
    // 这是最常见的初次配置状态，不该让每个功能各弹一次「未配置」。
    const only = settings({ chat })
    expect(findBinding(only, 'chat')?.binding).toBe(chat)
    expect(findBinding(only, 'agent')?.binding).toBe(chat)
    expect(findBinding(only, 'summary')?.binding).toBe(chat)
  })

  it('优先用精确匹配的角色', () => {
    const both = settings({ chat, agent })
    expect(findBinding(both, 'agent')?.usedRole).toBe('agent')
    expect(findBinding(both, 'chat')?.usedRole).toBe('chat')
  })

  it('vision 不接受任何回落', () => {
    // 有意为之：宁可明确报「缺视觉模型」，也不要把图片喂给文本模型。
    // 「哪个角色来看这张图」是上面那一层的事，这张表只管「vision 绑了没」。
    const noVision = settings({ chat, agent })
    expect(findBinding(noVision, 'vision')).toBeNull()

    const withVision = settings({ chat, vision })
    expect(findBinding(withVision, 'vision')?.binding).toBe(vision)
  })

  it('一个都没配时返回 null', () => {
    expect(findBinding(settings({}), 'chat')).toBeNull()
  })
})
