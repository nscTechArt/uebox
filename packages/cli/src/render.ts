/**
 * 默认（非 `--json`）模式下把信封渲染成给人看的几行。
 *
 * 一条规矩：**补救建议跟在错误后面**，不是前面。人读错误信息是先看
 * 「哪儿不对」再看「怎么办」，倒过来的话第一眼看到的是一句没有上下文的指令。
 *
 * 不用颜色、不用转圈、不用终端控制码 —— 这些输出经常被重定向进文件或者被
 * 别的程序读，控制码在那些地方是垃圾字符。
 */

import type { Envelope } from './envelope.js'

export function render(envelope: Envelope): string {
  const lines: string[] = []

  if (envelope.project) {
    lines.push(`工程：${envelope.project.name}（${envelope.project.path}）`)
  }

  if (envelope.ok) {
    lines.push(...renderData(envelope.data))
  } else if (envelope.error) {
    lines.push(`失败（${envelope.error.code}）：${envelope.error.message}`)
    if (envelope.error.hint) lines.push(`怎么办：${envelope.error.hint}`)
    if (envelope.error.execution === 'unknown') {
      lines.push('注意：请求可能已经发到引擎了，结果无法确认。先核实现场，不要直接重发。')
    }
  }

  for (const artifact of envelope.artifacts) {
    lines.push(`产物：${artifact.path}（${artifact.mimeType}，${artifact.bytes} 字节）`)
  }
  for (const warning of envelope.warnings) {
    lines.push(`提示：${warning}`)
  }

  return lines.join('\n')
}

/**
 * 按几个已知形状渲染，认不出来就退回紧凑 JSON。
 *
 * 退回 JSON 而不是硬编一段人话：认不出来的时候原样给出去，用户至少看得到
 * 全部内容；编一段摘要则可能把他真正要看的那个字段吞掉。
 */
function renderData(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [String(data ?? '')]
  const value = data as Record<string, unknown>

  if (Array.isArray(value.checks)) return renderChecks(value)
  if (Array.isArray(value.projects)) return renderProjects(value)
  if (Array.isArray(value.tools)) return renderTools(value)
  if (typeof value.hostConfigPath === 'string') return renderSetup(value)
  if ('structured' in value && 'content' in value) return renderToolCall(value)
  if ('selectedActors' in value || 'focusedEditor' in value) return renderSelection(value)
  if (Array.isArray(value.actors)) return renderActors(value)
  if (typeof value.output === 'string') return renderScreenshot(value)

  return [JSON.stringify(value, null, 2)]
}

function renderChecks(value: Record<string, unknown>): string[] {
  const checks = value.checks as Array<Record<string, unknown>>
  const lines = checks.map((check) => {
    const mark = check.status === 'ok' ? '通过' : check.status === 'failed' ? '失败' : '跳过'
    return `[${mark}] ${check.name}：${check.detail}`
  })

  for (const check of checks) {
    if (check.status === 'failed' && check.hint) lines.push(`怎么办：${check.hint}`)
  }

  const target = value.target as Record<string, unknown> | null | undefined
  if (target) {
    lines.push(`这一次会发给：${target.name}（${target.path}）`)
  }
  return lines
}

function renderProjects(value: Record<string, unknown>): string[] {
  const projects = value.projects as Array<Record<string, unknown>>
  if (projects.length === 0) return ['没有已连接的 UE 工程。']

  return [
    `${projects.length} 个可操作的 UE 工程：`,
    ...projects.map((project) => `  ${project.name}  ${project.path}`)
  ]
}

function renderTools(value: Record<string, unknown>): string[] {
  const tools = value.tools as Array<Record<string, unknown>>
  if (tools.length === 0) return ['没有可调用的工具。']

  const width = Math.max(...tools.map((tool) => String(tool.name).length))
  const lines = tools.map((tool) => `  ${String(tool.name).padEnd(width)}  ${tool.brief ?? ''}`)

  // 「盒子开放了 53 个，本版能调 12 个」必须说出来，否则用户会以为盒子里
  // 只有这十二个工具
  const outOfScope = Number(value.outOfScope ?? 0)
  const header = outOfScope
    ? `${tools.length} 个可调用工具（盒子共开放 ${value.exposedByHost} 个，另外 ${outOfScope} 个超出本版范围）：`
    : `${tools.length} 个可调用工具：`

  return [header, ...lines]
}

function renderSetup(value: Record<string, unknown>): string[] {
  const contract = value.contract as Record<string, unknown> | undefined
  return [
    '已关联虚幻盒子配置。',
    `  盒子配置：${value.hostConfigPath}`,
    `  服务地址：${value.url}`,
    `  CLI 配置：${value.configPath}`,
    contract?.supported ? `  接口契约：v${contract.cliContractVersion}` : '  接口契约：不支持',
    `下一步：${value.nextCommand}`
  ]
}

/**
 * 选中内容。
 *
 * `null` 一律渲染成「未报告」而不是「无」—— 屏幕上一个「无」会被当成
 * 「查过了，没有」，而它其实是「这个插件版本不告诉我们」。
 */
function renderSelection(value: Record<string, unknown>): string[] {
  const lines: string[] = []

  const editor = value.focusedEditor as Record<string, unknown> | null
  lines.push(
    editor ? `焦点：${editor.type} ${editor.name}（${editor.path}）` : '焦点：没有打开的资产编辑器'
  )

  const graph = value.focusedGraph as Record<string, unknown> | null
  if (graph) lines.push(`当前图：${graph.name}`)

  lines.push(
    ...renderPicked('图里选中的节点', value.selectedNodes, value.selectedNodeCount, 'title')
  )
  lines.push(
    ...renderPicked('关卡里选中的 Actor', value.selectedActors, value.selectedActorCount, 'label')
  )

  const browser = value.contentBrowser as Record<string, unknown> | null
  if (browser) {
    lines.push(
      ...renderPicked(
        '内容浏览器里选中的资产',
        browser.selectedAssets,
        browser.selectedAssetCount,
        'name'
      )
    )
  }

  return lines
}

function renderPicked(label: string, items: unknown, count: unknown, key: string): string[] {
  if (items === null || items === undefined) return [`${label}：未报告（插件版本较旧）`]

  const list = items as Array<Record<string, unknown>>
  if (list.length === 0) return [`${label}：无`]

  const names = list.map((item) => item[key] ?? item.name).join('、')
  // 总数是 null 时不写数字，写「至少」—— 列表本身就是被截断过的那一批
  const total = typeof count === 'number' ? `${count} 个` : `至少 ${list.length} 个（总数未报告）`
  return [`${label}：${total} —— ${names}`]
}

function renderActors(value: Record<string, unknown>): string[] {
  const actors = value.actors as Array<Record<string, unknown>>
  if (actors.length === 0) return ['没有匹配的 Actor。']

  const lines = actors.map((actor) => {
    const transform = actor.transform as Record<string, unknown> | null
    const location = transform?.location as Record<string, number> | null
    const at = location ? `  @(${location.x}, ${location.y}, ${location.z}) 厘米` : ''
    return `  ${actor.label ?? actor.name}  [${actor.class}]${at}`
  })

  // 三个数一起报。只说「找到 50 个」会被读成「一共 50 个」
  const returned = value.returnedCount
  const total = value.totalCount
  const header =
    typeof total === 'number'
      ? `返回 ${returned} 个（共匹配 ${total} 个）：`
      : `返回 ${returned} 个（总数未报告）：`

  return [header, ...lines]
}

function renderScreenshot(value: Record<string, unknown>): string[] {
  const lines = [
    `截图已保存：${value.output}`,
    `  尺寸：${value.width}×${value.height}，${value.bytes} 字节`
  ]

  // 机位来源决定这张图算不算数，永远报出来
  if (value.world || value.cameraSource) {
    lines.push(`  世界：${value.world ?? '未报告'}，机位：${value.cameraSource ?? '未报告'}`)
  }
  return lines
}

function renderToolCall(value: Record<string, unknown>): string[] {
  const content = (value.content as Array<Record<string, unknown>>) ?? []
  const text = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)

  const lines = text.length > 0 ? [...text] : ['(工具没有返回文本)']

  // 图片块绝不打印 base64 —— 一张压缩过的截图有二十多万个字符，
  // 刷完终端之后用户什么也看不到了
  const images = content.filter((block) => block.type === 'image').length
  if (images > 0) lines.push(`（另有 ${images} 张图片，本版不落盘，用 --json 看结构化结果）`)

  if (value.structured) {
    lines.push('', '结构化结果：', JSON.stringify(value.structured, null, 2))
  }
  return lines
}
