import { describe, expect, it } from 'vitest'
import { normalizeSettings } from './store'
import { PROVIDER_CATALOG } from './catalog'

/**
 * models.json 是**用户可以直接编辑**的文件，所以解析必须宽容：
 * 手改坏一处不该让整份 AI 配置读不出来。这里守的就是「坏输入进来，
 * 好配置还在」。
 */
describe('models.json 解析', () => {
  it.each([
    ['qwen-audio-3.0-tts-plus', 'longanlingxin'],
    ['qwen-audio-3.0-tts-flash', 'longanfengyue']
  ])('为 %s 使用匹配的默认音色并保留用户自定义音色', (modelId, voice) => {
    const settings = normalizeSettings({
      version: 3,
      providers: [
        {
          id: 'ali',
          kind: 'tts',
          protocol: 'openai-completions',
          baseUrl: 'wss://speech.example/inference',
          models: [{ id: modelId }, { id: modelId + '-custom', ttsVoice: 'my-voice' }]
        }
      ]
    })
    expect(settings.providers[0].models.map((model) => model.ttsVoice)).toEqual([voice, 'my-voice'])
    expect(normalizeSettings(settings).providers[0].baseUrl).toBe('wss://speech.example/inference')
  })
  it('保存独立语音合成绑定与音色，往返不丢失', () => {
    const settings = normalizeSettings({
      version: 3,
      providers: [
        {
          id: 'speech',
          kind: 'tts',
          protocol: 'openai-completions',
          baseUrl: 'https://openspeech.bytedance.com',
          models: [{ id: 'seed-tts-2.0', ttsVoice: 'custom-voice' }]
        }
      ],
      roles: { tts: { providerId: 'speech', modelId: 'seed-tts-2.0' } }
    })
    const restored = normalizeSettings(settings)
    expect(restored.roles.tts).toEqual({ providerId: 'speech', modelId: 'seed-tts-2.0' })
    expect(restored.providers[0].models[0].ttsVoice).toBe('custom-voice')
  })
  it.each([undefined, false, true, 'true'])('分辨率模式只接受显式开启并能保存 (%s)', (enabled) => {
    const settings = normalizeSettings({
      version: 3,
      providers: [
        {
          id: 'images',
          kind: 'image',
          protocol: 'openai-completions',
          baseUrl: 'https://gateway.example.com/v1',
          models: [],
          imageResolutionTiers: enabled
        }
      ]
    })
    expect(normalizeSettings(settings).providers[0].imageResolutionTiers).toBe(
      enabled === true ? true : undefined
    )
  })
  it('上传接口配置读写归一化后保留，清空后恢复默认', () => {
    const base = {
      id: 'images',
      kind: 'image',
      protocol: 'openai-completions',
      baseUrl: 'https://gateway.example.com/v1',
      models: []
    }
    const configured = normalizeSettings({
      version: 3,
      providers: [
        {
          ...base,
          imageUploadUrl: ' https://gateway.example.com/v1/uploads/images '
        }
      ]
    })
    expect(normalizeSettings(configured).providers[0].imageUploadUrl).toBe(
      'https://gateway.example.com/v1/uploads/images'
    )
    expect(
      normalizeSettings({
        version: 3,
        providers: [
          {
            ...base,
            imageUploadUrl: ' '
          }
        ]
      }).providers[0].imageUploadUrl
    ).toBeUndefined()
  })
  it('保留实时语音模型配置的音色，包括厂商后来新增的自定义音色 ID', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'doubao-realtime',
          protocol: 'openai-completions',
          baseUrl: 'https://openspeech.bytedance.com',
          models: [
            { id: '1.2.6.1', realtimeVoice: 'zh_male_yunzhou_jupiter_bigtts' },
            { id: 'future-model', realtimeVoice: 'future-voice-id' }
          ]
        }
      ]
    })

    expect(result.providers[0].models.map((model) => model.realtimeVoice)).toEqual([
      'zh_male_yunzhou_jupiter_bigtts',
      'future-voice-id'
    ])
    // 老配置没有 kind，按 Base URL 推出来
    expect(result.providers[0].kind).toBe('realtime')
  })

  /**
   * 这一位漏在白名单外面的表现很隐蔽：用户手写的档位存一次盘就没了，
   * 于是每次调用都要先白挨一个 400 才降到对的那一档。
   */
  it('保留对话模型手写的结构化输出档位，认不出的值当没填', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'my-gateway',
          kind: 'chat',
          protocol: 'openai-completions',
          baseUrl: 'https://gateway.example.com/v1',
          models: [
            { id: 'ds-v4', structuredOutputApi: 'json-object' },
            { id: 'gpt-4o', structuredOutputApi: '随便写的' },
            { id: 'plain' }
          ]
        }
      ]
    })

    expect(result.providers[0].models.map((model) => model.structuredOutputApi)).toEqual([
      'json-object',
      undefined,
      undefined
    ])
  })

  it('空白实时音色按未配置处理，不把空字符串写回 models.json', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'doubao-realtime',
          protocol: 'openai-completions',
          baseUrl: 'https://openspeech.bytedance.com',
          models: [{ id: '1.2.6.1', realtimeVoice: '   ' }]
        }
      ]
    })

    expect(result.providers[0].models[0].realtimeVoice).toBeUndefined()
  })

  it('升级旧 OpenAI Realtime 配置时推出 realtime 用途并补上 Marin 默认音色', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'openai',
          protocol: 'openai-responses',
          baseUrl: 'https://api.openai.com/v1',
          models: [{ id: 'gpt-realtime-2.1' }, { id: 'gpt-realtime', realtimeVoice: 'cedar' }]
        }
      ]
    })

    // 老配置里 realtime 模型混在通用 openai 那条下面，按模型 id 推出用途
    expect(result.providers[0].kind).toBe('realtime')
    expect(result.providers[0].models.map((model) => model.realtimeVoice)).toEqual([
      'marin',
      'cedar'
    ])
  })

  it('自建网关上手写的 supportsRealtimeVoice 能推出 realtime 用途', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'gateway',
          protocol: 'openai-completions',
          baseUrl: 'https://gateway.example/v1',
          models: [{ id: 'custom-live', supportsRealtimeVoice: true }]
        }
      ]
    })

    // v2 的能力位是推断用途的依据之一：漏了这一支，用户的实时语音配置会在
    // 升级后静默失效（角色绑定因为用途对不上被丢掉）
    expect(result.providers[0].kind).toBe('realtime')
  })

  it('保留独立的视频输入能力位', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        {
          id: 'a',
          protocol: 'openai-completions',
          baseUrl: 'https://a.example/v1',
          models: [
            { id: 'video', supportsVision: true, supportsVideo: true },
            { id: 'image-only', supportsVision: true }
          ]
        }
      ]
    })

    expect(result.providers[0].models.map((model) => model.supportsVideo)).toEqual([true, false])
  })

  it('丢掉缺少必填字段的 provider，保留其余的', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        { id: 'good', protocol: 'openai-completions', baseUrl: 'https://a.example/v1' },
        { id: '', protocol: 'openai-completions', baseUrl: 'https://b.example/v1' },
        { id: 'no-url', protocol: 'openai-completions' },
        { id: 'bad-protocol', protocol: 'carrier-pigeon', baseUrl: 'https://c.example/v1' }
      ]
    })

    expect(result.providers.map((item) => item.id)).toEqual(['good'])
  })

  /**
   * 协议白名单漏了一档，表现是用户存好的 Provider 在下次启动时**整条消失**。
   * codex 这一档是后加的，容易在别处改动时被漏掉。
   */
  it('认识 ChatGPT 订阅用的 codex 协议', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        {
          id: 'chatgpt',
          protocol: 'openai-codex-responses',
          baseUrl: 'https://chatgpt.com/backend-api/codex'
        }
      ]
    })

    expect(result.providers.map((item) => item.protocol)).toEqual(['openai-codex-responses'])
  })

  /**
   * 存量配置里 ChatGPT 订阅被记成了普通 responses。不就地修掉的话，
   * 已经登录过的用户只能靠自己想到「删掉重加」—— 界面上没有任何线索。
   */
  it.each([
    'https://chatgpt.com/backend-api/codex',
    'https://chatgpt.com/backend-api',
    'https://chatgpt.com/backend-api/codex/'
  ])('把指向 %s 的旧 responses 配置迁到 codex 协议', (baseUrl) => {
    const result = normalizeSettings({
      version: 1,
      providers: [{ id: 'chatgpt', protocol: 'openai-responses', baseUrl }]
    })

    expect(result.providers[0].protocol).toBe('openai-codex-responses')
  })

  it('别家的 responses 配置不受迁移影响', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        { id: 'openai', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }
      ]
    })

    expect(result.providers[0].protocol).toBe('openai-responses')
  })

  /**
   * models.json 里的 imageApi 是加 Provider 那一刻从目录拷进去的快照。
   * 方舟那几个曾被拷成 openai-images，而方舟没有 `/images/edits` ——
   * 不就地修掉的话，光改目录只能救新加的人，已经配好的用户每次带参考图生成
   * 都是一句没头没尾的 `Not Found`。
   */
  it.each(['doubao-seedream-5-0-260128', 'doubao-seedream-4-0-250828', 'doubao-seededit-3-0-i2i'])(
    '把存量配置里 %s 的 openai-images 修成 ark-images',
    (modelId) => {
      const result = normalizeSettings({
        version: 2,
        providers: [
          {
            id: 'ark-seedream',
            protocol: 'openai-completions',
            baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
            models: [{ id: modelId, supportsImageGeneration: true, imageApi: 'openai-images' }]
          }
        ]
      })

      expect(result.providers[0].models[0].imageApi).toBe('ark-images')
    }
  )

  /**
   * `sanitizeModel` 是**显式白名单**，逐字段重建模型对象 —— 漏一个字段的表现是
   * 「界面上选得了、存盘就没了」，而且不报任何错。3D 那两位就这么丢过一次。
   */
  it('3D 的用途与接口形状能存下来，不被白名单丢掉', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'tripo',
          protocol: 'openai-completions',
          baseUrl: 'https://openapi.tripo3d.ai/v3',
          kind: 'model3d',
          model3dApi: 'tripo',
          models: [{ id: 'v3.1-20260211' }]
        }
      ]
    })

    const provider = result.providers[0]
    expect(provider.kind).toBe('model3d')
    expect(provider.model3dApi).toBe('tripo')
  })

  it.each([
    ['https://openapi.tripo3d.ai/v3', 'tripo'],
    ['https://api.hyper3d.com/api/v2', 'rodin'],
    ['https://api.meshy.ai', 'meshy']
  ])('%s 认得出厂商，用户不用自己选接口形状', (baseUrl, expected) => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'p',
          protocol: 'openai-completions',
          baseUrl,
          kind: 'model3d',
          models: [{ id: 'some-model' }]
        }
      ]
    })

    expect(result.providers[0].model3dApi).toBe(expected)
  })

  it('认不出的 Base URL 就留空 —— 3D 没有可猜的通用形状，猜一个只会 404', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'my-gateway',
          protocol: 'openai-completions',
          baseUrl: 'https://gateway.example.com/v1',
          kind: 'model3d',
          models: [{ id: 'some-model' }]
        }
      ]
    })

    expect(result.providers[0].model3dApi).toBeUndefined()
  })

  it('3D 用途下的模型不该被标成支持工具调用 —— 它根本不是对话模型', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'tripo',
          protocol: 'openai-completions',
          baseUrl: 'https://openapi.tripo3d.ai/v3',
          // 界面上「工具」默认是勾着的，存盘时要按能力纠正回来
          kind: 'model3d',
          models: [{ id: 'v3.1-20260211', supportsTools: true }]
        }
      ]
    })

    expect(result.providers[0].models[0].supportsTools).toBe(false)
  })

  it('只修我们自己写错的那一种：手工指定的别的值不动', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'gateway',
          protocol: 'openai-completions',
          baseUrl: 'https://gateway.example.com/v1',
          models: [
            // 某个网关确实提供 /images/edits 时，用户是可以这么写的
            {
              id: 'doubao-seedream-4-0-250828',
              supportsImageGeneration: true,
              imageApi: 'gpt-images'
            },
            { id: 'gpt-image-2', supportsImageGeneration: true, imageApi: 'openai-images' }
          ]
        }
      ]
    })

    expect(result.providers[0].models.map((model) => model.imageApi)).toEqual([
      'gpt-images',
      'openai-images'
    ])
  })

  it('provider id 重复时保留先出现的', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        { id: 'dup', displayName: '先', protocol: 'openai-completions', baseUrl: 'https://a/v1' },
        { id: 'dup', displayName: '后', protocol: 'openai-completions', baseUrl: 'https://b/v1' }
      ]
    })

    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].displayName).toBe('先')
  })

  it('去掉 baseUrl 结尾的斜杠，避免拼出双斜杠', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        { id: 'a', protocol: 'openai-completions', baseUrl: 'https://api.example.com/v1///' }
      ]
    })

    expect(result.providers[0].baseUrl).toBe('https://api.example.com/v1')
  })

  it('模型默认支持工具调用，显式 false 才关闭', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        {
          id: 'a',
          protocol: 'openai-completions',
          baseUrl: 'https://a/v1',
          models: [{ id: 'm1' }, { id: 'm2', supportsTools: false }]
        }
      ]
    })

    expect(result.providers[0].models[0].supportsTools).toBe(true)
    expect(result.providers[0].models[1].supportsTools).toBe(false)
  })

  /**
   * 生图与工具调用的默认值**方向相反**，很容易在这里写反：
   * 绝大多数模型不会画图，默认开的话「生图」角色的下拉里会塞满绑上去必然
   * 报错的对话模型，而且报的是一句厂商原始错误。
   */
  it('v2 里模型上的 supportsImageGeneration 能推出 image 用途', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        {
          id: 'a',
          protocol: 'openai-completions',
          baseUrl: 'https://a/v1',
          models: [{ id: 'm1' }, { id: 'm2', supportsImageGeneration: true }]
        }
      ]
    })

    expect(result.providers[0].kind).toBe('image')
  })

  /**
   * 推理能力：目录不认识的模型默认关。错标的代价是给一个不会思考的模型发
   * 思考预算，厂商多半直接回 400 —— 比「开关不起作用」严重得多。
   */
  it('目录里没有的模型，推理默认关闭，显式 true 才打开', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'a',
          protocol: 'openai-completions',
          baseUrl: 'https://a/v1',
          models: [{ id: 'm1' }, { id: 'm2', supportsReasoning: true }]
        }
      ]
    })

    expect(result.providers[0].models[0].supportsReasoning).toBe(false)
    expect(result.providers[0].models[1].supportsReasoning).toBe(true)
  })

  /**
   * 存量配置的推理位要按目录重查一次。
   *
   * 真实故障：`supportsReasoning` 是后加的字段，v1 的 normalize 把「没写」
   * 落成 `false` 并存回了磁盘。于是每个模型都明确写着「不会推理」，
   * 和用户主动取消勾选长得一模一样，目录里的真实值再也顶不上来 ——
   * 表现是输入框里的思考档位只剩 auto / off，哪怕用的是推理模型。
   */
  describe('v1 → v2：推理位按目录重查', () => {
    // 不写死某个模型 id：目录每次同步都会变，写死的话下次同步就红
    const entry = PROVIDER_CATALOG.find((item) =>
      item.models.some((model) => model.supportsReasoning)
    )!
    const cataloged = entry.models.find((model) => model.supportsReasoning)!

    const wrap = (version: number, supportsReasoning: unknown): unknown => ({
      version,
      providers: [
        {
          id: entry.id,
          protocol: entry.protocol,
          baseUrl: entry.baseUrl || 'https://example.test/v1',
          models: [{ id: cataloged.id, supportsReasoning }]
        }
      ]
    })

    it('v1 里那个 false 是旧 normalize 写的，不是用户的选择 —— 改回目录值', () => {
      expect(normalizeSettings(wrap(1, false)).providers[0].models[0].supportsReasoning).toBe(true)
    })

    it('没写版本号的更老配置同样重查', () => {
      const raw = wrap(1, false) as Record<string, unknown>
      delete raw.version
      expect(normalizeSettings(raw).providers[0].models[0].supportsReasoning).toBe(true)
    })

    // 迁移完之后就要听用户的了，否则他永远取消不掉这个勾
    it('v2 里的 false 是用户自己取消的，保持原样', () => {
      expect(normalizeSettings(wrap(2, false)).providers[0].models[0].supportsReasoning).toBe(false)
    })

    it('v2 里没写这一位时才查目录', () => {
      expect(normalizeSettings(wrap(2, undefined)).providers[0].models[0].supportsReasoning).toBe(
        true
      )
    })

    it('迁移过的配置写回时带上新版本号，不会每次开机都迁一遍', () => {
      expect(normalizeSettings(wrap(1, false)).version).toBe(3)
    })
  })

  /**
   * 档位阶梯里的 `null` 表示「这一档不存在」，与「没写这个键」是**两回事**。
   * 当成空值滤掉的话，界面会照旧列出模型根本没有的档位。
   */
  describe('思考档位阶梯', () => {
    const parse = (thinkingLevelMap: unknown): unknown =>
      normalizeSettings({
        version: 2,
        providers: [
          {
            id: 'a',
            protocol: 'openai-completions',
            baseUrl: 'https://a/v1',
            models: [{ id: 'm1', thinkingLevelMap }]
          }
        ]
      }).providers[0].models[0].thinkingLevelMap

    it('null 原样留住，不能当空值滤掉', () => {
      expect(parse({ minimal: null, low: 'low', max: 'max' })).toEqual({
        minimal: null,
        low: 'low',
        max: 'max'
      })
    })

    // Opus 5.5：思考关不掉。这个 null 丢了，「自动」档就发 thinking: disabled，整轮 400
    it('off: null 留住；off 映射成字符串没有意义，丢掉', () => {
      expect(parse({ off: null, xhigh: 'xhigh', max: 'max' })).toEqual({
        off: null,
        xhigh: 'xhigh',
        max: 'max'
      })
      expect(parse({ off: 'none', high: 'high' })).toEqual({ high: 'high' })
    })

    it('丢掉不认识的档位名', () => {
      expect(parse({ high: 'high', turbo: 'turbo' })).toEqual({ high: 'high' })
    })

    it('丢掉空字符串和非字符串的值', () => {
      expect(parse({ high: '  ', low: 42, max: 'max' })).toEqual({ max: 'max' })
    })

    // 留一个 {} 在 models.json 里，「用户配过」和「没配过」就分不开了
    it('没有一条有效映射时归为 undefined', () => {
      expect(parse({})).toBeUndefined()
      expect(parse({ turbo: 'x' })).toBeUndefined()
      expect(parse('不是对象')).toBeUndefined()
    })
  })

  /**
   * 自适应思考这一位决定 Claude 的请求形状。丢了它 = xhigh / max 静默降级成
   * high（见 `ModelConfig.adaptiveThinking`），而且不会有任何报错。
   */
  describe('自适应思考', () => {
    const parse = (adaptiveThinking: unknown): unknown =>
      normalizeSettings({
        version: 2,
        providers: [
          {
            id: 'a',
            protocol: 'anthropic-messages',
            baseUrl: 'https://a',
            models: [{ id: 'm1', adaptiveThinking }]
          }
        ]
      }).providers[0].models[0].adaptiveThinking

    it('存过的 true 要留住', () => {
      expect(parse(true)).toBe(true)
    })

    /**
     * 只认显式的 true。归成 undefined 而不是 false 是有意的 —— false 会把
     * piModel 里「models.json → 目录 → pi 目录」那条回落链掐断，
     * 于是老用户存过的 Anthropic 永远停在预算那条路上。
     */
    it('没写 / 写别的都归为 undefined，好让运行时去目录里找', () => {
      expect(parse(undefined)).toBeUndefined()
      expect(parse(false)).toBeUndefined()
      expect(parse('true')).toBeUndefined()
    })
  })

  it('保留 image 角色的绑定 —— 漏进 MODEL_ROLES 的话它会被静默丢掉', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        {
          id: 'a',
          protocol: 'openai-completions',
          baseUrl: 'https://a/v1',
          models: [{ id: 'flux', supportsImageGeneration: true }]
        }
      ],
      roles: { image: { providerId: 'a', modelId: 'flux' } }
    })

    expect(result.roles.image).toEqual({ providerId: 'a', modelId: 'flux' })
  })

  it('将旧 fast 绑定接到合并后的轻量任务角色', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'a',
          protocol: 'openai-completions',
          baseUrl: 'https://a/v1',
          models: [{ id: 'small' }]
        }
      ],
      roles: { fast: { providerId: 'a', modelId: 'small' } }
    })

    expect(result.roles).toEqual({ summary: { providerId: 'a', modelId: 'small' } })
  })

  it('旧配置同时有 summary 和 fast 时保留 summary', () => {
    const result = normalizeSettings({
      version: 2,
      providers: [
        {
          id: 'a',
          protocol: 'openai-completions',
          baseUrl: 'https://a/v1',
          models: [{ id: 'summary' }, { id: 'fast' }]
        }
      ],
      roles: {
        summary: { providerId: 'a', modelId: 'summary' },
        fast: { providerId: 'a', modelId: 'fast' }
      }
    })

    expect(result.roles).toEqual({ summary: { providerId: 'a', modelId: 'summary' } })
  })

  /**
   * 上下文窗口是用户可以手填的，而它同时是**自动压缩的触发线**。
   * 收到 0 会让用量条除零、让压缩判定退化成「每轮都压」；
   * 收到界面清空后留下的空字符串也一样。一律当没填，回落到缺省值。
   */
  it('上下文窗口只收正整数，其余当没填', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        {
          id: 'a',
          protocol: 'openai-completions',
          baseUrl: 'https://a/v1',
          models: [
            { id: 'ok', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
            { id: 'from-input-box', contextWindow: '200000' },
            { id: 'zero', contextWindow: 0 },
            { id: 'cleared', contextWindow: '' },
            { id: 'junk', contextWindow: 'big' },
            { id: 'fractional', contextWindow: 32_768.9 }
          ]
        }
      ]
    })

    const byId = new Map(result.providers[0].models.map((model) => [model.id, model]))
    expect(byId.get('ok')?.contextWindow).toBe(1_000_000)
    expect(byId.get('ok')?.maxOutputTokens).toBe(128_000)
    expect(byId.get('from-input-box')?.contextWindow).toBe(200_000)
    expect(byId.get('zero')?.contextWindow).toBeUndefined()
    expect(byId.get('cleared')?.contextWindow).toBeUndefined()
    expect(byId.get('junk')?.contextWindow).toBeUndefined()
    expect(byId.get('fractional')?.contextWindow).toBe(32_768)
  })

  /**
   * `ApiKeyRef` 的**每一种**都要能原样活着穿过 normalize。
   *
   * 漏掉一种不是"少支持一个功能"，是**静默丢用户的配置**：
   * oauth 和 shell 就曾经漏在 else 分支里，于是账号登录明明成功了
   * （令牌已经写进加密密钥库），写回 models.json 时却被降级成 kind:'none'，
   * 界面显示「不需要密钥」，一测连接就报「密钥无效或已过期」。
   * 用户完全无从判断问题出在哪 —— 他明明看见登录成功了。
   */
  describe('四种密钥形态都要原样保留', () => {
    const wrap = (apiKey: unknown): unknown => ({
      version: 1,
      providers: [{ id: 'a', protocol: 'openai-completions', baseUrl: 'https://a/v1', apiKey }]
    })

    it.each([
      { kind: 'literal', id: 'provider:a' },
      { kind: 'env', name: 'MY_KEY' },
      { kind: 'shell', command: 'op read op://vault/openai/key' },
      { kind: 'oauth', provider: 'kimi-code', id: 'provider:a' }
    ])('$kind', (apiKey) => {
      expect(normalizeSettings(wrap(apiKey)).providers[0].apiKey).toEqual(apiKey)
    })
  })

  it('密钥引用形态不合法时退化成「不需要密钥」，而不是整条丢弃', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        {
          id: 'a',
          protocol: 'openai-completions',
          baseUrl: 'https://a/v1',
          apiKey: { kind: 'env' } // 缺 name
        }
      ]
    })

    expect(result.providers[0].apiKey).toEqual({ kind: 'none' })
  })

  // 字段不全的 oauth / shell 同样退化，不能留一个取不出密钥的半截引用
  it.each([
    { kind: 'oauth', id: 'provider:a' }, // 缺 provider，续期时不知道找谁
    { kind: 'oauth', provider: 'kimi-code' }, // 缺 id，密钥库里查不到
    { kind: 'shell' } // 缺 command
  ])('字段不全的 %o 退化成「不需要密钥」', (apiKey) => {
    const result = normalizeSettings({
      version: 1,
      providers: [{ id: 'a', protocol: 'openai-completions', baseUrl: 'https://a/v1', apiKey }]
    })
    expect(result.providers[0].apiKey).toEqual({ kind: 'none' })
  })

  it('绝不把明文密钥读进配置', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [
        {
          id: 'a',
          protocol: 'openai-completions',
          baseUrl: 'https://a/v1',
          apiKey: { kind: 'literal', id: 'provider:a', value: 'sk-leaked' }
        }
      ]
    })

    expect(JSON.stringify(result)).not.toContain('sk-leaked')
  })

  it('丢弃指向不存在 provider 的角色绑定', () => {
    const result = normalizeSettings({
      version: 1,
      providers: [{ id: 'a', protocol: 'openai-completions', baseUrl: 'https://a/v1' }],
      roles: {
        chat: { providerId: 'a', modelId: 'm1' },
        agent: { providerId: 'ghost', modelId: 'm2' }
      }
    })

    expect(result.roles.chat).toEqual({ providerId: 'a', modelId: 'm1' })
    expect(result.roles.agent).toBeUndefined()
  })

  it('输入完全不是对象时给出空配置而不是抛错', () => {
    expect(normalizeSettings(null).providers).toEqual([])
    expect(normalizeSettings('boom').providers).toEqual([])
    expect(normalizeSettings(42).roles).toEqual({})
  })
})
