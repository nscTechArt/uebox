/**
 * 一条经验在磁盘上的样子，以及读写它。
 *
 * ## 为什么是 markdown 而不是数据库
 *
 * 硬规则 10：用户的东西以磁盘文件为准。经验虽然是整理员写的，但它属于用户 ——
 * 要能打开看、手改、删；本工程那一层还能随工程进版本库。统计数字（出场几次、采纳几次）
 * 变得太勤，另放 `.ledger.json`，不去反复改用户看得见的文件（见 `ledger.ts`）。
 *
 * ## 为什么按工具分文件
 *
 * 召回的第一把钥匙就是工具名（见 `recall.ts`）：一次报错只需要读一个文件。
 *
 * ## 格式
 *
 * ```markdown
 * ## 材质参数名要用引擎里的真实名字
 * <!-- id: e-1a2b3c -->
 * - key: ue_set_material_parameter · "parameter not found"
 * - advice: 先调 ue_get_material_parameters 取真实参数名
 * - expect: tool=ue_get_material_parameters
 * - source: 2026-09-28 · session a1b2 · failed twice, then succeeded
 * - verified: 2026-09-28 · UE 5.5
 * - status: trial
 * ```
 *
 * 通用层（`<userData>/experience/`）的经验多两个字段，工程层的没有：
 *
 * ```markdown
 * - engines: 5.5, 5.6      在这些引擎版本上被照着做并且成功过
 * - not-for: 5.7           在这些版本上照着做了还是同一个错
 * ```
 *
 * 字段名用英文、固定小写：解析要稳，而界面上显示的是翻译过的标签，不是这几个词。
 * 解析宽进：认不出的行原样跳过，一条经验缺了必填字段就整条不认 —— 用户手改坏了
 * 一条，不能拖垮整个文件。
 */

export type ExperienceStatus = 'trial' | 'proven' | 'retired'

/**
 * 「采纳」的判据：经验出场后，下一步做了它说的事。
 *
 * 必须是结构化的 —— 「模型有没有照着做」让模型自己判断，又回到了靠猜。
 * 两种都没写的经验判不了采纳，也就永远转不了正（见 `lifecycle.ts`）。
 */
export interface ExpectedAction {
  /** 下一步调用了这个工具 */
  tool?: string
  /** 同一个工具重试时，这个参数的值变了 */
  param?: string
}

export interface ExperienceEntry {
  id: string
  title: string
  tool: string
  /** 归一化后的报错里必须含有的一段（见 `errorSignature.ts`） */
  errorPattern: string
  advice: string
  expect: ExpectedAction
  source: string
  /** 验真的日期与引擎版本 */
  verified?: { date: string; engine?: string }
  status: ExperienceStatus
  /** 用户钉住的不会被淘汰 */
  pinned?: boolean
  /** 通用层：在哪些引擎版本（major.minor）上被照着做并且成功过 */
  engines?: string[]
  /** 通用层：在哪些引擎版本上照着做了还是同一个错 —— 这些版本上不再出场 */
  notFor?: string[]
}

/** `5.5.4` / `UE 5.5` → `5.5`。拿不出 major.minor 的回 undefined */
export function engineMinor(version: string | undefined): string | undefined {
  const match = version?.match(/(\d+)\.(\d+)/)
  return match ? `${match[1]}.${match[2]}` : undefined
}

function parseList(value: string | undefined): string[] | undefined {
  const list = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return list.length ? list : undefined
}

const ID_LINE = /^<!--\s*id:\s*([\w-]+)\s*-->$/
const FIELD_LINE = /^-\s*([a-z-]+):\s*(.*)$/

function parseKey(value: string): { tool: string; errorPattern: string } | undefined {
  const match = value.match(/^([\w.-]+)\s*·\s*"(.*)"$/)
  if (!match) return undefined
  return { tool: match[1], errorPattern: match[2] }
}

function parseExpect(value: string): ExpectedAction {
  const expect: ExpectedAction = {}
  for (const part of value.split(/\s*,\s*/)) {
    const [k, v] = part.split('=').map((s) => s.trim())
    if (!v) continue
    if (k === 'tool') expect.tool = v
    if (k === 'param') expect.param = v
  }
  return expect
}

function parseVerified(value: string): ExperienceEntry['verified'] {
  const [date, engine] = value.split('·').map((s) => s.trim())
  if (!date) return undefined
  const version = engine?.replace(/^UE\s*/i, '')
  return version ? { date, engine: version } : { date }
}

function parseStatus(value: string): ExperienceStatus | undefined {
  return value === 'trial' || value === 'proven' || value === 'retired' ? value : undefined
}

export function parseExperienceFile(text: string): ExperienceEntry[] {
  const entries: ExperienceEntry[] = []
  const blocks = text.split(/^## /m).slice(1)

  for (const block of blocks) {
    const [titleLine, ...lines] = block.split(/\r?\n/)
    const fields: Record<string, string> = {}
    let id: string | undefined
    for (const raw of lines) {
      const line = raw.trim()
      const idMatch = line.match(ID_LINE)
      if (idMatch) {
        id = idMatch[1]
        continue
      }
      const field = line.match(FIELD_LINE)
      if (field) fields[field[1]] = field[2].trim()
    }

    const key = fields.key ? parseKey(fields.key) : undefined
    const status = parseStatus(fields.status ?? '')
    const title = titleLine.trim()
    if (!id || !title || !key || !fields.advice || !status) continue

    const verified = fields.verified ? parseVerified(fields.verified) : undefined
    const engines = parseList(fields.engines)
    const notFor = parseList(fields['not-for'])
    entries.push({
      id,
      title,
      tool: key.tool,
      errorPattern: key.errorPattern,
      advice: fields.advice,
      expect: parseExpect(fields.expect ?? ''),
      source: fields.source ?? '',
      ...(verified ? { verified } : {}),
      status,
      ...(fields.pinned === 'yes' ? { pinned: true } : {}),
      ...(engines ? { engines } : {}),
      ...(notFor ? { notFor } : {})
    })
  }
  return entries
}

/** 单行字段不能带换行，否则下一次解析会把它劈成两条 */
function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim()
}

function formatExpect(expect: ExpectedAction): string {
  return [
    ...(expect.tool ? [`tool=${expect.tool}`] : []),
    ...(expect.param ? [`param=${expect.param}`] : [])
  ].join(', ')
}

export function serializeExperienceFile(tool: string, entries: ExperienceEntry[]): string {
  const header =
    `# ${tool}\n\n` +
    '<!-- Written by Unreal Box from real engine results. Edit or delete freely; ' +
    'statistics live in .ledger.json. -->\n'
  const body = entries.map((entry) => {
    const lines = [
      `## ${oneLine(entry.title)}`,
      `<!-- id: ${entry.id} -->`,
      `- key: ${entry.tool} · "${oneLine(entry.errorPattern).replace(/"/g, "'")}"`,
      `- advice: ${oneLine(entry.advice)}`,
      ...(formatExpect(entry.expect) ? [`- expect: ${formatExpect(entry.expect)}`] : []),
      `- source: ${oneLine(entry.source)}`,
      ...(entry.verified
        ? [
            `- verified: ${entry.verified.date}${entry.verified.engine ? ` · UE ${entry.verified.engine}` : ''}`
          ]
        : []),
      `- status: ${entry.status}`,
      ...(entry.pinned ? ['- pinned: yes'] : []),
      ...(entry.engines?.length ? [`- engines: ${entry.engines.join(', ')}`] : []),
      ...(entry.notFor?.length ? [`- not-for: ${entry.notFor.join(', ')}`] : [])
    ]
    return lines.join('\n')
  })
  return `${header}\n${body.join('\n\n')}\n`
}

/** 工具名 → 文件名。工具名本身就是安全字符，这里只防万一 */
export function fileNameForTool(tool: string): string {
  return `${tool.replace(/[^\w.-]/g, '_')}.md`
}
