import { describe, expect, it, vi } from 'vitest'
import type {
  CatalogEntry,
  ProviderView,
  RoleBindings,
  SettingsView
} from '@core/shared/aiProvider'
import {
  draftFromCatalog,
  draftFromProvider,
  filterModelOptionsForRole,
  modelOptionLabel,
  slugify,
  uniqueProviderId,
  useAiProviders,
  type ModelOption
} from './useAiProviders'

/**
 * 这里守的是三条「错了会悄悄丢数据」的规则，而不是覆盖率：
 * 明文密钥不回流、provider id 不撞车、id 始终合法。
 */

const provider = (overrides: Partial<ProviderView> = {}): ProviderView => ({
  id: 'openai',
  displayName: 'OpenAI',
  kind: 'chat',
  protocol: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  models: [{ id: 'gpt-4o', displayName: 'GPT-4o', supportsVision: true }],
  apiKey: { kind: 'literal', hasKey: true },
  ...overrides
})

describe('draftFromProvider', () => {
  it('回显分辨率开关，允许关闭后再次保存', () => {
    const draft = draftFromProvider(provider({ kind: 'image', imageResolutionTiers: true }))
    expect(draft.imageResolutionTiers).toBe(true)
    draft.imageResolutionTiers = false
    expect(draft.imageResolutionTiers).toBe(false)
    expect(draftFromProvider(provider()).imageResolutionTiers).toBeUndefined()
  })
  it('再次编辑时回显已保存的上传接口', () => {
    const imageUploadUrl = 'https://gateway.example.com/v1/uploads/images'
    expect(draftFromProvider(provider({ kind: 'image', imageUploadUrl })).imageUploadUrl).toBe(
      imageUploadUrl
    )
  })
  it('已保存的明文密钥不会回流到草稿里', () => {
    // 主进程只回 hasKey，界面拿不到明文；输入框必须是空的，
    // 否则用户会以为框里那串星号是真密钥。
    const draft = draftFromProvider(provider())

    expect(draft.apiKeyInput).toBe('')
  })

  it('环境变量原样回显 —— 变量名不是机密，看得见才改得动', () => {
    const draft = draftFromProvider(
      provider({ apiKey: { kind: 'env', name: 'OPENAI_API_KEY', hasKey: true } })
    )

    expect(draft.apiKeyInput).toBe('OPENAI_API_KEY')
  })

  it('取密钥的命令回显时带回 ! 前缀', () => {
    // 少了前缀就会在下次保存时被当成明文密钥加密存起来
    const draft = draftFromProvider(
      provider({ apiKey: { kind: 'shell', command: 'op read op://v/openai/key', hasKey: true } })
    )

    expect(draft.apiKeyInput).toBe('!op read op://v/openai/key')
  })

  it('模型是深拷贝，改草稿不会污染已保存的那份', () => {
    const saved = provider()
    const draft = draftFromProvider(saved)
    draft.models[0].id = 'changed'

    expect(saved.models[0].id).toBe('gpt-4o')
  })
})

describe('draftFromCatalog', () => {
  it('本机推理默认不填密钥', () => {
    const entry: CatalogEntry = {
      id: 'ollama',
      displayName: 'Ollama',
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
      requiresApiKey: false,
      models: []
    }

    expect(draftFromCatalog(entry).apiKeyInput).toBe('')
  })

  it('云端厂商预填约定的环境变量名', () => {
    // 比留空更有引导性：用户至少知道该设哪个变量
    const entry: CatalogEntry = {
      id: 'openai',
      displayName: 'OpenAI',
      kind: 'chat',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      requiresApiKey: true,
      defaultEnvVar: 'OPENAI_API_KEY',
      models: []
    }

    expect(draftFromCatalog(entry).apiKeyInput).toBe('OPENAI_API_KEY')
  })
})

describe('uniqueProviderId', () => {
  it('不撞车时原样返回', () => {
    expect(uniqueProviderId('openai', [{ id: 'deepseek' }])).toBe('openai')
  })

  it('撞车时逐个递增，而不是永远只加 -2', () => {
    // 配三个 OpenAI（官方 + 两个自建网关）是真实需求。
    // 只处理「第二个」的话，第三个会撞上 openai-2 并静默覆盖它。
    const existing = [{ id: 'openai' }, { id: 'openai-2' }]

    expect(uniqueProviderId('openai', existing)).toBe('openai-3')
  })
})

/**
 * 角色绑定的存盘。
 *
 * 这一组守的是一条真实事故：只有第一个角色能存进去，之后每一个都静默失效 ——
 * 负载里带着 Vue 的响应式代理，`ipcRenderer.invoke` 在结构化克隆那一步就 reject 了，
 * 而调用方只判了 `result.ok`，异常一路飘走，界面还照常显示选中值。
 */
describe('setRole', () => {
  const settingsView = (roles: RoleBindings): SettingsView => ({
    providers: [provider({ id: 'deepseek', displayName: 'DeepSeek' })],
    roles,
    path: 'C:\\models.json',
    encryptionAvailable: true,
    configured: true
  })

  /** 装一个和真 IPC 一样挑剔的 setRoles：负载克隆不了就 reject */
  function mockApi(setRoles: (roles: RoleBindings) => Promise<unknown>): RoleBindings[] {
    const seen: RoleBindings[] = []
    ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
      aiProvider: {
        getSettings: vi.fn(async () => settingsView({})),
        catalog: vi.fn(async () => []),
        setRoles: vi.fn(async (roles: RoleBindings) => {
          // 结构化克隆：代理对象过不去，和 Electron 的表现一致
          seen.push(structuredClone(roles))
          return setRoles(roles)
        })
      }
    }
    return seen
  }

  it('第二个角色也存得进去 —— 负载里不能夹带响应式代理', async () => {
    let stored: RoleBindings = {}
    const seen = mockApi(async (roles) => {
      stored = roles
      return { ok: true, data: settingsView(roles) }
    })

    const state = useAiProviders()
    await state.load()

    const first = await state.setRole('chat', { providerId: 'deepseek', modelId: 'v4-flash' })
    // 第二次的负载里带着上一次存盘回来的绑定 —— 事故就发生在这一步
    const second = await state.setRole('agent', { providerId: 'deepseek', modelId: 'v4-pro' })

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })
    expect(seen[1]).toEqual({
      chat: { providerId: 'deepseek', modelId: 'v4-flash' },
      agent: { providerId: 'deepseek', modelId: 'v4-pro' }
    })
    // 先配的那个不能被后配的挤掉
    expect(stored.chat).toEqual({ providerId: 'deepseek', modelId: 'v4-flash' })
  })

  it('清空一个角色不会连带清掉别的', async () => {
    mockApi(async (roles) => ({ ok: true, data: settingsView(roles) }))

    const state = useAiProviders()
    await state.load()
    await state.setRole('chat', { providerId: 'deepseek', modelId: 'v4-flash' })
    await state.setRole('agent', { providerId: 'deepseek', modelId: 'v4-pro' })
    await state.setRole('agent', null)

    expect(state.roles.value).toEqual({ chat: { providerId: 'deepseek', modelId: 'v4-flash' } })
  })

  it('主进程报错要回给调用方，不能吞掉', async () => {
    mockApi(async () => ({ ok: false, error: '磁盘只读' }))

    const state = useAiProviders()
    await state.load()

    expect(await state.setRole('chat', { providerId: 'deepseek', modelId: 'v4-flash' })).toEqual({
      ok: false,
      error: '磁盘只读'
    })
  })

  /*
   * 存第一条对话 Provider 时会顺带自动绑「对话」角色。那一步失败过去是被**吞掉**的：
   * `setRole` 自己 catch、以返回值报错，而调用方 `await` 完不看返回值就 `return { ok: true }`。
   *
   * 后果正是这段自动绑定本来要消灭的那个状态：界面报「保存成功」，对话角色其实还空着，
   * 用户回到助手页发不出消息，而没有任何地方说这一步没做成。
   */
  it('自动绑定「对话」角色失败时，保存要如实报失败', async () => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
      aiProvider: {
        // roles 是空的 → 存完会去自动绑「对话」
        getSettings: vi.fn(async () => settingsView({})),
        catalog: vi.fn(async () => []),
        saveProvider: vi.fn(async () => ({ ok: true, data: settingsView({}) })),
        // 配置目录只读：绑定这一步失败
        setRoles: vi.fn(async () => ({ ok: false, error: '磁盘只读' }))
      }
    }

    const state = useAiProviders()
    await state.load()
    state.selectProvider('deepseek')

    expect(await state.save()).toEqual({ ok: false, error: '磁盘只读' })
  })

  it('IPC 直接 reject 也要变成一条错误，而不是未处理的异常', async () => {
    // invoke 是以 reject 失败的，不是返回 { ok:false }——这条曾经让整次保存无声无息
    mockApi(async () => {
      throw new Error('IPC 断了')
    })

    const state = useAiProviders()
    await state.load()
    const result = await state.setRole('chat', { providerId: 'deepseek', modelId: 'v4-flash' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('IPC 断了')
  })
})

describe('save', () => {
  it('勾选视频能力后保存负载不会丢掉 supportsVideo', async () => {
    const saved = provider({ id: 'alibaba', displayName: '阿里云百炼' })
    const saveProvider = vi.fn(async (draft) => ({
      ok: true,
      data: {
        providers: [
          {
            ...saved,
            models: draft.models,
            apiKey: { kind: 'literal', hasKey: true }
          }
        ],
        roles: {},
        path: 'C:\\models.json',
        encryptionAvailable: true,
        configured: true
      }
    }))
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
      aiProvider: {
        getSettings: vi.fn(async () => ({
          providers: [saved],
          roles: {},
          path: 'C:\\models.json',
          encryptionAvailable: true,
          configured: true
        })),
        catalog: vi.fn(async () => []),
        saveProvider,
        /*
         * 存第一条对话 Provider 会顺带自动绑「对话」角色，所以这条路会走到
         * setRoles。桩必须有它 —— 缺了的话 save() 现在会如实回报绑定失败
         * （以前是把失败吞掉照报成功，那正是被修掉的毛病）。
         */
        setRoles: vi.fn(async (roles) => ({ ok: true, data: { roles } }))
      }
    }

    const state = useAiProviders()
    await state.load()
    state.selectProvider('alibaba')
    state.draft.value!.models[0].supportsVideo = true

    expect(await state.save()).toEqual({ ok: true })
    expect(saveProvider.mock.calls[0][0].models[0].supportsVideo).toBe(true)
    expect(state.draft.value!.models[0].supportsVideo).toBe(true)
  })
})

/**
 * 「改过没有」。
 *
 * 这个标志唯一的用途就是拦住「改到一半切走」，所以它错在哪一边都不行：
 * 漏报（改了却说没改）等于没拦，用户静默丢改动；误报（没改却说改了）
 * 会让每一次正常切换都弹一个框，两三次之后用户就学会闭着眼点「丢弃」了。
 */
describe('isDirty', () => {
  const saved = provider({ id: 'deepseek', displayName: 'DeepSeek' })

  function mount(): ReturnType<typeof useAiProviders> {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
      aiProvider: {
        getSettings: vi.fn(async () => ({
          providers: [saved],
          roles: {},
          path: 'C:\\models.json',
          encryptionAvailable: true,
          configured: true
        })),
        catalog: vi.fn(async () => [])
      }
    }
    return useAiProviders()
  }

  it('没进入编辑时不算改过', () => {
    expect(mount().isDirty.value).toBe(false)
  })

  it('刚选中一个 Provider、还没动它，不算改过', async () => {
    const state = mount()
    await state.load()
    state.selectProvider('deepseek')

    expect(state.isDirty.value).toBe(false)
  })

  it('改了 Base URL 就算改过', async () => {
    const state = mount()
    await state.load()
    state.selectProvider('deepseek')
    state.draft.value!.baseUrl = 'https://gateway.local/v1'

    expect(state.isDirty.value).toBe(true)
  })

  /** 模型清单是嵌套的，浅比较会漏掉这一整类改动 */
  it('只改了某个模型的能力位也算改过', async () => {
    const state = mount()
    await state.load()
    state.selectProvider('deepseek')
    state.draft.value!.models[0].supportsTools = true

    expect(state.isDirty.value).toBe(true)
  })

  it('从目录里新建一条、还没填东西，不算改过', async () => {
    const state = mount()
    await state.load()
    state.startCreate({
      id: 'openai',
      displayName: 'OpenAI',
      kind: 'chat',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      models: [],
      requiresApiKey: true
    } as CatalogEntry)

    expect(state.isDirty.value).toBe(false)
  })

  it('切回原来那条 Provider，改动标志跟着清掉', async () => {
    const state = mount()
    await state.load()
    state.selectProvider('deepseek')
    state.draft.value!.baseUrl = 'https://gateway.local/v1'
    state.selectProvider('deepseek')

    expect(state.isDirty.value).toBe(false)
  })
})

describe('filterModelOptionsForRole', () => {
  const option = (
    value: string,
    kind: ModelOption['kind'] = 'chat',
    overrides: Partial<ModelOption> = {}
  ): ModelOption => ({ value, label: value, kind, supportsVision: false, ...overrides })

  const chatModel = option('openai::gpt-4o')
  const visionModel = option('openai::gpt-4o-vision', 'chat', { supportsVision: true })
  const embedModel = option('jina::jina-embeddings-v3', 'embedding')
  const imageModel = option('openai-image::gpt-image-1', 'image')
  const videoModel = option('ark-seedance::doubao-seedance-2-5-260628', 'video')
  const model3d = option('hyper3d::Gen-2', 'model3d')
  const realtimeModel = option('openai-realtime::gpt-realtime-2.1', 'realtime')
  const all = [chatModel, visionModel, embedModel, imageModel, videoModel, model3d, realtimeModel]

  it.each([
    ['image', () => imageModel],
    ['video', () => videoModel],
    ['model3d', () => model3d],
    ['embedding', () => embedModel],
    ['realtime', () => realtimeModel]
  ] as const)('%s 角色只列用途对得上的 Provider 下的模型', (role, expected) => {
    expect(filterModelOptionsForRole(all, role)).toEqual([expected()])
  })

  /**
   * 反方向同样重要，而且以前要为每一种模态各写一遍。
   *
   * `gpt-image-1`、`Gen-2`、`doubao-seedance-2-5-260628` 这些 id 看着都像普通
   * 对话模型，绑给「对话」之后用户拿到的是一句厂商原始报错，而不是「它不能聊天」。
   * 现在一条规则就全挡住了 —— 用途对不上就不列。
   */
  it('非对话用途的模型一个都不出现在对话类角色的下拉里', () => {
    for (const role of ['chat', 'agent', 'summary'] as const) {
      expect(filterModelOptionsForRole(all, role)).toEqual([chatModel, visionModel])
    }
  })

  it('视觉是唯一还看模型能力位的角色 —— 同一个对话 Provider 下逐模型不同', () => {
    expect(filterModelOptionsForRole(all, 'vision')).toEqual([visionModel])
  })

  it('实时语音角色只列显式支持双向语音的模型', () => {
    expect(filterModelOptionsForRole(all, 'realtime')).toEqual([realtimeModel])
  })

  it('实时语音模型不混进普通对话角色', () => {
    for (const role of ['chat', 'agent', 'summary'] as const) {
      expect(filterModelOptionsForRole(all, role)).not.toContain(realtimeModel)
    }
  })

  /**
   * 特征词兜底整个不存在了 —— 这条以前守的是「id 认不出来的模型也要能选中」。
   *
   * 现在候选只看 Provider 的用途，模型 id 长什么样根本不参与判断：
   * Voyage 的模型名不带 embed、Rodin 管它叫 Gen-2、方舟叫
   * doubao-seedance-2-5-260628 —— 一个都不用猜了。
   */
  it('模型 id 完全不参与判断，认不出名字的照样能选中', () => {
    const opaque = option('acme::retrieval-2', 'embedding')

    expect(filterModelOptionsForRole([opaque], 'embedding')).toEqual([opaque])
    expect(filterModelOptionsForRole([opaque], 'chat')).toEqual([])
  })
})

/**
 * 角色下拉里那一行的文字。
 *
 * 这一栏的全部意义就是让人分清七个角色各自绑的是哪个模型。直接拼
 * `厂商 / 模型` 会把厂商名写两遍（DeepSeek 的模型显示名本来就以 DeepSeek
 * 开头），下拉框放不下就截成「DeepSeek / DeepSeek V4 F…」—— 三个不同的
 * 模型在界面上长得一模一样，这一栏就白做了。
 */
describe('modelOptionLabel', () => {
  it('模型名已经以厂商名开头时，不再加一遍前缀', () => {
    expect(modelOptionLabel('DeepSeek', 'DeepSeek V4 Flash')).toBe('DeepSeek V4 Flash')
  })

  it('大小写不一致也算开头，厂商名的写法本来就不统一', () => {
    expect(modelOptionLabel('DeepSeek', 'deepseek-v4-pro')).toBe('deepseek-v4-pro')
  })

  it('模型名跟厂商名没关系时，模型在前、厂商在后', () => {
    expect(modelOptionLabel('OpenAI GPT Image', 'GPT Image 2')).toBe(
      'GPT Image 2 · OpenAI GPT Image'
    )
    expect(modelOptionLabel('我的网关', 'qwen3:8b')).toBe('qwen3:8b · 我的网关')
    expect(modelOptionLabel('阿里云百炼（通义千问）', 'Qwen3-Coder-Plus')).toBe(
      'Qwen3-Coder-Plus · 阿里云百炼（通义千问）'
    )
  })

  /**
   * 只砍「开头」，不做更聪明的公共词去重：那种规则在别的厂商身上会削出
   * 莫名其妙的名字，而这里宁可偶尔啰嗦，也不能显示一个用户在厂商控制台里
   * 搜不到的名字。
   */
  it('厂商名出现在模型名中间不算，原样保留', () => {
    expect(modelOptionLabel('Qwen', 'tongyi-Qwen-max')).toBe('tongyi-Qwen-max · Qwen')
  })

  it('哪一边空了都不留下一个孤零零的斜杠', () => {
    expect(modelOptionLabel('', 'gpt-4o')).toBe('gpt-4o')
    expect(modelOptionLabel('OpenAI', '')).toBe('OpenAI')
  })
})

describe('slugify', () => {
  it('中文名也能得到一个合法 id', () => {
    // id 同时是密钥库的键，不能出现非 ASCII 或空格
    expect(slugify('我的网关')).toBe('provider')
    expect(slugify('My Gateway')).toBe('my-gateway')
    expect(slugify('  OpenAI (Azure)  ')).toBe('openai-azure')
  })
})

/**
 * 「测试通过」和「能用」之间隔着一个用户不知道存在的下拉框。
 *
 * 红灯用例：新用户填完密钥、点「测试连接」看到绿勾、回到助手页 —— 发不出消息。
 * 因为「对话」角色还没绑，而界面上没有任何地方说这一步还没做。
 */
describe('保存第一个对话 Provider 时自动绑「对话」角色', () => {
  function harness(roles: RoleBindings): {
    state: ReturnType<typeof useAiProviders>
    setRoles: ReturnType<typeof vi.fn>
  } {
    const saved = provider({ id: 'deepseek', displayName: 'DeepSeek' })
    const settings = (r: RoleBindings): SettingsView => ({
      providers: [saved],
      roles: r,
      path: String.raw`C:\models.json`,
      encryptionAvailable: true,
      configured: true
    })
    const setRoles = vi.fn(async (next: RoleBindings) => ({ ok: true, data: settings(next) }))
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
      aiProvider: {
        getSettings: vi.fn(async () => settings(roles)),
        catalog: vi.fn(async () => []),
        saveProvider: vi.fn(async () => ({ ok: true, data: settings(roles) })),
        setRoles
      }
    }
    return { state: useAiProviders(), setRoles }
  }

  it('还没绑过就自动绑上', async () => {
    const { state, setRoles } = harness({})
    await state.load()
    state.selectProvider('deepseek')

    expect(await state.save()).toEqual({ ok: true })
    expect(setRoles).toHaveBeenCalledTimes(1)
    expect(setRoles.mock.calls[0][0].chat).toEqual({
      providerId: 'deepseek',
      modelId: 'gpt-4o'
    })
  })

  it('已经绑过就不动 —— 那是用户自己选的', async () => {
    const { state, setRoles } = harness({
      chat: { providerId: 'openai', modelId: 'gpt-4o' }
    })
    await state.load()
    state.selectProvider('deepseek')

    expect(await state.save()).toEqual({ ok: true })
    expect(setRoles).not.toHaveBeenCalled()
  })
})

/** Box Plan 的来源只读：编辑弹窗既不默认选中它，也选不中它 */
describe('套餐来源不进编辑', () => {
  const view: SettingsView = {
    providers: [
      provider({ id: 'creator-plan', displayName: 'Box Plan' }),
      provider({ id: 'deepseek', displayName: 'DeepSeek' })
    ],
    roles: {},
    path: 'C:\\models.json',
    encryptionAvailable: true,
    configured: true
  }

  it('默认选中第一个能编辑的来源；选套餐来源不生效', async () => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
      aiProvider: {
        getSettings: vi.fn(async () => view),
        catalog: vi.fn(async () => [])
      }
    }
    const state = useAiProviders()
    await state.load()
    expect(state.selectedId.value).toBe('deepseek')

    state.selectProvider('creator-plan')
    expect(state.selectedId.value).toBe('deepseek')
    expect(state.draft.value).toBeNull()
  })
})
