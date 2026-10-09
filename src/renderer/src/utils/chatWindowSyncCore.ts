/**
 * 对话同步的纯计算部分：算补丁、打补丁。
 *
 * 不碰 store、不碰 IPC，所以能单测 —— 这里错了的后果都是静默的：一边少一条消息、
 * 一边的气泡停在半截，没有任何报错。接线在 `chatWindowSync.ts`。
 *
 * ## 为什么按「指纹」比，不按引用比
 *
 * store 里的消息是**就地改**的（`replaceTyping` 为了流式性能直接改属性，见
 * `chatMessages.ts`），引用永远不变，比引用什么也看不出来。所以每边记一份「对方
 * 已经有的样子」（JSON 串），只把和它不一样的发过去；收到的也记进去，免得原样弹回。
 */

import type { ChatSyncPatch, ChatSyncSessionPatch } from '@core/shared/chatWindowSync'

type SyncMessage = { id: string } & Record<string, unknown>

/** 一条对话两边已经对齐的样子 */
export interface KnownState {
  /** 消息 id → 对方手里那条的 JSON */
  messages: Map<string, string>
  order: string[]
  /** 对话记录字段 → 对方手里那个值的 JSON；null = 对方那边没有这条对话记录 */
  session: Map<string, string> | null
  permissionMode: string | null
  draft: string | null
  historySummary: string | null
  compressedUserCount: number | null
}

export function emptyKnownState(): KnownState {
  return {
    messages: new Map(),
    order: [],
    session: null,
    permissionMode: null,
    draft: null,
    historySummary: null,
    compressedUserCount: null
  }
}

/** 这一边此刻的样子 */
export interface LocalState {
  messages: readonly SyncMessage[]
  session: Record<string, unknown> | null
  permissionMode: string | null
  draft: string | null
  historySummary: string | null
  compressedUserCount: number | null
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined'
}

/** 拷一份能过 IPC 的：去掉响应式代理、函数和 undefined */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/**
 * 算出要发的补丁，顺手把 `known` 更新成发出去之后的样子。没有变化返回 null。
 *
 * `dirtyIds` 是这段时间里被动过的消息；`'all'` 表示不知道动了哪条（增删、截断、整份
 * 替换），那就每条都比一遍。只比被动过的那几条是性能上的事：流式时一秒好几次，
 * 每次只有正在打字的那一条在变。
 */
export function buildPatch(
  sid: string,
  local: LocalState,
  known: KnownState,
  dirtyIds: ReadonlySet<string> | 'all',
  full = false
): ChatSyncPatch | null {
  const patch: ChatSyncPatch = { sid }
  if (full) patch.full = true
  let changed = full

  const order = local.messages.map((message) => message.id)
  if (full || !sameOrder(order, known.order)) {
    patch.order = order
    known.order = order
    changed = true
    // 顺序变了，id 集合也可能变了：删掉的那些不再记
    const alive = new Set(order)
    for (const id of [...known.messages.keys()]) if (!alive.has(id)) known.messages.delete(id)
  }

  const candidates =
    full || dirtyIds === 'all'
      ? local.messages
      : local.messages.filter((message) => dirtyIds.has(message.id))
  const messages: SyncMessage[] = []
  for (const message of candidates) {
    const print = fingerprint(message)
    if (!full && known.messages.get(message.id) === print) continue
    known.messages.set(message.id, print)
    messages.push(plain(message))
  }
  if (messages.length > 0) {
    patch.messages = messages
    changed = true
  }

  const sessionPatch = diffSession(local.session, known, full)
  if (sessionPatch) {
    patch.session = sessionPatch
    changed = true
  }

  if (full || local.permissionMode !== known.permissionMode) {
    patch.permissionMode = local.permissionMode
    known.permissionMode = local.permissionMode
    changed = true
  }
  if (full || local.draft !== known.draft) {
    patch.draft = local.draft
    known.draft = local.draft
    changed = true
  }
  if (full || local.historySummary !== known.historySummary) {
    patch.historySummary = local.historySummary
    known.historySummary = local.historySummary
    changed = true
  }
  if (full || local.compressedUserCount !== known.compressedUserCount) {
    patch.compressedUserCount = local.compressedUserCount
    known.compressedUserCount = local.compressedUserCount
    changed = true
  }

  return changed ? patch : null
}

function diffSession(
  session: Record<string, unknown> | null,
  known: KnownState,
  full: boolean
): ChatSyncSessionPatch | undefined {
  if (!session) {
    if (!full && known.session === null) return undefined
    known.session = null
    return { exists: false }
  }

  const previous = full ? null : known.session
  const next = new Map<string, string>()
  const fields: Record<string, unknown> = {}
  let hasFields = false
  for (const [key, value] of Object.entries(session)) {
    if (value === undefined) continue
    const print = fingerprint(value)
    next.set(key, print)
    if (previous?.get(key) === print) continue
    fields[key] = plain(value)
    hasFields = true
  }
  const removed = previous ? [...previous.keys()].filter((key) => !next.has(key)) : []

  known.session = next
  if (previous && !hasFields && removed.length === 0) return undefined
  return {
    exists: true,
    ...(hasFields ? { fields } : {}),
    ...(removed.length > 0 ? { removed } : {})
  }
}

/**
 * 把收到的补丁记进 `known`：这些就是对方现在手里的样子，下次别再原样发回去。
 *
 * 只能在补丁**真的打上了**之后调。被挡掉的那几条（见 `applyMessagesPatch` 的
 * `protectedId`）记的是**对方发来的那份**：对方手里确实是那样，这样下一次比较才会
 * 发现两边不一样，把这边的版本发回去。记成这边的样子的话，它永远不会再发。
 */
export function rememberPatch(
  known: KnownState,
  patch: ChatSyncPatch,
  local: LocalState,
  skippedMessageIds: ReadonlySet<string> = new Set()
): void {
  if (patch.full) {
    known.messages.clear()
    known.session = null
  }
  // 以打完补丁之后本地的真实样子为准：补丁不全（只带了变的几条）也不会记漏
  known.order = local.messages.map((message) => message.id)
  const alive = new Set(known.order)
  for (const id of [...known.messages.keys()]) if (!alive.has(id)) known.messages.delete(id)
  for (const message of patch.messages ?? []) {
    if (skippedMessageIds.has(message.id)) known.messages.set(message.id, fingerprint(message))
  }
  for (const message of patch.full ? local.messages : (patch.messages ?? [])) {
    if (skippedMessageIds.has(message.id)) continue
    const current = local.messages.find((item) => item.id === message.id)
    if (current) known.messages.set(message.id, fingerprint(current))
  }
  if (patch.session || patch.full) {
    if (!local.session) {
      known.session = null
    } else {
      const next = new Map<string, string>()
      for (const [key, value] of Object.entries(local.session)) {
        if (value !== undefined) next.set(key, fingerprint(value))
      }
      known.session = next
    }
  }
  if ('permissionMode' in patch) known.permissionMode = local.permissionMode
  if ('draft' in patch) known.draft = local.draft
  if ('historySummary' in patch) known.historySummary = local.historySummary
  if ('compressedUserCount' in patch) known.compressedUserCount = local.compressedUserCount
}

/**
 * 把补丁里的消息打到本地这份上，返回新数组和被挡掉的那几条。
 *
 * `protectedId` 是这边**正在流式写**的那条气泡：这一轮是这个窗口发起的，事件只到
 * 这里，它才是那条气泡的权威。对方发来的那份最多是 100 毫秒前从这里抄过去的，
 * 打上去只会让字往回跳一下。同理，这边在流式写的时候也不认对方的顺序 —— 对方
 * 手里的顺序可能还没有这一轮刚插进来的那条。
 */
export function applyMessagesPatch<T extends { id: string }>(
  current: readonly T[],
  patch: Pick<ChatSyncPatch, 'full' | 'order' | 'messages'>,
  protectedId?: string | null
): { messages: T[]; skipped: Set<string> } {
  const skipped = new Set<string>()
  const incoming = new Map<string, T>()
  for (const message of patch.messages ?? []) {
    if (protectedId && message.id === protectedId) {
      skipped.add(message.id)
      continue
    }
    incoming.set(message.id, message as unknown as T)
  }

  const byId = new Map(current.map((message) => [message.id, message]))
  const useOrder = Boolean(patch.order) && !protectedId

  if (useOrder || patch.full) {
    if (protectedId && patch.full) {
      // 全量也不能把正在写的那条换掉；它在本地留在原位
      const order = patch.order ?? []
      const result = order
        .map((id) => (id === protectedId ? byId.get(id) : (incoming.get(id) ?? byId.get(id))))
        .filter((message): message is T => Boolean(message))
      const kept = byId.get(protectedId)
      if (kept && !order.includes(protectedId)) result.push(kept)
      return { messages: result, skipped }
    }
    const order = patch.order ?? []
    const messages = order
      .map((id) => incoming.get(id) ?? byId.get(id))
      .filter((message): message is T => Boolean(message))
    return { messages, skipped }
  }

  // 没带顺序：就地换掉认得的，认不得的接在后面（对方新加的、顺序补丁还在路上）
  const messages = current.map((message) => incoming.get(message.id) ?? message)
  const known = new Set(current.map((message) => message.id))
  for (const [id, message] of incoming) if (!known.has(id)) messages.push(message)
  return { messages, skipped }
}

/** 把对话记录的补丁打上去。返回新的对话记录；null = 这条对话记录不存在 */
export function applySessionPatch<T extends Record<string, unknown>>(
  current: T | null,
  patch: ChatSyncSessionPatch,
  full = false
): T | null {
  if (!patch.exists) return null
  const base: Record<string, unknown> = full || !current ? {} : { ...current }
  for (const key of patch.removed ?? []) delete base[key]
  Object.assign(base, patch.fields ?? {})
  return base as T
}
