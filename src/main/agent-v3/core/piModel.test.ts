import { describe, expect, it, vi } from 'vitest'

vi.mock('../../ai/credentials', () => ({
  resolveApiKey: vi.fn(async () => 'sk-test-key')
}))

import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import { toPiModel, toPiProvider } from './piModel'
import { PROVIDER_CATALOG } from '../../ai/catalog'
import type { ProviderConfig } from '../../ai/types'

const openaiProvider: ProviderConfig = {
  id: 'openai',
  displayName: 'OpenAI',
  kind: 'chat',
  protocol: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: { kind: 'literal', id: 'k1' },
  models: [{ id: 'gpt-5.6', displayName: 'GPT-5.6', supportsVision: true, supportsTools: true }]
}

const ollamaProvider: ProviderConfig = {
  id: 'ollama',
  displayName: 'Ollama',
  kind: 'chat',
  protocol: 'openai-completions',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: { kind: 'none' },
  models: [{ id: 'qwen3:8b' }]
}

describe('toPiModel', () => {
  it('protocol 直接映射到 pi 的 Model.api', () => {
    const model = toPiModel(openaiProvider, openaiProvider.models[0])

    expect(model.api).toBe('openai-responses')
    expect(model.provider).toBe('openai')
    expect(model.baseUrl).toBe('https://api.openai.com/v1')
    expect(model.id).toBe('gpt-5.6')
    expect(model.name).toBe('GPT-5.6')
  })

  it('supportsVision 决定 input 模态', () => {
    expect(toPiModel(openaiProvider, openaiProvider.models[0]).input).toEqual(['text', 'image'])
    expect(toPiModel(ollamaProvider, ollamaProvider.models[0]).input).toEqual(['text'])
  })

  it('没有 displayName 时回落到 id', () => {
    expect(toPiModel(ollamaProvider, ollamaProvider.models[0]).name).toBe('qwen3:8b')
  })

  it('成本一律为 0 —— 我们不跟踪厂商实时价格，不显示误导数字', () => {
    expect(toPiModel(openaiProvider, openaiProvider.models[0]).cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    })
  })

  it('模型自带的窗口优先，不再一律按 128k 压缩', () => {
    const wide: ProviderConfig = {
      ...openaiProvider,
      models: [{ id: 'gpt-5.6', contextWindow: 1_000_000, maxOutputTokens: 128_000 }]
    }
    const model = toPiModel(wide, wide.models[0])

    expect(model.contextWindow).toBe(1_000_000)
    expect(model.maxTokens).toBe(128_000)
  })

  it('models.json 没写时回查内置目录 —— 老配置不必重加就能吃到真实窗口', () => {
    // 不写死某个模型 id：目录每次同步都会变，写死的话下次同步就红。
    const entry = PROVIDER_CATALOG.find((item) =>
      item.models.some((model) => (model.contextWindow ?? 0) > 128_000)
    )!
    const cataloged = entry.models.find((model) => (model.contextWindow ?? 0) > 128_000)!

    const provider: ProviderConfig = {
      id: entry.id,
      displayName: entry.displayName,
      kind: 'chat',
      protocol: entry.protocol,
      baseUrl: entry.baseUrl || 'https://example.test/v1',
      apiKey: { kind: 'none' },
      // 目录补上窗口之前存下来的形态：只有 id，没有 contextWindow
      models: [{ id: cataloged.id }]
    }

    expect(toPiModel(provider, provider.models[0]).contextWindow).toBe(cataloged.contextWindow)
  })

  it('两处都拿不到才回落到缺省值 —— 手填的模型多半是新模型，别按 128k 压着', () => {
    const model = toPiModel(ollamaProvider, ollamaProvider.models[0])

    expect(model.contextWindow).toBe(384_000)
    expect(model.maxTokens).toBe(128_000)
  })

  /**
   * 档位阶梯只有 pi 自带目录有 —— 我们的目录（models.dev）只说「会不会推理」，
   * 不说「有哪几档」。不把这张表带上，内核只能按缺省行为列档位：
   * 真实故障是 DeepSeek V4 Flash 被列成 minimal/low/medium/high，
   * 而它实际只有 low/high/max —— 列出来的三档它没有，真有的 max 反倒没列。
   */
  describe('思考档位阶梯', () => {
    // 不写死某家模型：pi 每次升级目录都会变，写死的话下次升级就红
    const builtin = (() => {
      for (const providerId of getBuiltinProviders()) {
        const model = getBuiltinModels(providerId).find(
          (item) => item.thinkingLevelMap && Object.keys(item.thinkingLevelMap).length > 0
        )
        if (model) return { providerId, model }
      }
      throw new Error('pi 自带目录里一个带档位阶梯的模型都没有，这个测试的前提不成立')
    })()

    const provider: ProviderConfig = {
      id: builtin.providerId,
      displayName: builtin.providerId,
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      apiKey: { kind: 'none' },
      models: [{ id: builtin.model.id }]
    }

    /** 用户在设置页填的那份，故意与内置数据不同 */
    const mine = { minimal: null, low: 'fast', high: 'slow', max: 'slowest' }

    it('按 (provider, model) 从 pi 自带目录取阶梯', () => {
      expect(toPiModel(provider, provider.models[0]).thinkingLevelMap).toEqual(
        builtin.model.thinkingLevelMap
      )
    })

    /**
     * 阶梯里的 `null` 表示「这一档不存在」，与「没写」是两回事。
     * 过滤掉 null 会让内核把不存在的档位当成可用的列出来。
     */
    it('阶梯原样带过去，不过滤掉 null', () => {
      const piModel = toPiModel(provider, provider.models[0])
      const nulls = Object.entries(builtin.model.thinkingLevelMap ?? {}).filter(
        ([, value]) => value === null
      )
      for (const [level] of nulls) {
        expect(
          piModel.thinkingLevelMap?.[level as keyof typeof piModel.thinkingLevelMap]
        ).toBeNull()
      }
    })

    it('内核据此算出来的档位与 pi 自己算的一致', () => {
      expect(getSupportedThinkingLevels(toPiModel(provider, provider.models[0]))).toEqual(
        getSupportedThinkingLevels(builtin.model)
      )
    })

    // 用户自建的网关对不上 pi 的目录，没有阶梯是正常的，不能因此报错
    it('pi 目录里没有的模型不带阶梯', () => {
      expect(toPiModel(ollamaProvider, ollamaProvider.models[0]).thinkingLevelMap).toBeUndefined()
    })

    /**
     * 用户填的要盖过内置数据。这是唯一的兜底 —— pi 的目录是随包发的快照，
     * 新型号、自建网关、数据过期它都覆盖不到，而厂商没有接口能报出这个。
     */
    it('用户在设置页填的阶梯优先于 pi 自带目录', () => {
      const custom = { ...provider, models: [{ id: builtin.model.id, thinkingLevelMap: mine }] }
      // `mine` 没提 off —— off 是「思考能不能关」这个模型事实，跟随内置数据（见下一条）
      const known = builtin.model.thinkingLevelMap ?? {}
      const inheritedOff = 'off' in known ? { off: known.off } : {}

      expect(toPiModel(custom, custom.models[0]).thinkingLevelMap).toEqual({
        ...inheritedOff,
        ...mine
      })
    })

    /**
     * Opus 5.5 的目录阶梯是 `{off: null, xhigh, max}`：思考关不掉，发 disabled 一律 400。
     * 老版本存盘时把 `off` 滤掉了，存下来的只剩 `{xhigh, max}` —— 用户那份没提 off，
     * off 就得跟随目录，否则「自动」档每一轮都发 thinking: disabled。
     */
    it('用户那份没提 off 时跟随目录的 off: null', () => {
      const anthropic: ProviderConfig = {
        ...provider,
        id: 'anthropic',
        protocol: 'anthropic-messages',
        models: [{ id: 'claude-opus-5-5', thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } }]
      }

      expect(toPiModel(anthropic, anthropic.models[0]).thinkingLevelMap).toEqual({
        off: null,
        xhigh: 'xhigh',
        max: 'max'
      })
    })

    it('pi 目录里没有的模型也能靠用户填的阶梯列出档位', () => {
      const custom = { ...ollamaProvider, models: [{ id: 'qwen3:8b', thinkingLevelMap: mine }] }

      expect(toPiModel(custom, custom.models[0]).thinkingLevelMap).toEqual(mine)
    })
  })

  /**
   * `reasoning` 这一位决定输入框里的「思考程度」对这个模型有没有用：
   * pi 看到 false 会把任何档位一律夹成 off。写死成 false 的时候，
   * 那个开关对**所有**模型都是摆设，而且不会有任何提示。
   */
  describe('推理能力', () => {
    it('模型上勾了就是 true', () => {
      const thinking: ProviderConfig = {
        ...openaiProvider,
        models: [{ id: 'gpt-5.6', supportsReasoning: true }]
      }
      expect(toPiModel(thinking, thinking.models[0]).reasoning).toBe(true)
    })

    it('models.json 没写时回查内置目录 —— 老配置不必重加', () => {
      const entry = PROVIDER_CATALOG.find((item) =>
        item.models.some((model) => model.supportsReasoning)
      )!
      const cataloged = entry.models.find((model) => model.supportsReasoning)!

      const provider: ProviderConfig = {
        id: entry.id,
        displayName: entry.displayName,
        kind: 'chat',
        protocol: entry.protocol,
        baseUrl: entry.baseUrl || 'https://example.test/v1',
        apiKey: { kind: 'none' },
        models: [{ id: cataloged.id }]
      }

      expect(toPiModel(provider, provider.models[0]).reasoning).toBe(true)
    })

    // 两边猜错的代价不对称：漏标只是开关不起作用，错标是厂商直接回 400
    it('两处都拿不到时取 false，而不是猜「会思考」', () => {
      expect(toPiModel(ollamaProvider, ollamaProvider.models[0]).reasoning).toBe(false)
    })
  })

  /**
   * pi 按 baseUrl 猜「这家认不认 developer 角色」，名单里没有的一律当认。
   * 百炼就不在名单里 —— 于是 qwen3.8-max（标了会推理）的系统提示词被发成
   * `developer`，DashScope 直接 400。我们对所有 OpenAI 兼容端点钉死 `system`。
   */
  describe('系统提示词的角色', () => {
    it('OpenAI 兼容协议一律按 system 发，不让 pi 按 baseUrl 猜 developer', () => {
      for (const protocol of ['openai-completions', 'openai-responses'] as const) {
        const provider: ProviderConfig = { ...ollamaProvider, protocol }
        expect(toPiModel(provider, provider.models[0]).compat).toEqual({
          supportsDeveloperRole: false
        })
      }
    })

    it('非 OpenAI 协议不写 compat —— 那边根本没有这个概念', () => {
      const anthropic: ProviderConfig = { ...ollamaProvider, protocol: 'anthropic-messages' }
      expect(toPiModel(anthropic, anthropic.models[0]).compat).toBeUndefined()
    })
  })

  /**
   * 自适应思考决定 Claude 的**请求形状**：标了发 `output_config.effort`，
   * 不标发老式的 `budget_tokens`。
   *
   * 这一位漏了是**静默失效**：预算那条路的档位表只到 high，内核会把 xhigh 和
   * max 一起夹成 high（`clampReasoning`）。界面照样列出最高两档、选了也不报错，
   * 发出去的请求却和 high 一模一样 —— 用户唯一能观察到的就是「最高档没用」。
   */
  describe('自适应思考', () => {
    const claude = (models: ProviderConfig['models']): ProviderConfig => ({
      id: 'anthropic',
      displayName: 'Anthropic',
      kind: 'chat',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      apiKey: { kind: 'none' },
      models
    })

    /** pi 的 compat 是按协议分的联合，这一位只长在 Anthropic 那一支上 */
    const adaptiveOf = (model: ReturnType<typeof toPiModel>): boolean | undefined => {
      const compat = model.compat
      return compat && 'forceAdaptiveThinking' in compat ? compat.forceAdaptiveThinking : undefined
    }

    it('models.json 里标了就发自适应', () => {
      const provider = claude([{ id: 'claude-opus-5', adaptiveThinking: true }])
      expect(adaptiveOf(toPiModel(provider, provider.models[0]))).toBe(true)
    })

    /**
     * pi 的快照收得比我们慢。Fable 5.1 只有我们的目录里有，它的 xhigh / max
     * 全靠这条回落 —— 断了就退回预算那条路，两档白列。
     */
    it('models.json 没写时回查我们的目录 —— pi 快照还没收的新型号靠这条', () => {
      const provider = claude([{ id: 'claude-fable-5-1' }])
      const model = toPiModel(provider, provider.models[0])

      expect(adaptiveOf(model)).toBe(true)
      expect(getSupportedThinkingLevels(model)).toContain('max')
    })

    /** 4.6 那几代 pi 目录里就有，不必再往我们的目录里抄一遍 */
    it('pi 自带目录里标了的也认', () => {
      const provider = claude([{ id: 'claude-opus-4-8' }])
      expect(adaptiveOf(toPiModel(provider, provider.models[0]))).toBe(true)
    })

    /**
     * 老型号不认 `output_config.effort`，发过去是一次 400 —— 比少两档严重得多。
     * 所以默认取「否」，按官方那张支持清单逐个标，不按型号名猜。
     */
    it('清单外的老型号不发自适应', () => {
      for (const id of ['claude-opus-4-5', 'claude-haiku-4-5']) {
        const provider = claude([{ id }])
        expect(adaptiveOf(toPiModel(provider, provider.models[0])), id).toBeUndefined()
      }
    })

    // 只有 Anthropic 那条路读得懂这一位，别让它跟着别的协议流出去
    it('非 anthropic-messages 协议不带这一位，哪怕模型上标了', () => {
      const provider: ProviderConfig = {
        ...ollamaProvider,
        models: [{ id: 'qwen3:8b', adaptiveThinking: true }]
      }
      expect(adaptiveOf(toPiModel(provider, provider.models[0]))).toBeUndefined()
    })
  })

  /**
   * 「OpenAI 兼容」不等于「字段名一模一样」。
   *
   * pi 的自动探测只认它自己收录过的厂商，名单外一律按 OpenAI 原样处理 ——
   * 而这两家的差异都是**发出去才知道**的那种：讯飞的输出上限叫 max_tokens
   * （发成 max_completion_tokens 不报错，只是上限没生效），`store` 则是
   * OpenAI 独有的开关，两家文档里都没有。
   */
  describe('国产端点的字段差异', () => {
    function providerAt(baseUrl: string): ProviderConfig {
      return { ...ollamaProvider, protocol: 'openai-completions', baseUrl }
    }

    /**
     * pi 的 compat 是个联合类型（每种 api 一套字段），按 baseUrl 取到的这份
     * 一定是 openai-completions 那一支。断言单个字段时收窄一下，
     * 否则 TS 只看得到四支的交集。
     */
    function completionsCompat(
      provider: ProviderConfig
    ): { maxTokensField?: string; supportsStore?: boolean } | undefined {
      return toPiModel(provider, provider.models[0]).compat as
        | { maxTokensField?: string; supportsStore?: boolean }
        | undefined
    }

    /**
     * 讯飞已经从内置目录里下架了，但这条补丁**要留着**：这张表按 baseUrl 匹配，
     * 管的是「谁指向这个域名」，不是「我们推荐谁」。老用户的 models.json 里
     * 那条还在跑，手动配一条指过去也照样能用。
     *
     * 删了它的后果是静默的 —— 设的输出上限不生效，不报错。
     */
    it('讯飞星火用 max_tokens，并且不发 store（下架之后仍然要管）', () => {
      const provider = providerAt('https://spark-api-open.xf-yun.com/v1')

      expect(toPiModel(provider, provider.models[0]).compat).toEqual({
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
        supportsStore: false
      })
    })

    /** 深度推理那条在同一个域名下的另一个路径，同样要匹配上 */
    it('讯飞 X2 的 /x2 路径同样命中', () => {
      const provider = providerAt('https://spark-api-open.xf-yun.com/x2')

      expect(completionsCompat(provider)?.maxTokensField).toBe('max_tokens')
    })

    /**
     * 方舟新一代**要求**用 max_completion_tokens，正好是 pi 的默认，
     * 所以这一家只关掉 store —— 改了输出上限字段反而会把它弄坏。
     */
    it('火山方舟只关掉 store，不改输出上限的字段名', () => {
      const provider = providerAt('https://ark.cn-beijing.volces.com/api/v3')

      expect(toPiModel(provider, provider.models[0]).compat).toEqual({
        supportsDeveloperRole: false,
        supportsStore: false
      })
    })

    /** 方舟在别的区域有别的域名，按域名形状匹配而不是写死那一个 */
    it('方舟换个区域的域名也命中', () => {
      const provider = providerAt('https://ark.ap-southeast.volces.com/api/v3')

      expect(completionsCompat(provider)?.supportsStore).toBe(false)
    })

    /** 名单外的端点不受影响，仍然只钉死 system 角色那一条 */
    it('其余端点不受影响', () => {
      const provider = providerAt('https://api.deepseek.com/v1')

      expect(toPiModel(provider, provider.models[0]).compat).toEqual({
        supportsDeveloperRole: false
      })
    })
  })

  it('带上 provider 的自定义请求头（有些网关做 bot 检测）', () => {
    const withHeaders: ProviderConfig = {
      ...ollamaProvider,
      headers: { 'User-Agent': 'UnrealBox/1.0' }
    }
    expect(toPiModel(withHeaders, withHeaders.models[0]).headers).toEqual({
      'User-Agent': 'UnrealBox/1.0'
    })
  })
})

describe('toPiProvider', () => {
  it('模型列表逐条转换', () => {
    const provider = toPiProvider(openaiProvider)
    expect(provider.id).toBe('openai')
    expect(provider.getModels().map((m) => m.id)).toEqual(['gpt-5.6'])
  })

  it('密钥解析桥回我们自己的 credentials 模块', async () => {
    const provider = toPiProvider(openaiProvider)
    const result = await provider.auth.apiKey!.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      signal: new AbortController().signal
    })

    expect(result?.auth.apiKey).toBe('sk-test-key')
  })

  it('本地推理拿不到密钥时给占位值，不让请求因为空 key 被拒', async () => {
    const { resolveApiKey } = await import('../../ai/credentials')
    vi.mocked(resolveApiKey).mockResolvedValueOnce('')

    const provider = toPiProvider(ollamaProvider)
    const result = await provider.auth.apiKey!.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      signal: new AbortController().signal
    })

    expect(result?.auth.apiKey).toBe('not-required')
  })

  it('密钥来源描述不含密钥本身', async () => {
    const envProvider: ProviderConfig = {
      ...ollamaProvider,
      apiKey: { kind: 'env', name: 'OPENAI_API_KEY' }
    }
    const result = await toPiProvider(envProvider).auth.apiKey!.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      signal: new AbortController().signal
    })

    expect(result?.source).toBe('OPENAI_API_KEY')
    expect(JSON.stringify(result?.source)).not.toContain('sk-')
  })

  /**
   * 上面那条只看我们写进 Model 的那一位；这条看真正发出去的请求体 ——
   * 回归的是线上那个报错本身：
   * `developer is not one of ['system','assistant','user','tool','function']`
   */
  it('百炼 + 会推理的模型，发出去的系统提示词角色是 system', async () => {
    const alibaba: ProviderConfig = {
      id: 'alibaba',
      displayName: '阿里云百炼（通义千问）',
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: { kind: 'literal', id: 'k1' },
      models: [{ id: 'qwen3.8-max', supportsReasoning: true }]
    }

    const models = createModels()
    models.setProvider(toPiProvider(alibaba))

    let body: { messages: { role: string }[] } | undefined
    const capture: typeof fetch = async (_url, init) => {
      body = JSON.parse(String((init as RequestInit).body))
      throw new Error('captured')
    }

    const stream = models.streamSimple(
      models.getModel('alibaba', 'qwen3.8-max')!,
      {
        systemPrompt: '你是虚幻引擎助手',
        messages: [{ role: 'user', content: '你好', timestamp: 0 }]
      },
      { fetch: capture }
    )
    // StreamFn 契约：失败编码进事件流而不是抛出，所以这里排干即可
    for await (const _event of stream) void _event

    expect(body?.messages[0].role).toBe('system')
  })
})
