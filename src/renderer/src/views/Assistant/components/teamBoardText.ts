/**
 * 任务板上的留言和任务文字，原样是写给模型看的。
 *
 * 队员交活的留言由 `main/agent-v3/core/team/teamTools.ts` 拼成：
 *   【交活】阿场景（mimo-v2.6-pro） 回话：\n<正文>\n\n【本次子任务的写操作】…。这些改动**已经发生**…\n【快照】已存 …
 * 前缀、模型名、记账行全挤在一段里，用户读到的是一堵墙。这里把它拆成
 * 「类别 / 模型 / 正文 / 附注」，界面只默认展示正文，附注收在展开里。
 * 认不出的格式原样当正文，不丢字。
 */

export type MailKind = 'delivery' | 'stopped'

export interface MailExtra {
  /** writes = 写操作记账，snapshot = 自动快照，其余原样给标签 */
  label: 'writes' | 'snapshot' | string
  text: string
}

export interface MailView {
  kind?: MailKind
  model?: string
  body: string
  extras: MailExtra[]
}

const KINDS: [string, MailKind][] = [
  ['【交活】', 'delivery'],
  ['【没干完】', 'stopped']
]

/** 附注段的开头。正文里出现在它们之前的都算正文 */
const EXTRA_LABELS: Record<string, MailExtra['label']> = {
  本次子任务的写操作: 'writes',
  快照: 'snapshot'
}
const EXTRA_START = new RegExp(`【(${Object.keys(EXTRA_LABELS).join('|')})】`)

/** 写操作那行后半句是叮嘱模型的（「需要的话自己回读确认…」），用户不需要 */
const WRITES_ADVICE = /。这些改动[\s\S]*$/

export function parseTeamMail(text: string, from: string): MailView {
  let rest = text.trim()
  let kind: MailKind | undefined
  for (const [prefix, value] of KINDS) {
    if (rest.startsWith(prefix)) {
      kind = value
      rest = rest.slice(prefix.length).trimStart()
      break
    }
  }

  let model: string | undefined
  if (rest.startsWith(from)) {
    const after = rest.slice(from.length)
    const reply = after.match(/^\s*(?:（([^）]*)）)?\s*回话：\s*/)
    const stopped = after.match(/^\s*这件活停下了：\s*/)
    if (reply) {
      model = reply[1]?.trim() || undefined
      rest = after.slice(reply[0].length)
    } else if (stopped) {
      rest = after.slice(stopped[0].length)
    }
  }

  const extras: MailExtra[] = []
  const start = rest.search(EXTRA_START)
  if (start >= 0) {
    const tail = rest.slice(start)
    rest = rest.slice(0, start)
    for (const part of tail.split(/(?=【[^】]+】)/)) {
      const match = part.match(/^【([^】]+)】([\s\S]*)$/)
      if (!match) continue
      const label = EXTRA_LABELS[match[1]] ?? match[1]
      let body = match[2].trim()
      if (label === 'writes') body = body.replace(WRITES_ADVICE, '').trim()
      if (body) extras.push({ label, text: body })
    }
  }

  let body = rest.trim()
  // 停下来的原因常常是厂商回的一整段 JSON，里面只有 message 是给人看的
  if (kind === 'stopped') {
    const message = body.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (message) {
      const prefix = body.slice(0, body.indexOf('{')).replace(/[:：\s]+$/, '')
      body = (prefix ? `${prefix} · ` : '') + message[1].replace(/\\(.)/g, '$1')
    }
  }
  return { kind, model, body, extras }
}

export interface InlineSegment {
  text: string
  kind: 'plain' | 'bold' | 'code'
}

/**
 * 模型写的文字里常带 `**粗体**` 和 `代码`，原样显示就是满屏星号和反引号。
 * 只认这两种，渲染成节点而不是 HTML，内容里有什么都不会被当标签执行。
 */
export function inlineSegments(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  const pattern = /\*\*([^*\n]+?)\*\*|`([^`\n]+?)`/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) segments.push({ text: text.slice(last, index), kind: 'plain' })
    segments.push(
      match[1] !== undefined ? { text: match[1], kind: 'bold' } : { text: match[2], kind: 'code' }
    )
    last = index + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), kind: 'plain' })
  return segments
}
