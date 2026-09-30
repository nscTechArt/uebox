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

  if (typeof value.answer === 'string') return [value.answer || '(子任务没有交回结论)']
  if (Array.isArray(value.checks)) return renderChecks(value)
  if (Array.isArray(value.projects)) return renderProjects(value)
  if (Array.isArray(value.tools)) return renderTools(value)
  if ('structured' in value && 'content' in value) return renderToolCall(value)
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
