/**
 * 库详情页嵌进来的那个助手，每一轮要额外知道的东西。
 *
 * ## 为什么需要这一层
 *
 * 蓝图库 / 材质库的详情页里嵌的是**主助手本身**（`Welcome.vue`），
 * 和知识库那边是同一个组件、同一套工具、同一个内核。但用户在那个页面里
 * 说「这段为什么每帧都跑」时，「这段」指的是他正在看的条目、
 * 甚至是他刚在画布上框选的那几个节点 —— 助手不看页面，它什么都不知道。
 *
 * 所以每一轮请求前，把「他正在看什么」作为一条上下文消息塞到最前面。
 * 做法和知识库的 RAG 注入完全一样（见 `notebookRagContext.ts`），
 * 走的也是 `useAgentMode` 里同一个 `finalMessages.unshift` 接缝。
 *
 * ## 为什么正文由领域侧拼好再传进来
 *
 * 蓝图条目要讲的是节点和连线，材质条目要讲的是参数、贴图依赖、函数依赖 ——
 * 差得很远，硬塞进一个共用的结构里只会得到一堆 `xxx?: number`。
 * 这里只管**怎么组装成一条消息**，`overview` 那段人话由页面自己拼。
 *
 * ## 这条消息不会进历史
 *
 * 它在发请求前 unshift 进去，不写进会话消息列表，所以不会一轮一轮累积 ——
 * 每一轮带的都是**当下**的选中节点，用户点了别的节点就跟着变。
 */

/** 画布上被选中的一个节点。文本由调用方压缩好，这里不做加工 */
export interface LibraryChatSelectedNode {
  /** 给人看的名字，如「打印字符串」 */
  label: string
  /** 节点的序列化文本，已经压缩/截断过。没有就只报名字 */
  code?: string
}

export interface LibraryChatContext {
  library: 'blueprint' | 'material'
  entryId: string
  entryName: string
  /** 条目概况，领域侧拼好的纯文本（节点数、参数、依赖……） */
  overview?: string
  /** 当前选中的节点。空数组 = 没选 */
  selectedNodes?: LibraryChatSelectedNode[]
}

export interface LibraryContextMessage {
  role: 'user'
  content: string
}

/** 一条消息里最多带几个选中节点。再多模型也读不完，而且会把这一轮的正事挤掉 */
const MAX_SELECTED_NODES = 8

const LIBRARY_LABEL: Record<LibraryChatContext['library'], string> = {
  blueprint: '蓝图库',
  material: '材质库'
}

/**
 * 拼出那条上下文消息。没有条目 id 就返回 null（调用方不注入）。
 */
export function buildLibraryContextMessage(
  context: LibraryChatContext | null | undefined
): LibraryContextMessage | null {
  if (!context?.entryId) return null

  const libraryLabel = LIBRARY_LABEL[context.library] ?? '库'
  const parts: string[] = [
    `[当前上下文] 用户正在虚幻盒子的${libraryLabel}里看一个条目，下面这些是他屏幕上的东西。`,
    `条目：「${context.entryName}」（${libraryLabel}，id: ${context.entryId}）`
  ]

  const overview = context.overview?.trim()
  if (overview) parts.push(overview)

  const selected = context.selectedNodes ?? []
  if (selected.length > 0) {
    const shown = selected.slice(0, MAX_SELECTED_NODES)
    const lines = shown.map((node) => {
      const code = node.code?.trim()
      return code ? `- ${node.label}\n  节点文本：\n${code}` : `- ${node.label}`
    })

    parts.push(
      `用户当前在画布上选中了 ${selected.length} 个节点` +
        (selected.length > shown.length ? `（只列出前 ${shown.length} 个）` : '') +
        '：\n' +
        lines.join('\n') +
        '\n**优先围绕这几个节点回答**，没有依据时不要扩展到没选中的节点。'
    )
  }

  /*
   * 这一段是在纠正旧面板留下的一个错误预期。
   *
   * 旧的库内聊天框没有工具、连不上引擎，它的提示词里写着「不要假设可以直接
   * 连接 Unreal Editor」。换成主助手之后这句话是反的 —— 它手上有整套引擎工具。
   * 不说清楚的话，模型会守着旧习惯：明明能去工程里查，却只对着这段文本猜。
   */
  parts.push(
    '注意：库里的条目是**离线文本**，不是用户工程里那个活的资产。' +
      '要看活的工程或者动它，用你手上的引擎工具；' +
      '要把这段逻辑放进工程，用库的放回工具，别让用户自己复制粘贴。'
  )

  return { role: 'user', content: parts.join('\n\n') }
}
