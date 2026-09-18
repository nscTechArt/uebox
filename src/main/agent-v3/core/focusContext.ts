/**
 * 「当前打开的资产」查询。
 *
 * 用户说「改一下当前这个蓝图」时，得知道编辑器里正开着什么。
 *
 * ## 与 V2 的区别：不再维护黑板
 *
 * V2 把这个信息缓存在 `ContextManager` 的 per-session 黑板里，靠
 * `syncFocusedEditorContext` 定期回填，工具再去黑板里翻。那套的问题是：
 *
 *   - 缓存会过期 —— 用户在引擎里切了窗口，黑板还是旧的
 *   - 与会话绑定，而「当前开着什么」是**引擎的状态**，跟哪个会话在问无关
 *   - 为了这一个字段，`ContextManager` 长到 1259 行
 *
 * V3 直接按需问引擎（`editor.get_focus_context`，UE 侧本来就有这个 RPC）。
 * 一次 RPC 的开销远小于维护一份会过期的缓存。
 */

import { serviceManager } from '../../services'

export interface FocusedEditor {
  /** blueprint / material / material_instance / … */
  type: string
  name: string
  path: string
  parentClass?: string
  parentMaterial?: string
  isModified?: boolean
  /**
   * 这个编辑器最后一次被激活的时刻（引擎的相对秒数）。
   *
   * 「哪个是焦点」就是按它选出来的 —— 以前插件取的是「打开列表里的第一个」，
   * 那个顺序跟用户看哪个窗口没关系，开着几个编辑器时基本是错的。
   */
  lastActivationTime?: number
}

/** 图里选中的一个节点。node_id 可以直接喂回 ue_bp_* / ue_material_* */
export interface SelectedNode {
  /** 蓝图是 NodeGuid，材质是表达式编号；注释框这类没有对应 id 的节点没有这个字段 */
  node_id?: string
  /**
   * 材质节点的稳定 GUID（`MaterialExpressionGuid`）。蓝图节点没有这个字段 ——
   * 它的 `node_id` 本身就是 NodeGuid，已经是稳的。
   *
   * 材质的 `node_id` 是**位置编号**（`类名_数组下标`），删掉前面一个节点后面全体
   * 位移，旧编号会指向另一个同类节点**而且不报错**。所以任何隔了一段时间才用的
   * 场景（闪存就是）必须认这个 GUID，别认 node_id。
   */
  guid?: string
  class: string
  title: string
  pos_x: number
  pos_y: number
}

export interface SelectedActor {
  name: string
  /** 大纲里显示的那个名字 */
  label: string
  class: string
  path: string
}

/**
 * 编辑器此刻的焦点与选中状态。
 *
 * 前三个字段是老的「开着什么」；其余是「用户指的是什么」——
 * 用户说「把**这个**节点改成 X」时靠的就是它们。
 * 组装在插件侧 UAL_FocusContext.cpp。
 */
export interface FocusContext {
  focusedEditor?: FocusedEditor
  openEditors?: Array<{ type: string; name: string; path: string; lastActivationTime?: number }>
  hasOpenEditors?: boolean

  /** 蓝图编辑器当前聚焦的那张图。材质编辑器只有一张图，不报这个字段 */
  focusedGraph?: { name: string; path: string; node_count: number }
  selectedNodes?: SelectedNode[]
  selectedNodeCount?: number
  selectedNodesTruncated?: boolean

  selectedActors?: SelectedActor[]
  selectedActorCount?: number
  selectedActorsTruncated?: boolean

  contentBrowser?: {
    selectedAssets: Array<{ name: string; path: string; class?: string }>
    selectedAssetCount: number
    selectedAssetsTruncated: boolean
    selectedFolders: string[]
  }
}

/** 查询超时。这是个辅助查询，卡住的话宁可当查不到也不要拖住工具调用 */
const TIMEOUT_MS = 5_000

/**
 * 问引擎当前开着什么。
 *
 * 查不到一律返回空对象而不是抛 —— 调用方要的是「有就用，没有就走别的路径」，
 * 抛异常会把一个可降级的辅助查询变成硬失败。
 */
export async function getFocusContext(): Promise<FocusContext> {
  try {
    const ws = serviceManager.getWebSocketService()
    if (ws.getConnectionCount() === 0) return {}
    return await ws.callRequest<FocusContext>('editor.get_focus_context', {}, undefined, TIMEOUT_MS)
  } catch (error) {
    console.warn('[AgentV3] 查询焦点编辑器失败:', (error as Error).message)
    return {}
  }
}

/** 当前聚焦的蓝图路径。不是蓝图或查不到时返回 undefined */
export async function getFocusedBlueprintPath(): Promise<string | undefined> {
  const context = await getFocusContext()
  const editor = context.focusedEditor
  if (editor?.type === 'blueprint' && editor.path) return editor.path

  // 焦点不是蓝图时退而求其次：打开的编辑器里找一个蓝图
  return context.openEditors?.find((item) => item.type === 'blueprint')?.path
}
