/**
 * `uebox selection get` —— 用户此刻在编辑器里选中/打开着什么。
 *
 * 这是 Agent 听懂「这个」的唯一途径：用户说「把**这个**节点改成 Lerp」时，
 * 句子里既没有资产路径也没有 node_id，答案只在编辑器里。
 *
 * ## 缺失和「确认为空」必须分得开
 *
 * 旧插件不报 `selectedActorCount` 这类后加的字段。这时候公共结果里是 `null`，
 * 而这一层要把它翻成一条**警告**告诉调用方 —— 否则一个 `null` 很容易被当成
 * 「查过了，没有」。「用户什么都没选」能下结论，「这个插件版本不告诉我们」
 * 只能去问。
 */

import { success, type Envelope } from '../envelope.js'
import { UeboxError } from '../errors.js'
import * as runtime from '../runtime.js'

const TOOL = 'ue_get_selection'

export interface SelectionOptions {
  configPath?: string
  timeoutSeconds?: number
  project?: string
  env?: NodeJS.ProcessEnv
}

export async function runSelectionGet(options: SelectionOptions): Promise<Envelope> {
  const rt = await runtime.open({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.env ? { env: options.env } : {})
  })

  try {
    const catalog = await runtime.catalog(rt)
    const tool = catalog.find((item) => item.name === TOOL)
    if (!tool) {
      throw new UeboxError(
        'TOOL_UNAVAILABLE',
        `虚幻盒子没有开放 ${TOOL}，无法读取选中内容。`,
        '在盒子的 MCP 设置里确认暴露范围没有被命名空间白名单收得太窄。'
      )
    }

    const project = await runtime.targetProject(rt, options.project)
    const result = await runtime.callTool(rt, TOOL, {}, project.path)
    const data = result.structuredContent

    if (!data) {
      throw new UeboxError(
        'INCOMPATIBLE_SERVER',
        '虚幻盒子没有返回结构化的选中内容。',
        '升级虚幻盒子 —— 旧版本只把结果写在一段文字里，没法当接口用。'
      )
    }

    return success({
      project: { name: project.name, path: project.path },
      data,
      warnings: describeGaps(data)
    })
  } finally {
    await rt.close()
  }
}

/**
 * 哪些信息这个插件版本没给。
 *
 * 只对**计数**字段报警：数组是 null 时调用方一眼就看得出「没有这项数据」，
 * 而 count 是 null 却最容易被顺手当成 0。
 */
function describeGaps(data: Record<string, unknown>): string[] {
  const missing: string[] = []

  if (data.selectedActors !== null && data.selectedActorCount === null) {
    missing.push('选中 Actor 的总数')
  }
  if (data.selectedNodes !== null && data.selectedNodeCount === null) {
    missing.push('选中节点的总数')
  }

  if (missing.length === 0) return []

  return [
    `当前插件版本没有报告：${missing.join('、')}。` +
      '返回里对应字段是 null —— 那表示「不知道」，不是「零个」。升级 UnrealAgentLink 插件可以补上。'
  ]
}
