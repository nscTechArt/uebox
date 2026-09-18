import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { assertPathAllowed } from '../../agent-v3/tools/builtin/pathBoundary'
import { retryMediaFile } from './files'

export interface VideoContextEntry {
  index: number
  role: string
  text: string
  images: string[]
  imageNote?: string
}

/** UI history survives model-context compaction. Select the host session before returning data. */
export function conversationMessages(snapshot: unknown, sessionId: string): unknown[] {
  const state = snapshot as { messagesBySid?: Record<string, unknown> } | null
  const selected = state?.messagesBySid?.[sessionId]
  if (!Array.isArray(selected)) return []
  const result: unknown[] = []
  for (const raw of selected) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as {
      role?: string
      content?: unknown
      toolResults?: { result?: unknown }[]
      agentProcess?: { type?: string; data?: { result?: unknown } }[]
    }
    result.push({ role: message.role, content: message.content })
    const outcomes = [
      ...(message.toolResults ?? []).map((tool) => tool.result),
      ...(message.agentProcess ?? [])
        .filter((item) => item.type === 'tool-result')
        .map((item) => item.data?.result)
    ]
    const seen = new Set<string>()
    for (const outcome of outcomes) {
      if (outcome === undefined) continue
      const serialized = JSON.stringify(outcome)
      if (seen.has(serialized)) continue
      seen.add(serialized)
      const structured = outcome as { content?: unknown; details?: Record<string, unknown> } | null
      // Native tool details can retain the original path while content contains a reduced preview.
      const originals = Object.fromEntries(
        Object.entries(structured?.details ?? {}).filter(
          ([key, value]) =>
            ['path', 'filePath', 'imagePath', 'localPath', 'savedPath', 'width', 'height'].includes(
              key
            ) && ['string', 'number'].includes(typeof value)
        )
      )
      result.push({
        role: 'toolResult',
        content: Array.isArray(structured?.content)
          ? [
              ...structured.content,
              ...(Object.keys(originals).length
                ? [{ type: 'text', text: `原始素材信息：${JSON.stringify(originals)}` }]
                : [])
            ]
          : serialized
      })
    }
  }
  return result
}

export async function loadConversationVideoMessages(
  userData: string,
  sessionId: string
): Promise<{ messages: unknown[]; warning?: string }> {
  try {
    const sessions = JSON.parse(
      await fs.readFile(path.join(userData, 'chat-history', 'chat-sessions.json'), 'utf8')
    ) as { sessions?: { id?: string; agentSessionId?: string }[] }
    const matches = Array.isArray(sessions.sessions)
      ? sessions.sessions.filter((session) => session.agentSessionId === sessionId)
      : []
    if (matches.length !== 1 || typeof matches[0].id !== 'string') {
      return {
        messages: [],
        warning:
          '当前 Agent 尚未对应到唯一的已保存聊天记录，将使用可用的 Agent 记录；早期内容可能仅剩摘要。'
      }
    }
    const saved = JSON.parse(
      await fs.readFile(path.join(userData, 'chat-history', 'chat-messages.json'), 'utf8')
    )
    return { messages: conversationMessages(saved, matches[0].id) }
  } catch (error) {
    return {
      messages: [],
      warning:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? '没有保存的界面聊天记录，将使用可用的 Agent 记录；早期内容可能仅剩摘要。'
          : '界面聊天记录暂时读不到，将使用可用的 Agent 记录；不要声称已经取得全部历史。'
    }
  }
}

export async function allowedMediaPath(file: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error('素材必须使用本地绝对路径。')
  const real = await fs.realpath(file)
  const denial = assertPathAllowed(real)
  if (denial) throw new Error(denial)
  if (!(await fs.stat(real)).isFile()) throw new Error('素材路径不是文件。')
  return real
}

/** Snapshot only visible conversation content, never reasoning or tool arguments. */
export async function createVideoProject(
  root: string,
  sessionId: string,
  messages: unknown[]
): Promise<{ projectDir: string; entries: VideoContextEntry[] }> {
  const projectDir = path.join(root, `task-video-${randomUUID()}`)
  await fs.mkdir(path.join(projectDir, 'assets'), { recursive: true })
  const entries: VideoContextEntry[] = []
  const savedImages = new Set<string>()
  for (const [index, raw] of messages.entries()) {
    const message = raw as { role?: string; content?: unknown; isError?: boolean }
    const parts = Array.isArray(message.content) ? message.content : []
    const texts: string[] = typeof message.content === 'string' ? [message.content] : []
    const images: string[] = []
    for (const part of parts) {
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      const url = part?.image_url?.url ?? part?.file_url?.url
      const inline = typeof url === 'string' ? /^data:(image\/[^;]+);base64,(.*)$/s.exec(url) : null
      if (typeof url === 'string' && !inline) texts.push(`附件素材：${url}`)
      const data = inline?.[2] ?? (part?.type === 'image' ? part.data : undefined)
      const mimeType = inline?.[1] ?? part?.mimeType
      if (typeof data !== 'string') continue
      const ext = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif'
      }[String(mimeType)]
      if (!ext || data.length > 40 * 1024 * 1024) continue
      const bytes = Buffer.from(data, 'base64')
      const name = createHash('sha256').update(bytes).digest('hex')
      const file = path.join(projectDir, 'assets', `${name}.${ext}`)
      if (!savedImages.has(file)) {
        await retryMediaFile(() => fs.writeFile(file, bytes))
        savedImages.add(file)
      }
      images.push(file)
    }
    if (texts.length || images.length) {
      entries.push({
        index,
        role: message.isError ? 'tool-error' : String(message.role ?? ''),
        text: texts.join('\n'),
        images,
        ...(images.length
          ? {
              imageNote:
                '会话预览副本，可能已压缩至 768px 宽；优先从本条及相关工具结果的路径使用磁盘原图。找不到原图时才用此副本，并说明清晰度限制。'
            }
          : {})
      })
    }
  }
  await fs.writeFile(path.join(projectDir, 'context.json'), JSON.stringify(entries, null, 2))
  await fs.writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ version: 1, sessionId, capturedAt: new Date().toISOString() }, null, 2)
  )
  return { projectDir, entries }
}

export async function assertVideoProject(projectDir: string, sessionId: string): Promise<string> {
  const real = await fs.realpath(projectDir)
  const denial = assertPathAllowed(real)
  if (denial) throw new Error(denial)
  const metadata = JSON.parse(await fs.readFile(path.join(real, 'project.json'), 'utf8'))
  if (metadata.version !== 1 || metadata.sessionId !== sessionId)
    throw new Error('该视频工程不属于当前会话。')
  return real
}

/** Paginate by characters too: a single tool result can exceed a model context. */
export function contextPage(
  entries: VideoContextEntry[],
  offset: number,
  limit = 12000
): { text: string; nextOffset: number | null } {
  const serialized = entries.map((entry) => JSON.stringify(entry)).join('\n')
  const end = Math.min(serialized.length, offset + limit)
  return { text: serialized.slice(offset, end), nextOffset: end < serialized.length ? end : null }
}
