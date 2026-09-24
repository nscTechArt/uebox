import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  ROLE_KIND,
  type CatalogEntry,
  type ModelConfig,
  type ModelRole,
  type ProbeFailure,
  type ProbeSkipCode,
  type ProviderDraft,
  type ProviderKind,
  type ProviderView,
  type RoleBindings,
  type RoleBindingsPatch,
  type SettingsView
} from '@core/shared/aiProvider'
import { invalidateModelLimitsCache } from '@renderer/services/notebook/contextBudget'
import { isPlanProvider } from '@core/shared/creatorPlan'

/**
 * Provider 配置的渲染层状态。
 *
 * 编辑模型是「草稿 + 显式保存」而不是即时写盘：Base URL 打到一半就存会让
 * 主进程反复重建 provider 实例，而且用户改错了没有反悔的余地。
 */

/**
 * 把要发给主进程的对象拍成**纯对象**。
 *
 * `settings` / `draft` 都是深响应式的 ref，从里面取出来的每个子对象都是 Vue 的
 * Proxy。Proxy 过不了 Electron IPC 的结构化克隆（`DataCloneError: #<Object>
 * could not be cloned`），而 `ipcRenderer.invoke` 是以 **reject** 的形式失败的 ——
 * 不是返回 `{ ok:false }`，所以任何「只判 result.ok」的调用点都会静默什么都不做。
 *
 * 角色绑定曾经就栽在这里：第一个角色存得进去（那时 roles 还是空的，负载里全是
 * 新建的纯对象），从第二个开始负载里带上了上一次存盘回来的绑定 —— 于是每一次
 * 都在 IPC 门口就炸了，界面却因为下拉框此时是非受控的而照常显示选中值。
 */
function plainCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 角色下拉里的一个选项。value 是 `providerId::modelId`，模型 id 可能自带冒号 */
export interface ModelOption {
  value: string
  label: string
  /** 它所属 Provider 的用途。角色候选按这一位过滤 */
  kind: ProviderKind
  /** 视觉是**唯一**还留在模型上的角色判据：同一个对话 Provider 下有的模型看得懂图，有的不行 */
  supportsVision: boolean
}

/**
 * 按角色过滤可选模型。
 *
 * **只有两条规则**，因为「这个模型能干什么」现在由它所属 Provider 的用途回答。
 * 在这之前这里是一排 supportsXxx 判断加一份 id 特征词表，每加一种模态就要
 * 再加两行 —— 而且正反两个方向都要写（列进来 / 从对话角色里排除掉），
 * 漏一个方向的表现是绑错了不报错，只是静默失效。
 */
export function filterModelOptionsForRole<T extends ModelOption>(
  options: readonly T[],
  role: ModelRole
): T[] {
  // 用途对不上的一律不列。这一条替掉了以前那一排 supportsXxx 判断 ——
  // 「哪个模型能干这件事」现在由 Provider 的用途回答，不再逐个模型猜
  const usable = options.filter((option) => option.kind === ROLE_KIND[role])
  // 视觉是唯一的例外：同一个对话 Provider 下，能力仍然逐模型不同
  if (role === 'vision') return usable.filter((option) => option.supportsVision)
  return usable
}

/**
 * 角色下拉里那一行显示什么。
 *
 * 直接拼 `厂商 / 模型` 会把厂商名写两遍：DeepSeek 的模型显示名本来就叫
 * 「DeepSeek V4 Flash」，拼出来是「DeepSeek / DeepSeek V4 Flash」，下拉框
 * 放不下就截成「DeepSeek / DeepSeek V4 F…」—— 三个不同的模型在界面上
 * 长得一模一样，而这一栏的全部意义恰恰是让人分清选的是哪个。
 *
 * 模型名才是用户此刻要确认的信息，所以永远放在最前；Provider 留在后面用于
 * 区分同名模型。这样哪怕控件最终仍需截断，先露出来的也会是有区分度的部分。
 */
export function modelOptionLabel(providerName: string, modelName: string): string {
  const provider = providerName.trim()
  const model = modelName.trim()
  if (!provider) return model
  if (!model) return provider
  if (model.toLowerCase().startsWith(provider.toLowerCase())) return model
  return `${model} · ${provider}`
}

/** 空白草稿。id 留空由界面根据显示名生成 */
function blankDraft(): ProviderDraft {
  return {
    id: '',
    displayName: '',
    // 手工新建的默认是对话 —— 那是绝大多数情况，而且只有这一档需要选协议
    kind: 'chat',
    protocol: 'openai-completions',
    baseUrl: '',
    models: [],
    apiKeyInput: ''
  }
}

/**
 * 把已保存的密钥来源还原成输入框里该显示的文本。
 *
 * env / shell 不是机密，原样显示，用户看得见才谈得上修改；
 * literal 读不回来，只能留空（靠 placeholder 说明「已配置」）。
 */
export function apiKeyInputFrom(apiKey: ProviderView['apiKey']): string {
  if (apiKey.kind === 'env') return apiKey.name
  if (apiKey.kind === 'shell') return `!${apiKey.command}`
  // literal 与 oauth 都读不回来，只能留空，靠 placeholder 说明「已配置」
  return ''
}

/** 把目录条目展开成草稿。用户选了「OpenAI」之后不用再填 Base URL 和协议 */
export function draftFromCatalog(entry: CatalogEntry): ProviderDraft {
  return {
    id: entry.id,
    displayName: entry.displayName,
    kind: entry.kind,
    model3dApi: entry.model3dApi,
    videoApi: entry.videoApi,
    musicApi: entry.musicApi,
    protocol: entry.protocol,
    baseUrl: entry.baseUrl,
    models: entry.models.map((model) => ({ ...model })),
    // 预填约定的环境变量名：设过就直接能用，没设过保存时会提示取不到。
    // 比留空更有引导性 —— 用户至少知道该设哪个变量。
    apiKeyInput: entry.requiresApiKey ? entry.defaultEnvVar || '' : ''
  }
}

/** 把已保存的 provider 还原成可编辑草稿 */
export function draftFromProvider(provider: ProviderView): ProviderDraft {
  return {
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    model3dApi: provider.model3dApi,
    videoApi: provider.videoApi,
    musicApi: provider.musicApi,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    headers: provider.headers ? { ...provider.headers } : undefined,
    imageUploadUrl: provider.imageUploadUrl,
    imageResolutionTiers: provider.imageResolutionTiers,
    models: provider.models.map((model) => ({ ...model })),
    apiKeyInput: apiKeyInputFrom(provider.apiKey)
  }
}

/**
 * 由显示名推导 provider id。
 *
 * id 是 models.json 里的主键，也是密钥库的键，所以只允许小写字母数字与连字符。
 */
export function slugify(displayName: string): string {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'provider'
}

/**
 * 找一个不与现有 provider 撞车的 id。
 *
 * 配两个 OpenAI（一个官方一个自建网关）是常见需求，所以不能只处理「第二个」。
 */
export function uniqueProviderId(baseId: string, existing: Array<{ id: string }>): string {
  const taken = new Set(existing.map((item) => item.id))
  if (!taken.has(baseId)) return baseId
  let suffix = 2
  while (taken.has(`${baseId}-${suffix}`)) suffix += 1
  return `${baseId}-${suffix}`
}

/**
 * 默认选中哪个来源：第一个能编辑的。套餐来源只读，选中它的话编辑弹窗右边
 * 会摆出一张改不了的表单，删除按钮也指着它。
 */
function firstEditableId(list: ReadonlyArray<{ id: string }>): string | null {
  return list.find((item) => !isPlanProvider(item.id))?.id ?? null
}

export interface AiProvidersState {
  settings: Ref<SettingsView | null>
  catalog: Ref<CatalogEntry[]>
  loading: Ref<boolean>
  saving: Ref<boolean>
  testing: Ref<boolean>
  importing: Ref<boolean>
  /** 正在等用户在浏览器里完成 OAuth 授权 */
  authorizing: Ref<boolean>
  /** 当前选中的 provider id。null 表示没有选中（右侧显示空态） */
  selectedId: Ref<string | null>
  /** 正在编辑的草稿。null 表示未进入编辑 */
  draft: Ref<ProviderDraft | null>
  /** 草稿是新建的还是改已有的 —— 决定能不能改 id */
  isNew: Ref<boolean>
  /** 草稿与上一次存盘（或刚进入编辑时）相比有没有改动 */
  isDirty: ComputedRef<boolean>
  providers: ComputedRef<ProviderView[]>
  roles: ComputedRef<RoleBindings>
  configured: ComputedRef<boolean>
  encryptionAvailable: ComputedRef<boolean>
  configPath: ComputedRef<string>
  load: () => Promise<void>
  selectProvider: (providerId: string) => void
  startCreate: (entry?: CatalogEntry) => void
  cancelEdit: () => void
  save: () => Promise<{ ok: boolean; error?: string }>
  remove: (providerId: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * `skipped` 有值表示根本没发请求（3D 那一档，探测一次就扣钱），界面别显示成绿勾。
   *
   * `error` 是**码**不是文案：主进程只判是哪一种，措辞在 `probeCopy.ts` 查语言包 ——
   * 原来这里是一整句中文，英文用户点「测试连接」读不懂自己配错在哪。
   */
  test: (modelId: string) => Promise<{ ok: boolean; error?: ProbeFailure; skipped?: ProbeSkipCode }>
  importModels: () => Promise<{ ok: boolean; count?: number; error?: ProbeFailure }>
  oauthLogin: (oauthProvider: string) => Promise<{ ok: boolean; saved?: boolean; error?: string }>
  setRole: (
    role: ModelRole | readonly ModelRole[],
    binding: { providerId: string; modelId: string } | null
  ) => Promise<{ ok: boolean; error?: string }>
  revealConfig: () => Promise<void>
}

export function useAiProviders(): AiProvidersState {
  const settings = ref<SettingsView | null>(null)
  const catalog = ref<CatalogEntry[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const testing = ref(false)
  const importing = ref(false)
  const authorizing = ref(false)
  const selectedId = ref<string | null>(null)
  const draft = ref<ProviderDraft | null>(null)
  const isNew = ref(false)

  /**
   * 草稿刚被摆上来时的样子，用来判断「改过没有」。
   *
   * 存的是序列化后的字符串而不是对象引用：draft 是深响应式的，留一个对象引用
   * 会跟着草稿一起被改，永远比不出差异。
   */
  const baseline = ref<string | null>(null)

  /**
   * 把草稿摆上来，同时记下它此刻的样子。
   *
   * 所有给 draft 赋值的地方都必须走这里 —— 漏一处的表现是「明明没改，
   * 切走却被拦下来问要不要保存」，或者更糟，改了却没拦。
   */
  function setDraft(next: ProviderDraft | null): void {
    draft.value = next
    baseline.value = next ? JSON.stringify(next) : null
  }

  const isDirty = computed(() => {
    if (!draft.value) return false
    return JSON.stringify(draft.value) !== baseline.value
  })

  const providers = computed(() => settings.value?.providers ?? [])
  const roles = computed(() => settings.value?.roles ?? {})
  const configured = computed(() => settings.value?.configured ?? false)
  const encryptionAvailable = computed(() => settings.value?.encryptionAvailable ?? true)
  const configPath = computed(() => settings.value?.path ?? '')

  async function load(): Promise<void> {
    loading.value = true
    try {
      const [nextSettings, nextCatalog] = await Promise.all([
        window.api.aiProvider.getSettings(),
        window.api.aiProvider.catalog()
      ])
      settings.value = nextSettings
      catalog.value = nextCatalog

      // 选中项还在就保持不动，免得存一次盘右侧就跳回空态
      const stillThere = nextSettings.providers.some((item) => item.id === selectedId.value)
      if (!stillThere) {
        selectedId.value = firstEditableId(nextSettings.providers)
        setDraft(null)
      }
    } finally {
      loading.value = false
    }
  }

  function selectProvider(providerId: string): void {
    // 套餐来源只读，操作都走套餐卡片（主进程的保存、删除也会拦）
    if (isPlanProvider(providerId)) return
    const provider = providers.value.find((item) => item.id === providerId)
    if (!provider) return
    selectedId.value = providerId
    setDraft(draftFromProvider(provider))
    isNew.value = false
  }

  function startCreate(entry?: CatalogEntry): void {
    const next = entry ? draftFromCatalog(entry) : blankDraft()
    // 目录里选来的 provider 会与已存在的同 id 撞车（比如配两个 OpenAI 走不同网关）。
    // id 是 models.json 的主键，撞了就会**静默覆盖**掉原来那条，所以必须让开。
    if (next.id) {
      next.id = uniqueProviderId(next.id, providers.value)
    }
    setDraft(next)
    selectedId.value = null
    isNew.value = true
  }

  function cancelEdit(): void {
    if (isNew.value) {
      setDraft(null)
      selectedId.value = firstEditableId(providers.value)
      if (selectedId.value) selectProvider(selectedId.value)
      return
    }
    if (selectedId.value) selectProvider(selectedId.value)
  }

  /** 提交前补齐 id 并去掉空白项，避免把半成品写进 models.json */
  function normalizedDraft(): ProviderDraft | null {
    const current = draft.value
    if (!current) return null
    const displayName = current.displayName.trim() || current.id.trim()
    // plainCopy 不能省：草稿是响应式的，headers 这类子对象取出来是 Proxy，
    // 直接丢进 IPC 会在结构化克隆那一步 reject。
    return plainCopy({
      ...current,
      id: (current.id.trim() || slugify(displayName)).toLowerCase(),
      displayName,
      baseUrl: current.baseUrl.trim(),
      models: current.models
        .map((model) => ({ ...model, id: model.id.trim() }))
        .filter((model) => model.id)
    })
  }

  async function save(): Promise<{ ok: boolean; error?: string }> {
    const payload = normalizedDraft()
    if (!payload) return { ok: false, error: 'no-draft' }

    saving.value = true
    try {
      const result = await window.api.aiProvider.saveProvider(payload)
      if (!result.ok) return { ok: false, error: result.error }
      settings.value = result.data
      selectedId.value = payload.id
      isNew.value = false
      // 用存盘后的结果重建草稿：密钥字段要重新变回空，
      // 否则用户会以为明文还留在框里，再点一次保存就重复写入密钥库。
      const saved = result.data.providers.find((item) => item.id === payload.id)
      if (saved) setDraft(draftFromProvider(saved))

      /*
       * 第一个对话 Provider 存下来就自动绑「对话」角色。
       *
       * 不绑的话整个应用一个 AI 功能都用不了，而界面上没有任何地方说这一步还没做 ——
       * 用户填完密钥、测试连接通过、回到助手页发现发不出消息。「测试通过」和
       * 「能用」之间隔着一个他不知道存在的下拉框。
       *
       * 只在**还没绑过**时做：绑过的说明用户自己选过，别覆盖他的选择。
       */
      if (!roles.value.chat && saved?.kind === 'chat' && saved.models[0]) {
        /*
         * 绑失败要如实回报。
         *
         * `setRole` 内部自己 catch，失败是**返回**不是抛（见它的实现），所以
         * 不看返回值的话：配置目录只读之类的故障下，界面报「保存成功」，而对话
         * 角色其实还是空的，用户回到助手页发不出消息 —— 正是上面这段注释说要
         * 消灭的那个状态。
         */
        const bound = await setRole('chat', {
          providerId: saved.id,
          modelId: saved.models[0].id
        })
        if (!bound.ok) return { ok: false, error: bound.error }
      }
      return { ok: true }
    } finally {
      saving.value = false
    }
  }

  async function remove(providerId: string): Promise<{ ok: boolean; error?: string }> {
    const result = await window.api.aiProvider.deleteProvider(providerId)
    if (!result.ok) return { ok: false, error: result.error }
    settings.value = result.data
    if (selectedId.value === providerId) {
      selectedId.value = firstEditableId(result.data.providers)
      setDraft(
        selectedId.value
          ? draftFromProvider(result.data.providers.find((i) => i.id === selectedId.value)!)
          : null
      )
    }
    return { ok: true }
  }

  async function test(
    modelId: string
  ): Promise<{ ok: boolean; error?: ProbeFailure; skipped?: ProbeSkipCode }> {
    const payload = normalizedDraft()
    if (!payload) return { ok: false, error: { code: 'noDraft' } }
    testing.value = true
    try {
      const result = await window.api.aiProvider.test(payload, modelId)
      // skipped 要原样带到界面：把「没测」显示成「测过了」比不测更糟
      return result.ok ? { ok: true, skipped: result.skipped } : { ok: false, error: result.error }
    } finally {
      testing.value = false
    }
  }

  async function importModels(): Promise<{
    ok: boolean
    count?: number
    error?: ProbeFailure
  }> {
    const payload = normalizedDraft()
    if (!payload || !draft.value) return { ok: false, error: { code: 'noDraft' } }
    importing.value = true
    try {
      const result = await window.api.aiProvider.listModels(payload)
      if (!result.ok) return { ok: false, error: result.error }

      // 合并而不是替换：厂商的 /models 不会告诉我们哪个支持视觉/工具，
      // 直接覆盖会把用户手工标注的能力位抹掉。
      const existing = new Map(draft.value.models.map((model) => [model.id, model]))
      const merged: ModelConfig[] = result.models.map(
        (model) => existing.get(model.id) ?? { ...model }
      )
      for (const [id, model] of existing) {
        if (!merged.some((item) => item.id === id)) merged.push(model)
      }
      const added = merged.length - draft.value.models.length
      draft.value.models = merged
      return { ok: true, count: added }
    } finally {
      importing.value = false
    }
  }

  /**
   * 改一个（或一组）角色的绑定，立即落盘。一组的话一次写盘，要么全改，要么全不改。
   *
   * 只发改了的角色，主进程在最新的配置上合并：套餐清单的后台对账会改写配置
   * （停用模型换成接替者、套餐不再给的角色还给用户）却不通知这一页，发整张表的话，
   * 页面手里那份旧表就把对账的结果盖掉了；连着快改两下，后一次也会盖掉前一次。
   *
   * 失败必须回给调用方：绑定下拉框在「未设置」时是**非受控**的（value 传
   * undefined，ant-design-vue 会退回它自己的内部状态），存不进去也照样显示选中值。
   * 这里不出声，用户看到的就是「明明选好了，重开一看全没了」。
   */
  async function setRole(
    role: ModelRole | readonly ModelRole[],
    binding: { providerId: string; modelId: string } | null
  ): Promise<{ ok: boolean; error?: string }> {
    const patch: RoleBindingsPatch = {}
    for (const target of typeof role === 'string' ? [role] : role) {
      patch[target] = binding ? { providerId: binding.providerId, modelId: binding.modelId } : null
    }

    try {
      const result = await window.api.aiProvider.setRoles(patch)
      if (!result.ok) return { ok: false, error: result.error }
      settings.value = result.data
      // 换了模型，按角色缓存的那套窗口/输出上限立刻作废 —— 不然知识库那边的预算
      // 和计量条会继续按上一个模型算，最长要等一分钟 TTL 过期才跟上
      invalidateModelLimitsCache()
      return { ok: true }
    } catch (error) {
      // invoke 是以 reject 失败的（IPC 通道断开、负载克隆不了），不是 { ok:false }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function revealConfig(): Promise<void> {
    await window.api.aiProvider.revealConfig()
  }

  /**
   * 走一次账号登录。
   *
   * 两条出口对应主进程那边的两种情况：
   * - 拿回永久 Key：填进草稿，用户再点保存，与手输密钥同一条路径
   * - 拿回会过期的令牌：令牌不进渲染层，主进程已经连 provider 一起存好了，
   *   这里只要把新的 settings 换上、右侧回到已保存状态即可
   */
  async function oauthLogin(
    oauthProvider: string
  ): Promise<{ ok: boolean; saved?: boolean; error?: string }> {
    const payload = normalizedDraft()
    if (!payload) return { ok: false, error: 'no-draft' }

    authorizing.value = true
    try {
      const result = await window.api.aiProvider.oauthLogin(oauthProvider, payload)
      if (!result.ok) return { ok: false, error: result.error }

      if (result.data.key) {
        if (draft.value) draft.value.apiKeyInput = result.data.key
        return { ok: true, saved: false }
      }

      if (result.data.settings) {
        settings.value = result.data.settings
        selectedId.value = payload.id
        isNew.value = false
        const saved = result.data.settings.providers.find((item) => item.id === payload.id)
        if (saved) setDraft(draftFromProvider(saved))
      }
      return { ok: true, saved: true }
    } finally {
      authorizing.value = false
    }
  }

  return {
    settings,
    catalog,
    loading,
    saving,
    testing,
    importing,
    authorizing,
    selectedId,
    draft,
    isNew,
    isDirty,
    providers,
    roles,
    configured,
    encryptionAvailable,
    configPath,
    load,
    selectProvider,
    startCreate,
    cancelEdit,
    save,
    remove,
    test,
    importModels,
    oauthLogin,
    setRole,
    revealConfig
  }
}
