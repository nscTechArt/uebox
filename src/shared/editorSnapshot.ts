/**
 * 「闪存」的跨进程类型 —— 用户按下发送那一刻的编辑器状态。
 *
 * 三个进程都要认识它：主进程抓取并拼进提示词，预加载层过桥，渲染层在提交那一刻
 * 抓好、随消息一起交下去。所以类型放这里，逻辑在
 * `main/agent-v3/core/editorSnapshot.ts`（那边 re-export 这些类型，主进程侧不用
 * 两处 import）。
 *
 * **它整条链上不进界面。** 闪存是后台的潜规则：用户刚做完选择，不需要每条消息
 * 下面再被告知一次「你当时选了什么」。为什么要有闪存，见那个文件的头注释。
 */

/** 焦点上下文里的一个节点。与主进程 `core/focusContext.ts` 的 `SelectedNode` 同形 */
export interface EditorSnapshotNode {
  /** 蓝图是 NodeGuid（稳）；材质是位置编号（会漂，改图要用 guid） */
  node_id?: string
  /** 材质节点的稳定 GUID。蓝图节点没有这个字段 —— 它的 node_id 本身就是 GUID */
  guid?: string
  class: string
  title: string
  pos_x: number
  pos_y: number
}

/**
 * 插件报上来的焦点上下文原文。
 *
 * 结构与 `main/agent-v3/core/focusContext.ts` 的 `FocusContext` 一致；这里重新声明
 * 而不是从主进程 import，是因为渲染层和预加载层不该依赖 `src/main/**`。
 * 字段都是可选的：插件任何一段查不到只是少一个字段，不是整体失败。
 */
export interface EditorSnapshotFocus {
  focusedEditor?: { type: string; name: string; path: string }
  focusedGraph?: { name: string; path: string; node_count: number }
  selectedNodes?: EditorSnapshotNode[]
  selectedNodeCount?: number
  selectedNodesTruncated?: boolean
  selectedActors?: Array<{ name: string; label: string; class: string; path: string }>
  selectedActorCount?: number
  selectedActorsTruncated?: boolean
  contentBrowser?: {
    selectedAssets: Array<{ name: string; path: string; class?: string }>
    selectedAssetCount: number
    selectedAssetsTruncated: boolean
    selectedFolders: string[]
  }
}

/** 一份钉死的编辑器状态。整条消息的生命周期里它不再变 */
export interface EditorSnapshot {
  /** 抓取时刻。模型按它判断「这是多久之前的事」 */
  capturedAt: string
  /**
   * 从哪个工程抓的。
   *
   * **身份认 `projectPath`，不认 `connectionId`** —— 编辑器重连一次连接 id 就换，
   * 工程还是那个工程。执行前比对的也是路径。
   */
  project: { projectName: string; projectPath?: string; connectionId: string }
  /** 插件回的原文，一个字段都不改 */
  focus: EditorSnapshotFocus
}

/**
 * 拍成一个能过结构化克隆的普通对象。
 *
 * 快照在渲染层会被存进 Pinia（排队里的那份），取出来就是 Vue 的**响应式代理**——
 * 而 Electron 的 IPC 搬不动 Proxy，直接抛 `An object could not be cloned.`。
 * 表现分两种，都不像是闪存的锅：抓取那一路被兜底吞掉，变成「没有快照」；
 * 排队投递那一路整条消息发不出去。
 *
 * `toSessionProjectPayload` 的注释里记着同一个坑的上一次发作。所以这次把它钉在
 * **过桥的那一层**（`api/agentV3.ts`、`api/ai.ts`），而不是指望每个调用方记得转 ——
 * 调用方有五个，将来还会更多。
 *
 * 用 JSON 往返而不是 `toRaw`：`toRaw` 只解一层，嵌套的 `focus.selectedNodes` 里
 * 每个元素仍是代理。快照是纯数据，往返一次是安全且彻底的。
 */
export function toPlainEditorSnapshot(
  snapshot: EditorSnapshot | null | undefined
): EditorSnapshot | null {
  if (!snapshot) return null
  try {
    return JSON.parse(JSON.stringify(snapshot)) as EditorSnapshot
  } catch {
    // 快照本来就该是纯 JSON，走到这儿说明上游给了别的东西 —— 宁可不带
    return null
  }
}

/**
 * Spotlight 里按回车带进小窗口的那条初始消息。
 *
 * 从一个裸字符串变成对象，就是为了让快照跟着走：抓取必须发生在用户按回车那一刻，
 * 而小窗口要等建窗口 + 页面加载 + 500ms 挂载延迟才收得到这条消息。
 */
export interface MiniChatInitialMessage {
  text: string
  /** 按回车那一刻的编辑器状态。抓不到就是 null，不影响这条消息发出去 */
  editorSnapshot?: EditorSnapshot | null
  /** 快照来自哪个工程。渲染层拿它当这条消息的 sessionProject，保证抓的和执行的是同一个 */
  sessionProject?: { projectName: string; projectPath?: string } | null
}

/**
 * 抓取结果。
 *
 * 失败分四种是给日志和排查用的 —— 对模型来说效果一样（整块不出现），
 * 但「归属工程不在线」和「插件没响应」是完全不同的两件事。
 *
 * **成功和失败必须分得开**：把一次超时写成「用户什么都没开着」送进模型，
 * 比不给这个块糟得多。
 */
export type EditorSnapshotCaptureResult =
  | { ok: true; snapshot: EditorSnapshot }
  | { ok: false; reason: 'not-connected' | 'project-offline' | 'timeout' | 'error' }
