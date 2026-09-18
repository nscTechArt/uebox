#!/usr/bin/env node
/**
 * 文档站截图采集。
 *
 * 手册里的每一张图都必须是**真的**：同一个版本、同一套主题、同一个尺寸，
 * 从真正跑起来的应用里拍出来，而不是画的、拼的或者从别处翻出来的旧图。
 * 手动截图做不到这三件事 —— 窗口大小每次都差几像素，主题跟着当天心情走，
 * 改一版界面就得人肉重拍三十张。
 *
 * 做法沿用 scripts/verify-offline-boot.mjs 那套：
 *   - 起打包产物，独立的 --user-data-dir（不碰用户数据，也不读他的密钥）
 *   - UA_DISABLE_SINGLE_INSTANCE_LOCK=1（用户自己开着盒子也能跑）
 *   - CDP 裸 WebSocket 驱动，Emulation.setDeviceMetricsOverride 钉死尺寸
 *
 * 顺带把工具清单和技能清单 dump 成 JSON —— 手册里那两页要照着真实注册表写，
 * 从源码反推会漏（工具是运行时按会话状态过滤的）。
 *
 * 用法：
 *   node scripts/capture-docs-shots.mjs                  # 全量
 *   node scripts/capture-docs-shots.mjs --only settings  # 只拍 id 含 settings 的
 *   node scripts/capture-docs-shots.mjs --list           # 只列清单不启动
 *
 * 产物：
 *   website/public/shots/*.png     手册直接引用
 *   website/public/shots/manifest.json
 *   docs/screenshot-inventory.json 工具/技能等结构化 dump，写文档时当底稿
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  copyFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { packagedAppPaths } from './packaged-app-paths.mjs'
import { buildWorkspace, defaultWorkspace, seedSteps } from './docs-mock-data.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 所有截图的统一画布。
 *
 * 1600×1000 是定下来的唯一尺寸，改它等于整套图全部作废重拍。
 * 选这个数的理由：16:10 和应用窗口的自然比例一致，不会出现被拉扁的侧边栏；
 * VitePress 正文列宽约 688px，1600px 宽的图在 2x 屏上仍然是清晰的。
 * deviceScaleFactor 保持 1 —— 2 会让每张图涨到 1MB 以上，
 * 三十多张图进 git 就是几十兆，而正文里根本用不到那个密度。
 */
const VIEWPORT = Object.freeze({ width: 1600, height: 1000, deviceScaleFactor: 1 })

/** 拍照前的固定环境：中文、深色。不锁死的话拍出来的图一半浅一半深 */
const SEED_SCRIPT = `
  localStorage.setItem('locale', 'zh-CN')
  localStorage.setItem('app-theme', 'dark')
  'seeded'
`

/**
 * 截图清单。
 *
 * 每一条：
 *   id       文件名（不含扩展名），也是手册里引用的路径 /shots/<id>.png
 *   page     这张图归哪一页手册用。只在清单里做索引，不影响拍摄
 *   route    vue-router 的目标路径
 *   caption  这张图里有什么 —— 会写进 manifest，是「落档」的那份说明
 *   prepare  可选，导航后、截图前跑的 JS（点开某个弹窗、滚到某处）
 *   settle   可选，等待毫秒数，默认 2200
 */
const SHOTS = Object.freeze([
  // ── 主界面。路由取自 src/renderer/src/router/modules/mainRoutes.ts ──
  {
    id: 'home-projects',
    page: 'guide/projects',
    route: '/',
    caption: '项目库：上方引擎版本，下方我的项目'
  },
  {
    id: 'assistant-welcome',
    page: 'guide/assistant',
    route: '/dev-assistant',
    caption: 'AI 会话首屏（未开始对话）'
  },
  {
    id: 'asset-library',
    page: 'guide/asset-library',
    route: '/asset-management',
    caption: '资产库主界面'
  },
  {
    // 根目录只有文件夹。素材网格和缩略图要进到某个文件夹里才拍得到
    id: 'asset-library-grid',
    page: 'guide/asset-organize',
    route: '/asset-management?folderKey=demo_textures',
    caption: '资产库：贴图文件夹里的素材网格'
  },
  {
    id: 'asset-library-details',
    page: 'guide/asset-organize',
    route: '/asset-management?folderKey=demo_textures',
    // 详情面板要选中一份资产才有内容。点第一张卡，点不到就拍没选中的样子
    prepare: `(() => {
      const item = document.querySelector('.file-item.asset-item')
      if (!item) return 'no-asset-item'
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 'clicked'
    })()`,
    prepareSettle: 1500,
    caption: '资产库：选中一份资产后的详情面板'
  },
  {
    // 新建资产库对话框。三种模式（引用 / 复制归档 / 网络协作）在这一屏里，
    // 手册讲保管库那一节全靠它。要两步：先展开左上角的库切换器，再点「新建资产库」
    id: 'vault-create-modal',
    page: 'guide/asset-library',
    route: '/asset-management',
    prepare: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const trigger = document.querySelector('.vault-switcher .vault-current')
      if (!trigger) return 'no-switcher'
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(700)
      const items = [...document.querySelectorAll('.vault-action-item')]
      const create = items.find((el) => /新建|创建/.test(el.textContent || ''))
      if (!create) return 'no-create-item:' + items.length
      create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(900)
      return document.querySelector('.mode-card') ? 'modal-open' : 'modal-missing'
    })()`,
    prepareSettle: 1200,
    caption: '新建资产库：引用原有文件 / 复制并归档 / 网络协作库'
  },
  {
    // 网络协作库那一档展开后是两个页签（SMB 共享 / 资产服务器）。
    // 团队协作那一页讲的就是这两条路怎么填
    id: 'vault-create-network',
    page: 'guide/asset-team',
    route: '/asset-management',
    prepare: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const trigger = document.querySelector('.vault-switcher .vault-current')
      if (!trigger) return 'no-switcher'
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(700)
      const create = [...document.querySelectorAll('.vault-action-item')]
        .find((el) => /新建|创建/.test(el.textContent || ''))
      if (!create) return 'no-create-item'
      create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(900)
      const network = document.querySelector('.mode-card.network-card')
      if (!network) return 'no-network-card'
      network.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(800)
      return 'network-selected'
    })()`,
    prepareSettle: 1400,
    caption: '新建资产库 → 网络协作库：SMB 共享与资产服务器两条路'
  },
  {
    id: 'asset-dependency-graph',
    page: 'guide/asset-organize',
    route: '/asset-management/dependency-graph',
    caption: '资产依赖关系图'
  },
  {
    id: 'blueprint-library',
    page: 'guide/snippets',
    route: '/blueprint-library',
    caption: '蓝图库画廊视图'
  },
  {
    id: 'material-library',
    page: 'guide/snippets',
    route: '/material-library',
    caption: '材质库画廊视图'
  },
  { id: 'note-editor', page: 'guide/notebook', route: '/note-editor', caption: '笔记编辑器' },
  { id: 'notebooks', page: 'guide/notebook', route: '/notebooks', caption: '知识库列表' },
  { id: 'aigc-studio', page: 'guide/aigc', route: '/aigc-studio', caption: 'AI 创作（生图）' },
  {
    id: 'model-viewer',
    page: 'guide/model3d',
    route: '/model-3d-viewer',
    caption: '3D 查看器空状态'
  },
  {
    // 查看器支持 ?filePath= 直接开一个文件（Model3DViewer/index.vue 读的就是它）。
    // 用播种时生成的那个 OBJ —— 真模型，不花钱
    id: 'model-viewer-loaded',
    page: 'guide/model3d',
    route: '/model-3d-viewer?filePath={{workspace}}/Assets/Meshes/SM_Boulder_01.obj',
    settle: 4000,
    caption: '3D 查看器：加载了一个模型，右侧是模型详情'
  },
  {
    id: 'model-viewer-wireframe',
    page: 'guide/model3d',
    route: '/model-3d-viewer?filePath={{workspace}}/Assets/Meshes/SM_Boulder_01.obj',
    settle: 4000,
    // 显示模式挂在 pinia 的 model3DViewer store 上，直接调它自己的 action
    prepare: `(() => {
      const app = document.querySelector('#app')
      const pinia = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$pinia
      const store = pinia && pinia._s && pinia._s.get('model3DViewer')
      if (!store || typeof store.setViewMode !== 'function') return 'no-store'
      store.setViewMode('wireframe')
      return 'wireframe'
    })()`,
    prepareSettle: 1500,
    caption: '3D 查看器：线框模式'
  },
  {
    id: 'server-management',
    page: 'guide/asset-server',
    route: '/server-management',
    caption: '资产节点管理'
  },

  // ── 设置各页 ──
  ...[
    ['general', '常规：开机自启与通知'],
    ['appearance', '外观：语言、主题、动效'],
    ['shortcuts', '快捷键清单'],
    ['ai', 'AI 助手：对话行为与隐私'],
    ['personalization', '个性化：给助手的常驻说明'],
    ['models', '模型：服务商与默认模型'],
    ['mcp', 'MCP：接入第三方与对外开放'],
    ['skills', '技能清单'],
    ['tools', '工具清单与工具搜索开关'],
    ['usage', '用量统计'],
    ['project', '项目库设置'],
    ['plugin', '插件：连接状态与自动安装'],
    ['cli', '命令行：程序位置与 PATH'],
    ['asset', '资产库设置'],
    ['notebook', '知识库设置'],
    ['namingRules', '命名规则四张表'],
    ['voice', '语音设置'],
    // 这一项不是设置页，是录制文件库（全宽视图）
    ['screenRecorder', '录屏：录制文件库'],
    ['about', '关于：版本与检查更新']
  ].map(([tab, caption]) => ({
    id: `settings-${tab.toLowerCase()}`,
    page: 'guide/settings',
    route: `/preferences?tab=${tab}`,
    caption: `设置 → ${caption}`
  }))
])

/**
 * 对话正文那几张，只在 `--with-ai` 时拍。
 *
 * 和上面那批分开的原因不是麻烦，是**这一轮会带着本机的模型凭据跑**：
 * 同一次运行里再去拍「设置 → 模型」，就会把本机配了哪几家服务商发进手册。
 * 两批各跑各的，凭据只在这一批的临时目录里出现过。
 */
const AI_SHOTS = Object.freeze([
  {
    id: 'ai-conversation',
    page: 'guide/assistant',
    // 不导航：对话跑完之后应用已经停在那条会话上，再 push 一次会退回欢迎页
    route: null,
    // 跑完会停在最底下，而手册要的是「提问 → 工具调用 → 回答」的开头。
    // 滚回第一条用户消息
    prepare: `(() => {
      const first = document.querySelector('.user-bubble-row')
      if (!first) return 'no-user-bubble'
      first.scrollIntoView({ block: 'start' })
      return 'scrolled-top'
    })()`,
    prepareSettle: 1200,
    caption: '一轮真实对话：提问、工具调用、开始作答',
    settle: 1000
  },
  {
    id: 'ai-tool-call',
    page: 'guide/assistant',
    route: null,
    // 过程日志默认折叠成一条。点 .process-header 展开，才拍得到工具名、参数和返回值。
    // 选择器取自 AgentProcessLog.vue —— 按文字找匹配不到，那一条是图标 + 时长
    prepare: `(() => {
      const headers = [...document.querySelectorAll('.agent-process-log .process-header')]
      if (headers.length === 0) return 'no-process-header'
      let opened = 0
      for (const header of headers) {
        if (header.getAttribute('aria-expanded') !== 'true') {
          header.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          opened += 1
        }
      }
      headers[0].scrollIntoView({ block: 'start' })
      return 'opened:' + opened + '/' + headers.length
    })()`,
    prepareSettle: 1500,
    caption: '展开后的工具调用：工具名、参数、返回值',
    settle: 1000
  },
  {
    id: 'ai-answer',
    page: 'guide/assistant',
    route: null,
    // 回答尾部：token 用量和追问建议都在这儿
    prepare: `(() => {
      const bubbles = document.querySelectorAll('.user-bubble-row')
      const log = document.scrollingElement || document.documentElement
      const last = document.querySelector('[class*="token"], [class*="usage"]')
      if (last) { last.scrollIntoView({ block: 'end' }); return 'scrolled-usage' }
      log.scrollTop = log.scrollHeight
      return 'scrolled-bottom:' + bubbles.length
    })()`,
    prepareSettle: 1200,
    caption: '回答末尾：token 用量与追问建议',
    settle: 1000
  }
])

/**
 * 生成结果那几张，只在 `--with-gen` 时拍。
 *
 * 和对话批再分开一次：一次生图按次向厂商收费，比一轮对话贵一个量级。
 * 常规批天天重拍没关系，这一批要有人按下才跑。
 */
const GEN_SHOTS = Object.freeze([
  {
    id: 'aigc-generating',
    page: 'guide/aigc',
    route: null,
    caption: 'AI 创作：任务提交后，右侧历史里的生成中状态',
    settle: 800
  },
  {
    id: 'aigc-result',
    page: 'guide/aigc',
    route: null,
    caption: 'AI 创作：生成完成，左侧参数、中间大图、右侧历史',
    settle: 800
  }
])

/**
 * 引擎连着才有的那几张，只在 `--with-engine` 时拍。
 *
 * 「本轮改动」「审查改动」「让它自证」这三样是这个产品最核心的设计，而它们
 * **只在助手真的动过引擎之后才存在** —— 示例数据造不出来，必须有一个 UE 编辑器
 * 连着，并且真跑一轮写操作。
 *
 * 用的是一次性试验工程（`--ue-project`），不碰任何真实工程。
 */
const ENGINE_SHOTS = Object.freeze([
  {
    // 顺序有讲究：这两张 route 为 null，拍的是「跑完之后停在哪儿」。
    // 设置页那张放最后 —— 先跳去设置就把会话顶掉了（第一次就这么翻的车）
    id: 'engine-changes',
    page: 'guide/assistant',
    route: null,
    // 「本轮改动」是 AIBubble 里的 .response-changes-header（选择器取自那个组件，
    // 按文字找匹配不到 —— 标题里还带着计数和折叠箭头）
    prepare: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const headers = [...document.querySelectorAll('.response-changes-header')]
      if (headers.length === 0) return 'no-changes-block'
      for (const el of headers) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await wait(350)
      }
      headers[headers.length - 1].scrollIntoView({ block: 'center' })
      return 'changes:' + headers.length
    })()`,
    prepareSettle: 1500,
    caption: '本轮改动：这一轮在引擎里动了什么',
    settle: 1000
  },
  {
    id: 'engine-review',
    page: 'guide/assistant',
    route: null,
    // 点「审查改动」（.response-review-run），它去引擎里核实，
    // 然后自动接一条「让它自证」。两段都要等
    prepare: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const btn = document.querySelector('.response-review-run')
      if (!btn) return 'no-review-button'
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // 机器核实那一段通常十几秒，自证那一段是模型再跑一轮
      await wait(45000)
      // 停在审查结论那一行（机器查出什么 + 「已让它自证 ↓」），
      // 自证正文另拍一张
      const box = document.querySelector('.response-review')
      if (box) box.scrollIntoView({ block: 'center' })
      return 'reviewed'
    })()`,
    prepareSettle: 4000,
    caption: '审查改动：机器去引擎里核实后的结论',
    settle: 1000
  },
  {
    id: 'engine-selfcheck',
    page: 'guide/assistant',
    route: null,
    // 自证的正文是审查之后模型自己发的那一条，在最底下
    prepare: `(() => {
      const log = document.scrollingElement || document.documentElement
      log.scrollTop = log.scrollHeight
      return 'bottom'
    })()`,
    prepareSettle: 1200,
    caption: '让它自证：逐条回应机器查出的问题，并说清哪里没做到、哪里是自己加的',
    settle: 1000
  },
  {
    id: 'settings-plugin-connected',
    page: 'guide/plugin',
    route: '/preferences?tab=plugin',
    caption: '设置 → 插件：引擎桥接正常、已连接的工程为 1'
  }
])

/** 生图用的提示词。挑一个和虚幻沾边的题材，手册里的图别看着像随便生的 */
const DEFAULT_GEN_PROMPT = '苔藓覆盖的花岗岩悬崖，清晨侧光，写实风格，用作场景参考图'

/**
 * 引擎那一轮发的话。
 *
 * 必须**真的建一个 `/Game/` 下的资产**，不能只摆 Actor：
 * 「审查改动」那个按钮的显示条件是 `reviewTargets.length > 0`，而
 * `reviewTargetsFrom` 只收引擎资产路径（见 composables/reviewTargets.ts）——
 * 关卡里的 Actor 不算，按钮根本不出现。第一次拍就栽在这儿：
 * 「本轮改动」有三条 Actor，「审查改动」一个按钮都没有。
 */
const DEFAULT_ENGINE_PROMPT =
  '在 /Game/DocsDemo 下新建一个主材质 M_DocsRock，基础色调成灰褐色，然后编译并保存。'

function parseArgs(argv) {
  const read = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback
  }
  return {
    exe: resolve(read('--exe', packagedAppPaths(ROOT).exe)),
    port: read('--port', '9223'),
    out: resolve(read('--out', join(ROOT, 'website', 'public', 'shots'))),
    only: read('--only', ''),
    list: argv.includes('--list'),
    bootMs: Number(read('--boot', '15000')),
    // 示例数据的工作区。路径会出现在截图里，所以默认取一个不含用户名的位置
    workspace: resolve(read('--workspace', defaultWorkspace(ROOT))),
    // 只想拍设置页时可以跳过播种 —— 那几页不依赖用户数据
    seed: !argv.includes('--no-seed'),
    // 对话正文那几张：借本机已配好的模型真跑一轮。要花钱，所以必须显式开
    withAi: argv.includes('--with-ai'),
    aiPrompt: read('--prompt', DEFAULT_AI_PROMPT),
    // 生图那一张：按次花钱，单独开
    withGen: argv.includes('--with-gen'),
    genPrompt: read('--gen-prompt', DEFAULT_GEN_PROMPT),
    // 引擎那一批：要起一个 UE 编辑器，慢，而且会真的改那个试验工程
    withEngine: argv.includes('--with-engine'),
    enginePrompt: read('--engine-prompt', DEFAULT_ENGINE_PROMPT),
    ueExe: read('--ue', 'D:/UE_5.4/Engine/Binaries/Win64/UnrealEditor.exe'),
    ueProject: read('--ue-project', 'H:/UEBoxDemo/Projects/DocsProbe54/DocsProbe54.uproject')
  }
}

/**
 * 真跑那一轮发的话。
 *
 * 挑这句的理由：只用得到资产库的只读工具（引擎没连也能跑通），而示例素材里
 * 正好有一组按 UE 前缀命名的贴图 —— 拍出来的回答能顺带印证「命名规则」那一页。
 */
const DEFAULT_AI_PROMPT = '帮我看看资产库里的贴图，命名符合 UE 规范吗？'

/**
 * 从本机已有的配置里借一份模型凭据给临时实例。
 *
 * 密钥用 Electron 的 safeStorage 加密，明文不出现在任何地方 —— 这里搬的是密文。
 *
 * **`Local State` 必须一起搬。** safeStorage 在 Windows 上走 Chromium 的 OSCrypt：
 * 真正的对称密钥是一段随机字节，DPAPI 包好之后存在 user-data-dir 的 `Local State` 里，
 * `ai-provider-secrets.bin` 只是用那把钥匙加的密。只搬密文不搬钥匙，新实例会自己
 * 生成一把新的，然后报「密钥不存在，可能是换了机器导致密文无法解开」——
 * 第一次就是这么失败的。
 *
 * **只在 `--with-ai` 时复制，而且那一轮不拍「设置 → 模型」** —— 那一页会列出
 * 本机配了哪几家服务商，不该跟着手册发出去。
 */
function copyAiCredentials(targetDir) {
  const source = join(process.env.APPDATA || '', 'unreal-box')
  const files = ['Local State', 'models.json', 'ai-provider-secrets.bin']
  const copied = []
  for (const file of files) {
    const from = join(source, file)
    if (!existsSync(from)) continue
    copyFileSync(from, join(targetDir, file))
    copied.push(file)
  }
  return { source, copied }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find(
        (t) => t.type === 'page' && !t.url.includes('spotlight') && !t.url.includes('mini-chat')
      )
      if (page) return page
    } catch {
      // devtools 还没起来
    }
    await sleep(1000)
  }
  return null
}

function attach(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const call = (method, params = {}) =>
    new Promise((res) => {
      const myId = ++id
      pending.set(myId, res)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  return { ws, call, ready: new Promise((r) => ws.on('open', r)) }
}

/** 在页面里跑一段 JS，取回 JSON 值。失败返回 { __error } 而不是抛 */
async function evaluate(session, expression, { awaitPromise = false } = {}) {
  const res = await session.call('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    // 手册要拍的弹窗大多由按钮触发，没有用户手势浏览器会拦下一部分行为
    userGesture: true
  })
  if (res?.result?.exceptionDetails || res?.error) {
    return { __error: JSON.stringify(res.result?.exceptionDetails || res.error) }
  }
  return res?.result?.result?.value
}

/**
 * 每拍一张之前把多余的标签关掉。
 *
 * 不关的话标签栏会越积越长，而且同一个页面会出现两次（根目录一次、带
 * `?folderKey=` 一次）—— 手册里出现一张「资产库 资产库」的图，读者只会
 * 以为是个 bug。走 tabs store 自己的 `closeOtherTabs`，不手改状态。
 */
async function closeOtherTabs(session) {
  return evaluate(
    session,
    `(() => {
      const app = document.querySelector('#app')
      const pinia = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$pinia
      const tabs = pinia && pinia._s && pinia._s.get('tabs')
      if (!tabs || typeof tabs.closeOtherTabs !== 'function') return 'no-store'
      tabs.closeOtherTabs(tabs.activeTab)
      return 'ok'
    })()`
  )
}

/**
 * 真发一轮对话，等它跑完。
 *
 * 走的是界面上那条路：往输入框里填字、点发送按钮。不直接调内核 ——
 * 手册要拍的就是「用户这么干之后界面长什么样」，绕开输入框拍出来的东西
 * 未必是用户点得出来的。
 *
 * 结束信号用内核自己的 `agent-v3:done` 事件，不靠猜时间：一轮可能三秒也可能三分钟。
 */
async function runConversation(session, prompt, { timeoutMs = 240000 } = {}) {
  const installed = await evaluate(
    session,
    `(() => {
      window.__docsRun = { done: false, error: null }
      if (!window.api || typeof window.api.on !== 'function') return 'no-api'
      window.api.on('agent-v3:done', () => { window.__docsRun.done = true })
      window.api.on('agent-v3:error', (_e, payload) => {
        window.__docsRun.error = typeof payload === 'string' ? payload : JSON.stringify(payload || null)
        window.__docsRun.done = true
      })
      window.api.on('agent-v3:stopped', () => { window.__docsRun.done = true })
      return 'ok'
    })()`
  )
  if (installed !== 'ok') return { ok: false, reason: `装监听失败：${installed}` }

  const sent = await evaluate(
    session,
    `(() => {
      const textarea = document.querySelector('.input-composer textarea')
      if (!textarea) return 'no-textarea'
      // a-textarea 是受控组件：直接改 .value 不会通知 Vue，必须走原生 setter + input 事件
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(prompt)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return 'typed'
    })()`
  )
  if (sent !== 'typed') return { ok: false, reason: `填输入框失败：${sent}` }
  await sleep(800)

  const clicked = await evaluate(
    session,
    `(() => {
      const btn = document.querySelector('.send-btn')
      if (!btn) return 'no-send-btn'
      if (btn.disabled) return 'send-disabled'
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 'clicked'
    })()`
  )
  if (clicked !== 'clicked') return { ok: false, reason: `点发送失败：${clicked}` }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(2500)
    const state = await evaluate(session, `JSON.stringify(window.__docsRun || null)`)
    let parsed = null
    try {
      parsed = JSON.parse(state || 'null')
    } catch {
      parsed = null
    }
    if (parsed?.done) {
      // 收尾还要画一会儿（用量、本轮改动是回合结束后才渲染的）
      await sleep(4000)
      return { ok: !parsed.error, reason: parsed.error || undefined }
    }
  }
  return { ok: false, reason: `等了 ${timeoutMs / 1000}s 没等到结束` }
}

/**
 * 真生一张图，等它出来。
 *
 * 同样走界面上那条路：填 `.prompt-input`、点 `.generate-btn`。
 * 结束信号问主进程的活跃任务表（`image:getActiveTasks`），不靠猜时间 ——
 * 一张图快则十几秒，慢则一分多钟。
 *
 * 中途会回调一次 `onSubmitted`，好让「生成中」那一张趁热拍下来。
 */
async function runImageGeneration(session, prompt, { timeoutMs = 300000, onSubmitted } = {}) {
  const typed = await evaluate(
    session,
    `(() => {
      const box = document.querySelector('.prompt-input')
      if (!box) return 'no-prompt-input'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(box, ${JSON.stringify(prompt)})
      box.dispatchEvent(new Event('input', { bubbles: true }))
      return 'typed'
    })()`
  )
  if (typed !== 'typed') return { ok: false, reason: `填提示词失败：${typed}` }
  await sleep(900)

  const clicked = await evaluate(
    session,
    `(() => {
      const btn = document.querySelector('.generate-btn')
      if (!btn) return 'no-generate-btn'
      if (btn.disabled) return 'generate-disabled'
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 'clicked'
    })()`
  )
  if (clicked !== 'clicked') return { ok: false, reason: `点生成失败：${clicked}` }

  await sleep(3500)
  if (onSubmitted) await onSubmitted()

  // 判完成看**界面上的历史面板**，不问主进程的活跃任务表 —— 那张表的返回形状
  // 试出来对不上（第一次跑白等了 300 秒，图其实早出来了）。历史面板上
  // 「进行中 N」「已完成 N」是用户自己也在看的那两个数，拿它判最不会错
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(4000)
    const raw = await evaluate(
      session,
      `(() => {
        const text = document.body.innerText || ''
        const running = /进行中\\s*(\\d+)/.exec(text)
        const done = /已完成\\s*(\\d+)/.exec(text)
        const failed = /失败\\s*(\\d+)/.exec(text)
        return JSON.stringify({
          running: running ? Number(running[1]) : null,
          done: done ? Number(done[1]) : null,
          failed: failed ? Number(failed[1]) : null
        })
      })()`
    )
    let state = null
    try {
      state = JSON.parse(raw || 'null')
    } catch {
      state = null
    }
    if (!state || state.running === null) continue
    if (state.running === 0 && (state.done ?? 0) > 0) {
      await sleep(2500)
      return { ok: true, done: state.done }
    }
    if (state.running === 0 && (state.failed ?? 0) > 0) {
      return { ok: false, reason: `厂商那边失败了 ${state.failed} 个` }
    }
  }
  return { ok: false, reason: `等了 ${timeoutMs / 1000}s 没等到出图` }
}

/**
 * 起一个 UE 编辑器，等它连上桥接。
 *
 * 不用 `UnrealEditor-Cmd`：插件是编辑器模块，命令行那条路不保证走到它的启动点。
 * 冷启动 + 着色器编译可能要好几分钟，所以超时给得很宽。
 *
 * 连没连上问的是应用自己的接口（`db:project:ualinkStatus` 那条路上的桥接状态），
 * 而不是看进程在不在 —— 进程起来了但插件没加载是最常见的那种失败。
 */
async function launchEngine(session, { exe, project, timeoutMs = 600000 }) {
  if (!existsSync(exe)) return { ok: false, reason: `找不到编辑器：${exe}` }
  if (!existsSync(project)) return { ok: false, reason: `找不到工程：${project}` }

  const child = spawn(exe, [project], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  console.log(`  已拉起 UE（pid ${child.pid}），等它连上来…`)

  const deadline = Date.now() + timeoutMs
  let lastSeen = ''
  while (Date.now() < deadline) {
    await sleep(10000)
    const raw = await evaluate(
      session,
      `(async () => {
        const ws = window.api.websocket
        if (!ws) return JSON.stringify({ err: 'no-api' })
        const [status, conns] = await Promise.all([
          ws.getStatus().catch((e) => ({ err: String(e) })),
          ws.getConnections().catch((e) => ({ err: String(e) }))
        ])
        const list = Array.isArray(conns) ? conns : (conns?.data ?? [])
        return JSON.stringify({
          running: status?.data?.running ?? status?.running ?? null,
          port: status?.data?.port ?? status?.port ?? null,
          clients: Array.isArray(list) ? list.length : -1
        })
      })()`,
      { awaitPromise: true }
    )
    let state = null
    try {
      state = JSON.parse(raw || 'null')
    } catch {
      state = null
    }
    const summary = JSON.stringify(state).slice(0, 120)
    if (summary !== lastSeen) {
      console.log(`  桥接状态：${summary}`)
      lastSeen = summary
    }
    if (state?.clients > 0) return { ok: true, pid: child.pid }
  }
  return { ok: false, reason: `等了 ${timeoutMs / 1000}s 编辑器没连上来`, pid: child.pid }
}

/** 通过应用自己的 router 导航。直接改 location.hash 会绕过路由守卫 */
async function navigate(session, route) {
  const result = await evaluate(
    session,
    `(() => {
      const app = document.querySelector('#app')
      const router = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$router
      if (!router) return 'no-router'
      return router.push(${JSON.stringify(route)}).then(() => 'ok', (e) => 'nav-failed: ' + e)
    })()`,
    { awaitPromise: true }
  )
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const pool = args.withEngine
    ? ENGINE_SHOTS
    : args.withGen
      ? GEN_SHOTS
      : args.withAi
        ? AI_SHOTS
        : SHOTS
  const shots = args.only ? pool.filter((s) => s.id.includes(args.only)) : pool

  if (args.list) {
    for (const s of shots) {
      console.log(`${s.id.padEnd(28)} ${(s.route ?? '（就拍当前屏）').padEnd(34)} ${s.caption}`)
    }
    console.log(`\n共 ${shots.length} 张`)
    return
  }

  if (!existsSync(args.exe)) {
    console.error(`ERROR 找不到打包产物：${args.exe}`)
    console.error('      先执行 pnpm build:unpack（或 pnpm build）再来拍图。')
    process.exitCode = 1
    return
  }

  mkdirSync(args.out, { recursive: true })

  // 夹具先铺好再启动 —— 应用起来之后播种脚本要按这些路径去登记
  let fixtures = null
  if (args.seed) {
    try {
      fixtures = buildWorkspace(args.workspace, { repoRoot: args.withEngine ? ROOT : null })
    } catch (error) {
      console.error(`ERROR ${error.message}`)
      process.exitCode = 1
      return
    }
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'uebox-docs-shots-'))
  console.log(`临时数据目录：${userDataDir}`)
  if (args.withAi || args.withGen || args.withEngine) {
    const { source, copied } = copyAiCredentials(userDataDir)
    if (copied.length === 0) {
      console.error(`ERROR 这一批需要本机已经配好模型，但 ${source} 下没找到 models.json`)
      process.exitCode = 1
      return
    }
    console.log(
      `模型凭据：从 ${source} 借用 ${copied.join('、')}（这一轮会真的调用模型，产生费用）`
    )
  }
  if (fixtures) {
    console.log(
      `示例工作区：${fixtures.workspace}（${fixtures.projects.length} 个工程，${fixtures.assets.length} 个素材）`
    )
  } else {
    console.log('示例数据：已跳过（--no-seed）')
  }
  console.log(`画布：${VIEWPORT.width}×${VIEWPORT.height} @${VIEWPORT.deviceScaleFactor}x\n`)

  const child = spawn(
    args.exe,
    [`--remote-debugging-port=${args.port}`, `--user-data-dir=${userDataDir}`],
    {
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        UA_DISABLE_SINGLE_INSTANCE_LOCK: '1',
        UA_REMOTE_DEBUGGING_PORT: args.port
      },
      stdio: 'ignore'
    }
  )
  child.unref()

  const manifest = []
  let session
  let enginePid = null
  try {
    const page = await waitForTarget(args.port)
    if (!page) {
      console.error('ERROR 应用起来了但没出现可调试页面')
      process.exitCode = 1
      return
    }
    session = attach(page)
    await session.ready
    await session.call('Page.enable')
    await session.call('Runtime.enable')

    // 先把语言和主题写进去再重载 —— 不然第一屏是「选择语言」那道门
    await evaluate(session, SEED_SCRIPT)
    await session.call('Page.reload')
    await sleep(args.bootMs)

    await session.call('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT,
      mobile: false,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height
    })
    await sleep(1200)

    // ── 播种示例数据 ──
    //
    // 全部走 window.api，也就是应用自己的那条路。每一步都回读核对：
    // 播种失败还接着拍，拍出来的是一堆空界面而没人知道为什么。
    if (fixtures) {
      console.log('播种示例数据：')
      let seedFailed = 0
      for (const step of seedSteps(fixtures)) {
        const raw = await evaluate(session, step.script, { awaitPromise: true })
        let result
        try {
          result = typeof raw === 'string' ? JSON.parse(raw) : raw
        } catch {
          result = { ok: false, raw }
        }
        const ok = result && result.ok === true
        if (!ok) seedFailed += 1
        const detail = JSON.stringify(result ?? null)
        console.log(
          `  ${ok ? '✓' : '✗'} ${step.name.padEnd(20)} ${detail.length > 160 ? detail.slice(0, 160) + '…' : detail}`
        )
      }
      if (seedFailed > 0) {
        console.log(
          `\n  ${seedFailed} 步没通过。下面拍出来的图可能是空的 —— 先修播种再拍，别把空界面当成产品长这样。\n`
        )
      }
      // 播种改的是主进程那边的库，渲染层要重载一次才看得到
      await session.call('Page.reload')
      await sleep(args.bootMs)
      await session.call('Emulation.setDeviceMetricsOverride', {
        ...VIEWPORT,
        mobile: false,
        screenWidth: VIEWPORT.width,
        screenHeight: VIEWPORT.height
      })
      await sleep(1500)
      console.log('')
    }

    // ── 结构化 dump：工具与技能清单 ──
    const inventory = {}
    inventory.capturedAt = new Date().toISOString()
    inventory.appVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    inventory.tools = await evaluate(
      session,
      `window.api?.agentV3?.listTools
        ? window.api.agentV3.listTools().then(r => JSON.stringify(r), e => 'ERR ' + e)
        : 'no-api'`,
      { awaitPromise: true }
    )
    inventory.skills = await evaluate(
      session,
      `window.api?.agentV3?.listSkills
        ? window.api.agentV3.listSkills().then(r => JSON.stringify(r), e => 'ERR ' + e)
        : 'no-api'`,
      { awaitPromise: true }
    )
    writeFileSync(
      join(ROOT, 'docs', 'screenshot-inventory.json'),
      JSON.stringify(inventory, null, 2),
      'utf8'
    )
    console.log('已 dump 工具与技能清单 → docs/screenshot-inventory.json\n')

    // ── 真跑一轮对话 ──
    if (args.withAi) {
      console.log(`真跑一轮：「${args.aiPrompt}」`)
      await navigate(session, '/dev-assistant')
      await sleep(3000)
      await closeOtherTabs(session)
      const run = await runConversation(session, args.aiPrompt)
      console.log(`  ${run.ok ? '✓' : '✗'} 这一轮${run.ok ? '跑完了' : '没跑成：' + run.reason}`)
      if (!run.ok) {
        console.log('  下面拍到的不是一轮完整对话。先把上面这条修掉再拍。\n')
      }
      console.log('')
    }

    // ── 起引擎，再真跑一轮写操作 ──
    if (args.withEngine) {
      const probe = fixtures?.probe
      if (!probe) {
        console.log('✗ 没找到可用的 UE —— 需要一个装了的 5.x，且仓库里有对应版本的随包插件')
      }
      const exe = probe?.editor?.exe ?? args.ueExe
      const project = probe?.uproject ?? args.ueProject
      console.log(`起 UE ${probe?.version ?? '?'}：${exe}
  试验工程：${project}（插件${probe?.pluginInstalled ? '已装' : '没装上'}）`)
      const engine = probe
        ? await launchEngine(session, { exe, project })
        : { ok: false, reason: '没有可用的 UE' }
      console.log(`  ${engine.ok ? '✓' : '✗'} ${engine.ok ? '编辑器已连上' : engine.reason}`)
      enginePid = engine.pid
      if (engine.ok) {
        console.log(`真跑一轮写操作：「${args.enginePrompt}」`)
        await navigate(session, '/dev-assistant')
        await sleep(3000)
        await closeOtherTabs(session)
        const run = await runConversation(session, args.enginePrompt, { timeoutMs: 420000 })
        console.log(`  ${run.ok ? '✓' : '✗'} 这一轮${run.ok ? '跑完了' : '没跑成：' + run.reason}`)
      } else {
        console.log('  引擎没连上，下面那几张拍不到真东西。先把上面这条修掉。')
      }
      console.log('')
    }

    // ── 真生一张图 ──
    if (args.withGen) {
      console.log(`真生一张图：「${args.genPrompt}」（按次收费）`)
      await navigate(session, '/aigc-studio')
      await sleep(3500)
      await closeOtherTabs(session)
      const shotOf = shots.find((item) => item.id === 'aigc-generating')
      const gen = await runImageGeneration(session, args.genPrompt, {
        // 提交之后立刻拍「生成中」那一张 —— 等跑完就没了
        onSubmitted: shotOf
          ? async () => {
              const res = await session.call('Page.captureScreenshot', { format: 'png' })
              if (res?.result?.data) {
                const buf = Buffer.from(res.result.data, 'base64')
                writeFileSync(join(args.out, 'aigc-generating.png'), buf)
                console.log(
                  `  ✓ aigc-generating（生成中）    ${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`
                )
                manifest.push({
                  ...shotOf,
                  ok: true,
                  width: buf.readUInt32BE(16),
                  height: buf.readUInt32BE(20),
                  bytes: buf.length
                })
              }
            }
          : undefined
      })
      console.log(`  ${gen.ok ? '✓' : '✗'} 出图${gen.ok ? '完成' : '失败：' + gen.reason}
`)
    }

    // ── 逐张拍 ──
    for (const shot of shots) {
      // 「生成中」只存在于提交后的那几秒，上面已经拍过
      if (args.withGen && shot.id === 'aigc-generating') continue
      // route 为 null 表示「就拍现在这一屏」（对话跑完之后那种）。
      // {{workspace}} 在这里替换成本次运行的工作区 —— 示例素材的路径是运行时才定的
      const route = shot.route
        ? shot.route.replace('{{workspace}}', (fixtures?.workspace ?? '').split('\\').join('/'))
        : null
      const nav = route ? await navigate(session, route) : 'stay'
      await sleep(shot.settle ?? 2200)
      if (route) {
        await closeOtherTabs(session)
        await sleep(400)
      }
      let prepared = ''
      if (shot.prepare) {
        prepared = await evaluate(session, shot.prepare, { awaitPromise: true })
        await sleep(shot.prepareSettle ?? 900)
      }
      const res = await session.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false
      })
      const data = res?.result?.data
      if (!data) {
        console.log(`  ✗ ${shot.id} —— 没拿到图像数据（导航结果 ${nav}）`)
        manifest.push({ ...shot, ok: false, reason: `capture-failed nav=${nav}` })
        continue
      }
      const buf = Buffer.from(data, 'base64')
      const file = join(args.out, `${shot.id}.png`)
      writeFileSync(file, buf)
      // 回读实际像素，别信「写完就是对的」
      const w = buf.readUInt32BE(16)
      const h = buf.readUInt32BE(20)
      const sizeOk = w === VIEWPORT.width * VIEWPORT.deviceScaleFactor
      console.log(
        `  ${sizeOk ? '✓' : '!'} ${shot.id.padEnd(28)} ${w}×${h}  ${String((buf.length / 1024) | 0).padStart(4)}KB${prepared ? '  ' + prepared : ''}`
      )
      manifest.push({ ...shot, ok: true, width: w, height: h, bytes: buf.length })
    }

    // 按 id 合并，不是覆盖。`--only` 和 `--with-ai` 都是部分重拍，
    // 直接覆盖会把这一次没拍的那三十张从清单上抹掉 —— 磁盘上图还在，
    // 台账却说没有，比没有台账更误导
    const manifestPath = join(args.out, 'manifest.json')
    const previous = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')).shots ?? [])
      : []
    const merged = new Map(previous.map((entry) => [entry.id, entry]))
    for (const entry of manifest) merged.set(entry.id, entry)
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          viewport: VIEWPORT,
          capturedAt: new Date().toISOString(),
          shots: [...merged.values()]
        },
        null,
        2
      ),
      'utf8'
    )
    const ok = manifest.filter((m) => m.ok).length
    console.log(`\n完成：${ok}/${manifest.length} 张，输出目录 ${args.out}`)
    const sizes = new Set(manifest.filter((m) => m.ok).map((m) => `${m.width}×${m.height}`))
    console.log(`实际尺寸：${[...sizes].join(', ')}${sizes.size > 1 ? '  ← 不一致，要查' : ''}`)
  } finally {
    session?.ws.terminate()
    if (enginePid) {
      try {
        process.kill(enginePid)
        console.log('已关掉 UE 编辑器')
      } catch {
        // 可能已经退了
      }
    }
    try {
      process.kill(child.pid)
    } catch {
      // 已退出
    }
  }
}

/**
 * 两批清单合起来。给台账工具用 —— 它要按 id 查 page 和 caption，
 * 而正则从源码里抠是抠不全的（设置页那批是 map 出来的）。
 */
export const ALL_SHOTS = Object.freeze([...SHOTS, ...AI_SHOTS, ...GEN_SHOTS, ...ENGINE_SHOTS])

// 只有被直接执行时才启动应用。被 import 时不能有副作用，
// 否则「读一下清单」会顺手开一个 Electron
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
