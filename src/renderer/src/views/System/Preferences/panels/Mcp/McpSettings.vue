<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
/**
 * MCP 设置。
 *
 * 两个方向分开呈现，别让用户混淆：
 *   - 上半：**接入**第三方 server（盒子是 client）
 *   - 下半：**对外暴露**虚幻引擎能力（盒子是 server）
 *
 * ## 渐进披露：两半都要守
 *
 * 判据只有一条 —— **每次进这个页面，用户是来干什么的？**
 * 答案是「看一眼通没通」和「开不开」。不是来改启动命令、调端口、读安全条款的。
 * 所以默认态就该只有这两样，其余全部折起来。
 *
 * 下半页（对外暴露）分三层：
 *
 *   1. 常驻：一个开关 + 一行状态。这是 99% 的访问只需要的东西。
 *   2. 「连接配置」展开：粘给外部客户端的那段 JSON 和令牌。
 *      配一次就不用再看，不该常驻。
 *   3. 「端口和权限」展开：端口、写工具开关、那段长警告。
 *
 * 上半页（接入第三方）同一条规矩：**每条 server 收起来只有一行** ——
 * 名字 + 通没通 + 删除。四个输入框只在展开时出现。
 * 这一条曾经整个漏掉，一条 blender 就占掉半屏。
 *
 * ## 折叠区藏默认值，标签负责预告风险
 *
 * 权限档一度被提到主开关同层，理由是「不能把风险藏进『高级』」。那个理由只对了
 * 一半：毛病是**「高级」这两个字不预告里面有什么**，不是它折起来了。
 * 现在标题直接叫「端口和权限」，当前档位（只读/可写）挂在标题上 ——
 * 不展开也看得见，第一屏还少一块。
 *
 * 安全警告同理：默认只有一行短的（只监听本机 / 要令牌 / 只读），
 * **打开写权限时才展开那段长的** —— 风险变了才提示，而不是每次进来都吓一遍。
 * 常驻的警告等于没有警告。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from 'vue-i18n'

import {
  isEngineServerId,
  isValidPort,
  isValidServerId,
  mcpClientAPI,
  mcpServerAPI,
  parseEnvText,
  toFormValues,
  toSettings,
  type EpicSetupProjectStatus,
  type McpServerFormValue
} from '@renderer/api/mcp'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const { t } = useI18n()

const servers = ref<McpServerFormValue[]>([])
const statuses = ref<McpServerStatus[]>([])
const configPath = ref('')
const saving = ref(false)
const saveError = ref('')

/** 停止状态下也带着端口/令牌/配置片段，所以初值要给全 */
const EMPTY_HOST: McpServerHostView = {
  running: false,
  exposedTools: 0,
  url: '',
  clientConfig: '',
  settings: { enabled: false, port: 17861, token: '', includeMutating: false }
}

const host = ref<McpServerHostView>({ ...EMPTY_HOST })
const includeMutating = ref(false)
const port = ref(17861)
const hostBusy = ref(false)
const copied = ref('')

/** 两块折叠区。默认都收起 —— 配一次就不用再看的东西不该常驻 */
const showConfig = ref(false)
const showAdvanced = ref(false)

const portError = computed(() => (isValidPort(port.value) ? '' : t('mcp.server.portInvalid')))

/**
 * 令牌打码。
 *
 * 它是凭据，没理由一直摊在屏幕上 —— 用户身边有人、或者在录屏/共享桌面时
 * 尤其如此。要用的时候点「复制令牌」，要核对的时候看头尾就够了。
 */
const maskedToken = computed(() => {
  const token = host.value.settings?.token ?? ''
  if (token.length <= 16) return token
  return `${token.slice(0, 8)}……${token.slice(-6)}`
})

/**
 * 预览里的令牌也要打码。
 *
 * 上面那段打码原来**完全是白做的**：同一把令牌一字不差地印在上方那块 JSON 里，
 * 字号还更大。屏幕上但凡有第二个人、或者正在录屏共享，泄露的是那一块，
 * 不是底下那行头尾。
 *
 * 复制走的始终是完整的 `clientConfig` —— 打码是给眼睛看的，不影响粘贴。
 * 要肉眼核对完整值就点「显示」，那是一个明确的动作。
 */
const revealToken = ref(false)

const displayedConfig = computed(() => {
  const token = host.value.settings?.token ?? ''
  const config = host.value.clientConfig ?? ''
  if (!token || revealToken.value) return config
  return config.split(token).join(maskedToken.value)
})

const statusById = computed(() => new Map(statuses.value.map((s) => [s.id, s])))

const duplicateIds = computed(() => {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const s of servers.value) {
    const id = s.id.trim()
    if (!id) continue
    if (seen.has(id)) dupes.add(id)
    seen.add(id)
  }
  return dupes
})

/**
 * 一个字都没填的行。
 *
 * **这是这一节里最值钱的一个判断**，一条规则解掉三个毛病：
 *
 *   - 点「添加服务」立刻蹦出一句「标识不能为空」—— 用户还没输入就被判有罪
 *   - 那条红字让 `hasErrors` 为真，「保存并连接」整个禁掉，
 *     于是他连**刚刚在另一行改好的东西**都存不了
 *   - 存的时候还得想「这条空行会不会被写进 mcp.json」
 *
 * 加机制（逐行 touched 标记、失焦才校验、保存时再统一飘红）都能治，
 * 但都是往上堆。真正的语义很简单：**加了没填就等于没加**。
 * 空行不报错、不挡保存、保存时丢掉。
 */
function isBlankRow(value: McpServerFormValue): boolean {
  return (
    !value.id.trim() && !value.commandLine.trim() && !value.url.trim() && !(value.env ?? '').trim()
  )
}

function idError(value: McpServerFormValue): string {
  if (isBlankRow(value)) return ''
  const id = value.id.trim()
  if (!id) return t('mcp.errors.idRequired')
  if (!isValidServerId(id)) return t('mcp.errors.idInvalid')
  if (duplicateIds.value.has(id)) return t('mcp.errors.idDuplicate')
  return ''
}

/**
 * 这条是不是还没存过。
 *
 * 用「有没有状态」判断，而不是再维护一份影子数据：存过的 server 一定会带回
 * 一条状态（连上了 / 连不上 / 被停用），**只有没存过的那条什么都没有**。
 * 草稿和已生效的配置长得一模一样，用户分不出哪条正在跑。
 */
function isDraftRow(value: McpServerFormValue): boolean {
  return !isBlankRow(value) && !statusById.value.has(value.id.trim())
}

/**
 * 认不出来的环境变量行。
 *
 * 必须挡住保存，不能只是灰着提示一句：这个面板刚因为「悄悄丢配置」出过事
 * （见 `api/mcp.ts` 的 `PreservedServerFields`），再让一行写错的 env 静默消失，
 * 用户看到的又会是「配了，但没生效，也没人告诉我」。
 */
function envError(value: McpServerFormValue): string {
  if (value.transport !== 'stdio') return ''
  const { invalid } = parseEnvText(value.env ?? '')
  if (invalid.length === 0) return ''
  return t('mcp.errors.envInvalid', { line: invalid[0] })
}

/** 真正会被写盘的行。空行在这里就被丢掉了 —— 见 `isBlankRow` */
const filledServers = computed(() => servers.value.filter((s) => !isBlankRow(s)))

const badRowCount = computed(
  () => filledServers.value.filter((s) => idError(s) !== '' || envError(s) !== '').length
)

const hasErrors = computed(() => badRowCount.value > 0)

/**
 * 禁用的按钮必须说出自己为什么点不动。
 *
 * 出错的那行可能滚出了视野（尤其是加到第三、四条以后），用户看到的就只是
 * 一个灰掉的主按钮。灰而不说等于让人猜。
 */
const saveBlockedReason = computed(() =>
  hasErrors.value ? t('mcp.errors.blocked', { count: badRowCount.value }) : ''
)

/**
 * 有没有没保存的改动。
 *
 * 上半页是「改完要点保存」，下半页的端口是「失焦就落盘」—— 同一页两套语义，
 * 用户没理由猜得到哪个是哪个。至少要让这半页的改动**看得见**：
 * 这个面板已经因为「悄悄丢配置」出过一次事，切走页面丢掉一屏输入是同一个症状
 * 换了个入口。
 */
const savedSnapshot = ref('')
const snapshotOf = (): string => JSON.stringify(toSettings(filledServers.value))
const isDirty = computed(() => savedSnapshot.value !== '' && snapshotOf() !== savedSnapshot.value)

/**
 * 引擎自动发现来的 server（UE 5.8 内置的官方 MCP）。
 *
 * 它不在 `mcp.json` 里，所以不能混进上面那张可编辑的表 —— 用户会去找一个
 * 删不掉也改不动的条目。单独一块只读地列出来，并告诉他怎么覆盖。
 *
 * 用户如果真在 `mcp.json` 里写了同名条目，那条就归可编辑列表管，这里不再重复。
 */
const engineStatuses = computed(() => {
  const configured = new Set(servers.value.map((s) => s.id.trim()))
  return statuses.value.filter((s) => isEngineServerId(s.id) && !configured.has(s.id))
})

/** 状态胶囊。停用是用户自己的选择，不能和连接失败混为一谈 */
function chipOf(rawId: string): { tone: string; label: string; title: string } | undefined {
  const status = statusById.value.get(rawId.trim())
  if (!status) return undefined
  if (status.disabled) return { tone: 'muted', label: t('mcp.status.disabled'), title: '' }
  if (status.connected) {
    return { tone: 'ok', label: t('mcp.status.connected', { count: status.toolCount }), title: '' }
  }
  return { tone: 'bad', label: t('mcp.status.failed'), title: status.error ?? '' }
}

/**
 * 连不上的原因。
 *
 * 原来只塞在胶囊的 `title` 里 —— 而这个文件自己早就写过那句教训：
 * **会去排查的人不会想到悬停**。一条「连接失败」不带原因，用户能做的只有瞪着它；
 * 而原因往往一句话就说清了（`spawn npx ENOENT`、`ECONNREFUSED`），
 * 是这一屏信息量最大的一行字。
 */
function errorOf(rawId: string): string {
  const status = statusById.value.get(rawId.trim())
  if (!status || status.connected || status.disabled) return ''
  return status.error ?? ''
}

/** 停用是用户自己关的，不算「连不上」 */
const engineFailed = computed(() => engineStatuses.value.some((s) => !s.connected && !s.disabled))

/**
 * 引擎块收起时那一行的状态。
 *
 * 有一个连不上就整块报失败 —— 折叠区最怕的就是把问题盖住，
 * 收起来的那一行必须自己说清楚里面是好是坏。
 */
const engineSummary = computed((): { tone: string; label: string } | undefined => {
  const list = engineStatuses.value
  if (list.length === 0) return undefined
  if (engineFailed.value) return { tone: 'bad', label: t('mcp.status.failed') }

  const connected = list.filter((s) => s.connected)
  if (connected.length === 0) return { tone: 'muted', label: t('mcp.status.disabled') }
  const count = connected.reduce((sum, s) => sum + (s.toolCount ?? 0), 0)
  return { tone: 'ok', label: t('mcp.engine.connected', { count }) }
})

/**
 * 连不上的时候强制摊开。
 *
 * 和 server 行同一条规矩：错误原因和重试按钮藏在折叠里等于不存在。
 * 好好跑着的时候才允许收成一行 —— 那时候里面确实没有要处理的事。
 */
const showEngine = ref(false)
const engineOpen = computed(() => showEngine.value || engineFailed.value)

/**
 * 把主进程回的视图落到本地表单状态。
 *
 * **必须容忍字段缺失。** 开发时改渲染层是热更新的，主进程不会跟着重启 ——
 * 于是新界面配上旧主进程，`status` 里没有 `settings`，
 * `view.settings.includeMutating` 直接抛 TypeError：`load()` 挂掉、
 * 面板停在初始状态、开关按下去没反应、连接配置那块也出不来。
 * 用户报的三条症状都能由这一个异常解释。
 *
 * 打包版本不会出现这种搭配，但开发时天天遇到，不该让面板整个废掉。
 */
function applyHost(view: McpServerHostView | undefined): void {
  if (!view) return
  const settings = { ...EMPTY_HOST.settings, ...(view.settings ?? {}) }
  host.value = {
    ...EMPTY_HOST,
    ...view,
    settings,
    url: view.url || `http://127.0.0.1:${settings.port}/`
  }
  includeMutating.value = settings.includeMutating
  port.value = settings.port
}

/**
 * 启停之后回主进程要一次真实状态。
 *
 * 不信任 start/stop 自己回的那个：万一某一步只成功了一半（端口占用、
 * 关闭超时），界面显示的必须是服务**实际**在什么状态，
 * 而不是这次操作声称的结果。开关卡住的观感就是这么来的。
 */
async function refreshHost(): Promise<void> {
  try {
    applyHost(await mcpServerAPI.status())
  } catch (error) {
    console.warn('[MCP] 刷新对外服务状态失败:', error)
  }
}

/**
 * 上下两半分开加载。
 *
 * 一开始是一个 `load()` 串着两个请求，结果下半页（对外暴露）出错时
 * 上半页也一起白掉。两块之间没有依赖，不该互相拖累。
 */
async function load(): Promise<void> {
  try {
    const result = await mcpClientAPI.getSettings()
    servers.value = toFormValues(result.settings)
    statuses.value = result.statuses
    configPath.value = result.path
    // 「未保存」的基准线。读失败时留空 —— 那时候一切改动都无从比较，
    // 顶着一个假的「已保存」比不显示更糟
    savedSnapshot.value = snapshotOf()
  } catch (error) {
    console.warn('[MCP] 读取第三方 server 配置失败:', error)
  }
  await Promise.all([refreshHost(), refreshEpic()])
}

/**
 * 一键开启 UE 5.8 官方 MCP。
 *
 * 手工流程要在 Edit > Plugins 和 Editor Preferences 两个面板里点四步，
 * **大部分用户走不完，走不完就等于这个能力不存在**。这里代劳前三步。
 *
 * ## 这一块永远显示（除非已经开好了）
 *
 * 初版写的是「没有可操作项目就整个不渲染」，理由是「不给用户一个永远点不了的
 * 按钮」。**那个理由是错的**：结果不是界面更干净，而是用户在设置页里
 * 什么都看不到，也无从知道为什么 —— 没连项目、引擎太老、主进程没起来，
 * 三种完全不同的原因长得一模一样，都是「一片空白」。
 *
 * 空白不是「没有噪音」，空白是「看起来坏了」。所以现在：块常驻，
 * **能一键就给按钮，不能就说清楚差什么**。只有真正开好了（ready）才收起来 ——
 * 那时下面的自动发现块已经在报「已连接」，再留一块就真是重复了。
 */
const epicProjects = ref<EpicSetupProjectStatus[]>([])
const epicBusy = ref('')
const epicMessage = ref('')
const epicError = ref('')
const epicLoading = ref(true)

/** 可以点按钮的项目 */
const epicActionable = computed(() =>
  epicProjects.value.filter((p) => p.state === 'needs-plugins' || p.state === 'needs-start')
)

/** 配好了但还没重启编辑器的 */
const epicPendingRestart = computed(() =>
  epicProjects.value.filter((p) => p.state === 'needs-restart')
)

/** 引擎版本不够的。要点名说出来，否则用户只会觉得「按钮怎么不见了」 */
const epicUnsupported = computed(() => epicProjects.value.filter((p) => p.state === 'unsupported'))

/** 已经开好的。正常情况下由下面的自动发现块接手报状态，这里只在它没接上时兜底 */
const epicReady = computed(() => epicProjects.value.filter((p) => p.state === 'ready'))

/** 空列表不算：那说明一个项目都没连，得告诉用户先去打开项目 */
const epicAllReady = computed(
  () => epicProjects.value.length > 0 && epicProjects.value.every((p) => p.state === 'ready')
)

/**
 * 一键块唯一该收起来的条件：全都开好了，**并且自动发现块真的接手了**。
 *
 * 后半句是补上的。原来只看 `epicAllReady`，而那两个判据的数据源根本不一样：
 * `epicStatus` 每次都真去探端口，`statuses` 是 MCP manager 上次连接时的快照。
 * 用户开着盒子再去打开 5.8 工程和插件时两者必然错位 —— 探得到 ready，
 * 快照里却一条都没有，于是一键块因为「已经好了」收起，自动发现块因为
 * 「还不知道好了」不出现，中间是一片没有任何解释的空白。
 *
 * 这正是本文件上面那段注释写过的教训（见 `epicLoading` 那块）：
 * **空白不是「没有噪音」，空白是「看起来坏了」**。同一个错在状态机的
 * 另一端又犯了一遍，所以这里把交接做成互锁：接手的那块出现了，才允许收起。
 */
const hideEpicSetup = computed(() => epicAllReady.value && engineStatuses.value.length > 0)

/**
 * 探到服务在跑、缓存里却没有它 —— 自动补一次重连。
 *
 * `currentStatuses()` 只有在 agent 跑过一次、或用户手点「重新连接」时才会更新，
 * 没有任何东西会因为「用户刚打开了工程」去重新发现。不补的话用户得自己猜到
 * 去点那个跟引擎看起来毫无关系的按钮。
 *
 * 一次挂载只补一次：补不上（发现的三道门有一道没过）就让上面的 ready 行兜底，
 * 不要在这儿空转。
 */
const engineReconnectTried = ref(false)

async function syncEngineConnection(): Promise<void> {
  if (engineReconnectTried.value || !epicAllReady.value) return
  // 用原始列表判断，不是 engineStatuses —— 用户在 mcp.json 里手写了同名条目时
  // 它会被过滤掉，但那条**已经连上了**，再重连一次纯属多余
  if (statuses.value.some((s) => isEngineServerId(s.id))) return

  engineReconnectTried.value = true
  try {
    const result = await mcpClientAPI.reconnect()
    if (result.success) statuses.value = result.statuses ?? []
  } catch (error) {
    console.warn('[MCP] 引擎 server 补连失败:', error)
  }
}

async function refreshEpic(): Promise<void> {
  epicLoading.value = true
  epicError.value = ''
  try {
    const result = await mcpClientAPI.epicStatus()
    epicProjects.value = result.success ? result.projects : []
    // 主进程报的错要显示出来。吞掉的话界面又变回那片没有原因的空白 ——
    // 开发时最常见的一种就是主进程没重启，新的 IPC 通道压根不存在
    if (!result.success) epicError.value = result.error ?? ''
  } catch (error) {
    epicProjects.value = []
    epicError.value = (error as Error).message
  } finally {
    epicLoading.value = false
  }
  await syncEngineConnection()
}

async function setupEpic(project: EpicSetupProjectStatus): Promise<void> {
  if (epicBusy.value) return
  epicBusy.value = project.connectionId
  epicMessage.value = ''
  try {
    const result = await mcpClientAPI.epicSetup(project.connectionId)
    // message 由主进程给：它才知道这次是「起来了」「要重启」还是「配置失败」，
    // 渲染层照着 state 猜会和实际发生的事对不上
    epicMessage.value = result.message ?? result.error ?? ''
    if (result.statuses) statuses.value = result.statuses
    await refreshEpic()
  } catch (error) {
    epicMessage.value = (error as Error).message
  } finally {
    epicBusy.value = ''
  }
}

/** 新行的标识输入框。加完要把光标送进去，见 `addServer` */
const idInputs = ref<HTMLInputElement[]>([])

async function addServer(): Promise<void> {
  servers.value.push({
    id: '',
    transport: 'stdio',
    commandLine: '',
    url: '',
    disabled: false,
    env: '',
    preserved: {}
  })
  // 新行摊开着（空行本来就强制展开），但要**记下来**：一旦填进标识就不再是空行，
  // 收起去会把用户正在填的东西吞掉
  expandedRows.value = new Set([...expandedRows.value, servers.value[servers.value.length - 1]])

  // 加完一行不给焦点，用户得自己再去点一下那个框；行多了还要先找到它在哪
  await nextTick()
  const last = idInputs.value[idInputs.value.length - 1]
  last?.focus()
  last?.scrollIntoView({ block: 'nearest' })
}

/**
 * 删一条配置。
 *
 * 要确认：手填的路径和环境变量删掉就没了，没有撤销。原来这里是裸删，
 * 而破坏性差不多的「重置令牌」反倒有确认 —— 保护级别正好反了。
 */
function removeServer(index: number): void {
  const value = servers.value[index]
  // 空行是用户刚点出来还没填的，删它没有任何损失，不该再拦一道
  if (
    !isBlankRow(value) &&
    !window.confirm(t('mcp.actions.removeConfirm', { id: value.id.trim() }))
  )
    return
  servers.value.splice(index, 1)
}

async function save(): Promise<void> {
  if (hasErrors.value || saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    // 保存即重连，用户在这个页面就能看到每个 server 通没通，
    // 而不是等下一次对话才发现配错
    const payload = toSettings(filledServers.value)
    const result = await mcpClientAPI.saveSettings(payload)
    if (result.success) {
      statuses.value = result.statuses ?? []
      // 空行存不进 mcp.json，留在界面上只会一直顶着「未保存」的标记
      servers.value = servers.value.filter((s) => !isBlankRow(s))
      savedSnapshot.value = JSON.stringify(payload)
      // 存完了就把编辑态收回去 —— 事办完了，屏幕该回到「一行一个服务」
      expandedRows.value = new Set()
    } else saveError.value = result.error ?? t('mcp.errors.saveFailed')
  } catch (error) {
    saveError.value = (error as Error).message
  } finally {
    saving.value = false
  }
}

/**
 * 重连全部 server。
 *
 * 引擎块的「重试连接」走的是同一个动作 —— 主进程那边本来就是整批重建
 * （`reconnectMcp` 先 shutdown 再 ensureConnected），没有单独重连一条的口子。
 * 按钮放在失败那块旁边，是因为**用户是在那儿看到问题的**，
 * 不该让他去猜「下面那个跟第三方服务放在一起的按钮也管引擎」。
 */
const reconnecting = ref(false)

async function reconnect(): Promise<void> {
  if (reconnecting.value) return
  reconnecting.value = true
  try {
    const result = await mcpClientAPI.reconnect()
    if (result.success) statuses.value = result.statuses ?? []
  } finally {
    reconnecting.value = false
  }
}

/**
 * 端口 / 暴露范围一改就落盘。
 *
 * 原来这两项**只有点「开启」才会写进 mcp-server.json** —— 用户改完不开启
 * 就切走页面，下次回来全变回默认值，看起来就是「配置没有持久化」。
 * 端口非法时不写：写进去下次开机自启会拿一个必然失败的端口。
 */
const configSaved = ref(false)
const configError = ref('')

async function persistConfig(): Promise<void> {
  if (portError.value) return
  configError.value = ''
  try {
    const result = await mcpServerAPI.saveConfig({
      port: port.value,
      includeMutating: includeMutating.value
    })
    // 只更新 host（配置片段要跟着新端口走），不回灌本地表单 ——
    // 用户可能正在输入
    if (result?.status) {
      host.value = { ...host.value, ...result.status, settings: result.status.settings }
    }
    // 失焦即落盘是个看不见的动作。不给回执的话，用户改完端口只能干等着，
    // 没法分辨「存好了」和「什么都没发生」；失败时更糟 —— 原来只进 console
    configSaved.value = true
    setTimeout(() => (configSaved.value = false), 2000)
  } catch (error) {
    configError.value = (error as Error).message
  }
}

async function toggleHost(): Promise<void> {
  if (hostBusy.value || (portError.value && !host.value.running)) return
  const wasRunning = host.value.running
  hostBusy.value = true
  try {
    if (wasRunning) {
      applyHost((await mcpServerAPI.stop()).status)
    } else {
      const result = await mcpServerAPI.start({
        includeMutating: includeMutating.value,
        port: port.value
      })
      applyHost(result.status)
      // 刚开启时自动把配置摊开 —— 这时候用户正要去配外部客户端
      if (host.value.running) showConfig.value = true
    }
  } catch (error) {
    // 整条 IPC 挂了也不能把开关锁死在错误状态上
    console.warn('[MCP] 切换对外服务失败:', error)
  } finally {
    hostBusy.value = false
    // 以主进程报的为准，见 refreshHost 的说明
    await refreshHost()
  }
}

/**
 * 换一把新令牌。
 *
 * 明确二次确认：一按下去，所有已经配好这个服务的外部客户端立刻连不上，
 * 得挨个重新粘配置。用户想要的场景是「令牌泄露了」，不该手滑触发。
 */
async function rotateToken(): Promise<void> {
  if (hostBusy.value) return
  if (!window.confirm(t('mcp.server.rotateConfirm'))) return
  hostBusy.value = true
  try {
    applyHost((await mcpServerAPI.rotateToken()).status)
    // 换了新的一把就收回明文：上一次「显示」是针对旧令牌的决定
    revealToken.value = false
  } finally {
    hostBusy.value = false
  }
}

async function copy(what: 'config' | 'token' | 'url' | 'path'): Promise<void> {
  // 复制的永远是完整值，跟屏幕上打没打码无关
  const text =
    what === 'config'
      ? host.value.clientConfig
      : what === 'token'
        ? host.value.settings?.token
        : what === 'url'
          ? host.value.url
          : configPath.value
  if (!text) return
  await navigator.clipboard.writeText(text)
  copied.value = what
  setTimeout(() => (copied.value = ''), 2000)
}

/**
 * 哪几行摊开成编辑态。
 *
 * ## 为什么默认全收起
 *
 * 渐进披露这条原则，上一版在**下半页**守得挺好（端口、令牌、JSON 都折起来了），
 * 上半页却整个漏掉了：每条 server 都把四个输入框 + 两行说明永久摊在屏幕上。
 * 一条 blender 就占掉半屏，两条就是一屏。
 *
 * 可是「改 blender 的启动命令」是一辈子做一两次的事，而**每次进这个页面都是
 * 为了看一眼它通没通**。所以默认态该是一行：名字 + 通没通。要改再展开。
 *
 * 三种情况强制展开，否则会出现「有东西要处理、但看不见」：
 *   - 空行（刚点出来的，收起来就是一行空白，没法填）
 *   - 有错的行（错误信息藏在收起的行里等于没报错）
 *   - 用户自己点开的
 */
const expandedRows = ref(new Set<McpServerFormValue>())

function isExpanded(value: McpServerFormValue): boolean {
  return (
    expandedRows.value.has(value) ||
    isBlankRow(value) ||
    idError(value) !== '' ||
    envError(value) !== ''
  )
}

function toggleRow(value: McpServerFormValue): void {
  // 重新建一个 Set 才会触发更新 —— Set 本身的增删 Vue 的 ref 看不见
  const next = new Set(expandedRows.value)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  expandedRows.value = next
}

/** 在资源管理器里定位 mcp.json。光把路径印出来，用户还得自己去粘 */
async function revealConfig(): Promise<void> {
  if (!configPath.value) return
  try {
    // 返回值必须看：shell:* 失败时是 return {success:false}，不抛 —— 只 warn 等于静默
    const res = await window.api.shell.showItemInFolder(configPath.value)
    if (!res?.success) {
      console.warn('[MCP] 打开配置文件位置失败:', res?.error)
      message.error(`打不开配置文件所在位置：${configPath.value}`, 8)
    }
  } catch (error) {
    console.warn('[MCP] 打开配置文件位置失败:', error)
    message.error(`打不开配置文件所在位置：${configPath.value}`, 8)
  }
}

onMounted(load)
</script>

<template>
  <div class="settings-content">
    <!-- ── 接入第三方 server ─────────────────────────────────── -->
    <!--
      这里不重复标题：页面 Header 已经写着「接入外部 MCP 服务」和同一句描述，
      面板里再来一遍是上一版最刺眼的重复。
    -->
    <section class="settings-section">
      <!--
        一键开启，排在最前面 —— 这是用户在这一屏唯一需要做决定的地方。

        **这块常驻**（除非已经全部开好、且下面的自动发现块接手了 —— 见
        `hideEpicSetup`）。初版做成「没有可操作项目就不渲染」，
        结果是用户什么都看不到、也不知道为什么：没连项目、引擎太老、
        主进程没起来，三种原因长得一模一样，都是一片空白。
        空白不是「没有噪音」，空白是「看起来坏了」。
      -->
      <div v-if="!hideEpicSetup" class="engine-block setup">
        <div class="engine-head">
          <strong>{{ t('mcp.epicSetup.title') }}</strong>
        </div>

        <p v-if="epicLoading" class="engine-hint">{{ t('mcp.epicSetup.loading') }}</p>

        <!-- 主进程报的错原样显示。最常见的是开发时主进程没重启 -->
        <p v-else-if="epicError" class="error">
          {{ t('mcp.epicSetup.failed', { error: epicError }) }}
        </p>

        <!-- 一个项目都没连：这是最常见的「按钮怎么不见了」，必须点破 -->
        <p v-else-if="epicProjects.length === 0" class="engine-hint">
          {{ t('mcp.epicSetup.noProject') }}
        </p>

        <template v-else>
          <div v-for="project in epicActionable" :key="project.connectionId" class="engine-row">
            <code>{{ project.projectName }}</code>
            <AppButton
              variant="primary"
              size="medium"
              :disabled="epicBusy !== ''"
              @click="setupEpic(project)"
            >
              {{
                epicBusy === project.connectionId
                  ? t('mcp.epicSetup.working')
                  : project.state === 'needs-start'
                    ? t('mcp.epicSetup.start')
                    : t('mcp.epicSetup.enable')
              }}
            </AppButton>
          </div>

          <!-- 配好了但没重启：给不了按钮，UE 没法热加载新插件模块 -->
          <div v-for="project in epicPendingRestart" :key="project.connectionId" class="engine-row">
            <code>{{ project.projectName }}</code>
            <span class="status muted">{{ t('mcp.epicSetup.needsRestart') }}</span>
          </div>

          <!-- 引擎太老：点名说出版本号，否则用户只会觉得按钮丢了 -->
          <div v-for="project in epicUnsupported" :key="project.connectionId" class="engine-row">
            <code>{{ project.projectName }}</code>
            <span class="status muted">{{ t('mcp.epicSetup.unsupported') }}</span>
          </div>

          <!--
            已经开好了。绝大多数时候这几行不会出现 —— 自动发现块接手报状态，
            整块就收起来了。它存在只为一种情况：服务确实在跑，但盒子这边
            还没连上（补连失败、或用户把它在 mcp.json 里停用了）。
            那时候什么都不显示，用户看到的就是一片「坏了」。
          -->
          <div v-for="project in epicReady" :key="project.connectionId" class="engine-row">
            <code>{{ project.projectName }}</code>
            <span class="status ok">{{ t('mcp.epicSetup.ready') }}</span>
          </div>
        </template>

        <p v-if="epicMessage" class="engine-hint">{{ epicMessage }}</p>
        <p v-else-if="epicActionable.length > 0" class="engine-hint">
          {{ t('mcp.epicSetup.hint') }}
        </p>
        <!-- 能走到这儿说明引擎那边好了、盒子这边还没接上，得说清下一步 -->
        <p v-else-if="epicReady.length > 0" class="engine-hint">
          {{ t('mcp.epicSetup.readyHint') }}
        </p>
      </div>

      <!--
        引擎自动发现来的那条排在最前面，且**只读**。
        它不在 mcp.json 里，做成可编辑行只会让用户去找一个改不动的配置项。

        好好跑着的时候收成一行：这块用户什么都不用做，摊开五行只是在占地方。
        一旦连不上就强制摊开 —— 那时候里面有原因要看、有按钮要点。
      -->
      <div v-if="engineStatuses.length > 0" class="engine-block discovered">
        <div class="engine-head">
          <button class="row-toggle" @click="showEngine = !showEngine">
            <span class="caret" :class="{ open: engineOpen }">›</span>
            <strong>{{ t('mcp.engine.title') }}</strong>
          </button>
          <span class="status muted">{{ t('mcp.engine.readOnly') }}</span>
          <!-- 收起的那一行必须自己说清楚里面是好是坏 -->
          <span v-if="engineSummary" class="status" :class="engineSummary.tone">
            {{ engineSummary.label }}
          </span>
        </div>

        <template v-if="engineOpen">
          <p class="engine-desc">{{ t('mcp.engine.description') }}</p>

          <div v-for="status in engineStatuses" :key="status.id" class="engine-entry">
            <div class="engine-row">
              <code>{{ status.id }}</code>
              <!--
                连上时不能报「3 个工具」。上面刚说完「约 900 个」，
                旁边一个「3 个工具」的绿标签，看起来就是没接全 ——
                这是真实被问过的一句「怎么只有三个工具」。
                这里说清楚 3 是**入口**，不是能力总数。
              -->
              <span v-if="status.connected" class="status ok" :title="t('mcp.engine.twoTier')">
                {{ t('mcp.engine.connected', { count: status.toolCount }) }}
              </span>
              <span v-else class="status" :class="chipOf(status.id)!.tone">
                {{ chipOf(status.id)!.label }}
              </span>
            </div>
            <!--
              原因写出来，不放 tooltip。一条「连接失败」不带原因，用户能做的只有
              瞪着它；而原因常常一句话就说清了（`ECONNREFUSED 127.0.0.1:30069`），
              是这一屏信息量最大的一行字。
            -->
            <p v-if="errorOf(status.id)" class="row-error">{{ errorOf(status.id) }}</p>
          </div>

          <!-- 重试放在看到问题的地方。好好跑着的时候不给按钮：没什么可重试的 -->
          <div v-if="engineFailed" class="actions">
            <AppButton variant="primary" size="medium" :disabled="reconnecting" @click="reconnect">
              {{ reconnecting ? t('mcp.engine.retrying') : t('mcp.engine.retry') }}
            </AppButton>
          </div>

          <!--
            两层结构讲在正文里，不能只放进 tooltip —— 会问「怎么只有三个」的人不会去悬停。
            但**只在真连上时讲**：连接失败的时候屏幕上没有那个「3」，
            再解释一遍「每个入口包含多种操作」就是纯噪音，还盖住了真正的问题。
          -->
          <p v-if="engineStatuses.some((s) => s.connected)" class="engine-hint">
            {{ t('mcp.engine.twoTier') }}
          </p>
          <p class="engine-hint">{{ t('mcp.engine.hint') }}</p>
        </template>
      </div>

      <!--
        手动配置的那几条要有自己的小标题。
        下半页有「共享虚幻引擎能力」，上半页却什么都没有，blender 那条就直接
        裸在页面上 —— 用户分不清哪块是盒子自动接的、哪块是自己配的。
        页面 Header 说的是整页（含两节），顶不了这一块的标题。
      -->
      <h4 class="section-title">{{ t('mcp.client.manualTitle') }}</h4>

      <div
        v-for="(server, index) in servers"
        :key="index"
        class="server-row"
        :class="{ draft: isDraftRow(server), open: isExpanded(server) }"
      >
        <!--
          收起态：一行就够 —— 名字 + 通没通 + 删除。

          **这是这一屏最大的一处减法。** 每次进这个页面都是为了看一眼服务通没通，
          而「改 blender 的启动命令」是一辈子做一两次的事；原来却把四个输入框
          和两行说明永久摊着，一条 server 占掉半屏。
        -->
        <div class="row-summary">
          <button class="row-toggle" @click="toggleRow(server)">
            <span class="caret" :class="{ open: isExpanded(server) }">›</span>
            <code>{{ server.id.trim() || t('mcp.client.newServer') }}</code>
          </button>

          <!--
            停用的 server 也会带一条状态回来（agent 要能区分「停用」和「没配过」），
            所以这里必须分开显示：把用户自己关掉的东西报成「连接失败」，
            只会让人去排查一个根本不存在的故障。
          -->
          <span v-if="chipOf(server.id)" class="status" :class="chipOf(server.id)!.tone">
            {{ chipOf(server.id)!.label }}
          </span>

          <!-- 没存过的那条要说出来，否则和正在跑的配置长得一模一样 -->
          <span v-else-if="isDraftRow(server)" class="status muted">
            {{ t('mcp.status.unsaved') }}
          </span>

          <!--
            删除推到最右。原来它紧挨着绿色的状态胶囊 —— 破坏性动作贴着状态信息，
            眼睛扫状态的时候手就在删除上。
          -->
          <AppButton
            class="remove"
            variant="soft"
            size="medium"
            danger
            @click="removeServer(index)"
          >
            {{ t('mcp.actions.remove') }}
          </AppButton>
        </div>

        <!--
          连不上的原因常驻显示，不放 tooltip。收起态下这是唯一能让用户知道
          「为什么不通」的东西 —— 一条光秃秃的「连接失败」，他能做的只有瞪着它。
        -->
        <p v-if="errorOf(server.id)" class="row-error">{{ errorOf(server.id) }}</p>

        <div v-if="isExpanded(server)" class="row-main">
          <label class="field id-field">
            <span>{{ t('mcp.fields.id') }}</span>
            <input ref="idInputs" v-model="server.id" type="text" placeholder="filesystem" />
            <small v-if="idError(server)" class="error">{{ idError(server) }}</small>
          </label>

          <label class="field">
            <span>{{ t('mcp.fields.transport') }}</span>
            <select v-model="server.transport">
              <option value="stdio">{{ t('mcp.fields.stdio') }}</option>
              <option value="http">{{ t('mcp.fields.http') }}</option>
            </select>
          </label>

          <!--
            启动命令用 textarea 而不是单行 input。
            实际的命令是一长串绝对路径（`…\UnrealBox\BlenderMcp\4309a396\venv\Scri…`），
            单行框只能看到开头，用户想核对路径对不对只能把光标拖到底。
            反倒是环境变量给了三行 —— 两者本该反过来。
            `parseCommandLine` 按空白切词，换行本来就吃得下。
          -->
          <label v-if="server.transport === 'stdio'" class="field grow">
            <span>{{ t('mcp.fields.command') }}</span>
            <textarea
              v-model="server.commandLine"
              class="command-input"
              rows="2"
              spellcheck="false"
              :title="server.commandLine"
              placeholder="npx -y @modelcontextprotocol/server-filesystem D:/assets"
            ></textarea>
          </label>

          <label v-else class="field grow">
            <span>{{ t('mcp.fields.url') }}</span>
            <input v-model="server.url" type="text" placeholder="https://example.com/mcp" />
          </label>
        </div>

        <!--
          环境变量。
          常驻显示而不是折在「高级」后面 —— 有些 server 没有它根本不工作，
          而缺了之后的症状是「连上了、工具也在、一调就失败」，
          用户不会想到去展开一个折叠区找原因。Blender 的 BLENDER_PATH 就是这样。
        -->
        <label v-if="isExpanded(server) && server.transport === 'stdio'" class="field env-field">
          <span>{{ t('mcp.fields.env') }}</span>
          <textarea
            v-model="server.env"
            rows="3"
            spellcheck="false"
            :placeholder="t('mcp.fields.envPlaceholder')"
          ></textarea>
          <small v-if="envError(server)" class="error">{{ envError(server) }}</small>
          <small v-else class="hint">{{ t('mcp.fields.envHint') }}</small>
        </label>

        <!-- 「停用」是改配置，跟着编辑态走；状态和删除留在收起的那一行上 -->
        <div v-if="isExpanded(server)" class="row-side">
          <AppCheckbox v-model:checked="server.disabled" class="checkbox">
            {{ t('mcp.fields.disabled') }}
          </AppCheckbox>
        </div>
      </div>

      <p v-if="servers.length === 0" class="empty">{{ t('mcp.client.empty') }}</p>

      <!-- 一条都没有时只给「添加」—— 没东西可保存，也没东西可重连 -->
      <div class="actions">
        <AppButton variant="soft" size="medium" @click="addServer">
          {{ t('mcp.actions.add') }}
        </AppButton>
        <template v-if="servers.length > 0">
          <AppButton
            variant="primary"
            size="medium"
            :disabled="hasErrors || saving"
            :title="saveBlockedReason"
            @click="save"
          >
            {{ saving ? t('mcp.actions.saving') : t('mcp.actions.save') }}
          </AppButton>
          <AppButton
            variant="soft"
            size="medium"
            :disabled="saving || reconnecting"
            @click="reconnect"
          >
            {{ reconnecting ? t('mcp.engine.retrying') : t('mcp.actions.reconnect') }}
          </AppButton>
          <!-- 上半页是「改完要点保存」，下半页的端口是失焦即落盘。至少让这半页看得见 -->
          <span v-if="isDirty && !hasErrors" class="dirty-flag">{{ t('mcp.client.unsaved') }}</span>
        </template>
      </div>

      <!--
        禁用的按钮要说出原因。出错那行可能已经滚出视野，用户看到的只是
        一个灰掉、点不动、不解释的主按钮。
      -->
      <p v-if="saveBlockedReason" class="error">{{ saveBlockedReason }}</p>
      <p v-if="saveError" class="error">{{ saveError }}</p>

      <!-- 路径光印出来没用，用户还得自己选中再粘。给两个能点的动作 -->
      <p v-if="configPath" class="path" :title="configPath">
        <span>{{ t('mcp.client.configPath', { path: configPath }) }}</span>
        <button class="link" @click="revealConfig">{{ t('mcp.actions.reveal') }}</button>
        <button class="link" @click="copy('path')">
          {{ copied === 'path' ? t('mcp.server.copied') : t('mcp.actions.copyPath') }}
        </button>
      </p>
    </section>

    <!-- ── 对外暴露虚幻引擎能力 ──────────────────────────────── -->
    <section class="settings-section host">
      <h4 class="section-title">{{ t('mcp.server.title') }}</h4>

      <div class="settings-list">
        <!-- 第一层：只有开关和一行说明 -->
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ t('mcp.server.label') }}</div>
            <div class="setting-desc">{{ t('mcp.server.shortNote') }}</div>
          </div>
          <AppSwitch
            :checked="host.running"
            :disabled="hostBusy || (!host.running && !!portError)"
            @change="toggleHost"
          />
        </div>

        <p v-if="host.error" class="error">{{ host.error }}</p>

        <!--
          运行中才有状态行。停着的时候一个字都不多说。

          不再用 `setting-item`：那是个两端对齐的布局，而这一行右边没有任何控件，
          于是整块歪在左边，和上面开关那行的节奏对不上。
        -->
        <div v-if="host.running" class="running-row">
          <div class="setting-label">
            <span class="dot"></span>
            {{ t('mcp.server.running', { count: host.exposedTools }) }}
          </div>
          <div class="setting-desc url-line">
            <span>{{ host.url }}</span>
            <button class="link" @click="copy('url')">
              {{ copied === 'url' ? t('mcp.server.copied') : t('mcp.actions.copyPath') }}
            </button>
          </div>
          <!--
            同一页三个「工具数」：146（这里）、26（blender）、3 个入口（引擎），
            口径各不相同。不说清楚用户就会拿它们互相对账然后觉得哪里漏了 ——
            「怎么只有三个工具」已经被真实问过一次。
          -->
          <div class="setting-desc">{{ t('mcp.server.toolsNote') }}</div>
        </div>

        <!--
          「连接配置」不跟着运行状态走。
          端口和令牌是持久化的，停着也算得出来，而用户的典型顺序恰恰是
          **先把配置粘进 Claude Code，再回来开服务** —— 上一版把这个入口
          藏在 `v-if="host.running"` 里面，服务没开时根本够不着复制按钮。
        -->
        <button class="disclosure" @click="showConfig = !showConfig">
          <span class="caret" :class="{ open: showConfig }">›</span>
          {{ t('mcp.server.clientConfig') }}
        </button>

        <!-- 第二层：粘给外部客户端的东西。配一次就不用再看 -->
        <div v-if="showConfig" class="drawer">
          <p class="hint">{{ t('mcp.server.clientHint') }}</p>
          <!--
            这块里的令牌**也**要打码。下面那行头尾打码原来完全是白做的：
            同一把令牌一字不差地印在这儿，字号还更大。屏幕上多一个人、
            或者正在录屏共享，泄露的是这一块。复制拿到的始终是完整值。
          -->
          <pre class="config"><code>{{ displayedConfig }}</code></pre>
          <div class="actions">
            <AppButton variant="primary" size="medium" @click="copy('config')">
              {{ copied === 'config' ? t('mcp.server.copied') : t('mcp.server.copyConfig') }}
            </AppButton>
            <code class="token" :title="t('mcp.server.tokenMasked')">{{ maskedToken }}</code>
            <AppButton variant="soft" size="medium" @click="revealToken = !revealToken">
              {{ revealToken ? t('mcp.server.hideToken') : t('mcp.server.showToken') }}
            </AppButton>
            <AppButton variant="soft" size="medium" @click="copy('token')">
              {{ copied === 'token' ? t('mcp.server.copied') : t('mcp.server.copyToken') }}
            </AppButton>
            <AppButton
              variant="soft"
              size="medium"
              danger
              :disabled="hostBusy"
              @click="rotateToken"
            >
              {{ t('mcp.server.rotate') }}
            </AppButton>
          </div>
          <p class="hint">{{ t('mcp.server.autoStartHint') }}</p>
        </div>

        <!--
          第三层：端口和权限档。

          ## 权限档回到折叠区里，但标题要点名

          上一版把它提到了主开关同层，理由是「不能把风险藏进『高级』」。
          **那个理由只对了一半**：真正的毛病是「高级」这两个字不预告里面有什么，
          而不是它折起来了 —— 位置不是问题，标签才是。提上来之后第一屏多了一整块
          两行的设置项，而 99% 的访问根本不需要动它，这就又违背了整页的渐进披露。

          所以折回去，但标题直接写「端口和权限」，并且**把当前档位写在标题上**：
          不展开也看得见现在是只读还是可写。风险照样在明面上，第一屏少一块。
        -->
        <button class="disclosure" @click="showAdvanced = !showAdvanced">
          <span class="caret" :class="{ open: showAdvanced }">›</span>
          {{ t('mcp.server.advanced') }}
          <span class="scope-tag" :class="{ writable: includeMutating }">
            {{
              includeMutating ? t('mcp.server.scopeTagWritable') : t('mcp.server.scopeTagReadOnly')
            }}
          </span>
        </button>

        <div v-if="showAdvanced" class="drawer">
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">{{ t('mcp.server.includeMutating') }}</div>
              <div class="setting-desc">
                {{
                  includeMutating ? t('mcp.server.scopeWritable') : t('mcp.server.scopeReadOnly')
                }}
              </div>
            </div>
            <AppSwitch
              v-model:checked="includeMutating"
              :disabled="host.running"
              :title="host.running ? t('mcp.server.stopToChange') : ''"
              @change="persistConfig"
            />
          </div>

          <!--
            长警告只在**风险真的变了**的时候出现。常驻的警告等于没有警告 ——
            用户第三次进这个页面就不看了。

            分现在时/将来时两句：服务停着的时候说「写操作会直接执行」，
            讲的是一件此刻并没有在发生的事，而屏幕上主开关明明是关的。
          -->
          <p v-if="includeMutating" class="warning">
            {{ host.running ? t('mcp.server.securityNote') : t('mcp.server.securityNoteIdle') }}
          </p>

          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">{{ t('mcp.server.port') }}</div>
              <!--
                描述里不再写「更改前请先停止服务」：控件在运行时本来就 disabled，
                点不动的原因没必要每次都读一遍。真去点的时候用 title 说。
              -->
              <div class="setting-desc">{{ t('mcp.server.portDesc') }}</div>
            </div>
            <input
              v-model.number="port"
              class="threshold-input"
              type="number"
              :disabled="host.running"
              :title="host.running ? t('mcp.server.stopToChange') : ''"
              min="1024"
              @blur="persistConfig"
              @keyup.enter="persistConfig"
            />
          </div>
          <p v-if="portError" class="error">{{ portError }}</p>
          <!-- 失焦即落盘是看不见的动作，成败都要有回执 -->
          <p v-else-if="configError" class="error">{{ configError }}</p>
          <p v-else-if="configSaved" class="hint">{{ t('mcp.server.configSaved') }}</p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
  color: var(--color-text-primary);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.section-title {
  margin: 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

.settings-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.setting-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.setting-desc {
  font-size: 12px;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}

/* 运行中的状态块。右边没有控件，所以不能用两端对齐的 setting-item */
.running-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.url-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* 运行中的绿点。一眼看到状态，不用读文字 */
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-success-solid);
  box-shadow: 0 0 6px var(--color-success-border);
}

/* ── 折叠区 ─────────────────────────────────────────────── */
/*
 * 收起来的时候，这两条原来只有一个淡淡的 `›` 加 muted 字色、行高和正文一样，
 * 看着像一句禁用的说明文字而不是能点的控件。给它内边距、hover 底色和
 * 更清楚的字色 —— 能点的东西要看起来能点。
 */
.disclosure {
  align-self: flex-start;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease-in-out;
}

.disclosure:hover {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
}

.disclosure .caret {
  color: var(--color-text-muted);
  font-size: 14px;
}

/* 当前权限档写在折叠标题上：不展开也看得见现在是只读还是可写 */
.scope-tag {
  padding: 1px 6px;
  border-radius: 9999px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-muted);
  font-size: 11px;
}

.scope-tag.writable {
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
}

.caret {
  display: inline-block;
  transition: transform 0.15s ease-in-out;
}

.caret.open {
  transform: rotate(90deg);
}

.drawer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface-hover);
}

/* ── 客户端配置 ──────────────────────────────────────────── */
.config {
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface-hover);
  font-size: 11px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre;
}

.token {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  font-size: 11px;
  text-align: center;
}

/* ── 第三方 server 行 ────────────────────────────────────── */
.server-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface-hover);
}

/*
 * 没存过的那条。原来它和正在跑的配置长得一模一样 —— 一条已连接生效、
 * 一条还只是草稿，视觉权重却完全相同，用户分不出哪条在跑。
 */
.server-row.draft {
  border-style: dashed;
  background: none;
}

/*
 * 收起态那一行：名字 + 通没通 + 删除。
 * 这是每次进页面都会看到的默认形态，所以它必须能一眼读完。
 */
.row-summary {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.row-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-primary);
  font-size: 13px;
  cursor: pointer;
}

.row-toggle code {
  font-size: 13px;
}

.row-toggle:hover {
  color: var(--color-accent-text, var(--color-text-primary));
}

/* 破坏性动作推到最右，别贴着状态胶囊 */
.row-summary .remove {
  margin-left: auto;
}

/* 展开之后才和上面那行拉开距离 */
.server-row.open .row-main {
  margin-top: var(--space-2);
}

.row-main {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.row-side {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: 12px;
  color: var(--color-text-muted);
}

.field.grow {
  flex: 1;
  min-width: 260px;
}

.id-field {
  width: 160px;
}

input[type='text'],
select,
textarea {
  padding: 4px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  font-size: 12px;
}

input[type='text']:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--color-accent-border);
}

/*
 * 占位符要比真实内容淡得足够多。
 * 原来只差一档，新加的空行看起来像已经预填好了 —— 尤其 env 的示例
 * 跟上面 blender 那条真配置长得一样，像「复制了一份」。
 */
input::placeholder,
textarea::placeholder {
  color: var(--color-text-disabled);
}

/* 环境变量是逐行的键值对，等宽字体下对齐才看得出哪一行写歪了 */
.env-field textarea {
  width: 100%;
  resize: vertical;
  font-family: var(--font-mono, ui-monospace, monospace);
  line-height: 1.5;
}

/* 启动命令是一长串绝对路径，单行框只能看见开头 */
.command-input {
  width: 100%;
  resize: vertical;
  font-family: var(--font-mono, ui-monospace, monospace);
  line-height: 1.5;
}

.checkbox {
  align-items: center;
  font-size: 12px;
  color: var(--color-text-muted);
}

.status {
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
}

.status.ok {
  background: var(--color-success-bg);
  color: var(--color-success-text);
}

.status.bad {
  background: var(--color-danger-bg);
  color: var(--color-danger-text);
}

.status.muted {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-muted);
}

/* ── 引擎自动发现（只读）──────────────────────────────────── */
.engine-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  /* 比可编辑行更淡：它不是用户能操作的东西，不该抢注意力 */
  background: var(--color-bg-surface-hover);
}

.engine-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
}

/* 好好跑着的时候这块收成一行，状态胶囊靠右，和下面的 server 行对齐 */
.engine-head .status:last-child {
  margin-left: auto;
}

.engine-desc,
.engine-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.engine-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.engine-row code {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.engine-entry {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

/*
 * 连不上的原因。
 * 等宽 + 可换行：这里放的是 `spawn npx ENOENT` 这种原文，
 * 截断了就等于没说；换行难看也比看不全强。
 */
.row-error {
  margin: 0;
  padding-left: var(--space-5);
  color: var(--color-danger-text);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* 一键那块是要用户动手的，比只读的发现块显眼一档 */
.engine-block.setup {
  border-color: var(--color-accent-border);
  background: var(--color-accent-bg);
}

/* ── 通用 ────────────────────────────────────────────────── */
.actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.hint,
.empty,
.path {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.path {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.path > :first-child,
.url-line > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 行内的小动作。路径、URL 光印出来没用，用户还得自己选中再粘 */
.link {
  flex: none;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-accent-text, var(--color-text-secondary));
  font-size: 12px;
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

/* 改了没存要看得见 —— 这半页是「点保存」，下半页的端口是失焦即落盘 */
.dirty-flag {
  color: var(--color-warning-text);
  font-size: 12px;
}

.error {
  margin: 0;
  color: var(--color-danger-text);
  font-size: 12px;
}

.warning {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--color-warning-border);
  border-radius: 0 4px 4px 0;
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
  font-size: 12px;
  line-height: 1.6;
}

/* ── Toggle（与其他设置页一致）───────────────────────────── */
.threshold-input {
  width: 80px;
  padding: 4px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  font-size: 12px;
  text-align: center;
}

.threshold-input:focus {
  outline: none;
  border-color: var(--color-accent-border);
}

.threshold-input:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}
</style>
