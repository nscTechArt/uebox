/**
 * 侧边栏会话列表的多选逻辑 —— 纯函数，不碰 Vue、不碰 store。
 *
 * 交互契约和资产库的 `useFileSelection` 一致，都是 Windows 资源管理器的标准：
 *
 * | 操作 | 行为 |
 * |---|---|
 * | 普通点击 | 没有多选时：照旧直接打开这条会话；已在多选中：只选这一条 |
 * | Ctrl / Cmd + 点击 | 把这一条加进 / 移出选择 |
 * | Shift + 点击 | 选中锚点到这一条的整段（替换之前的选择） |
 * | Esc / 批量栏的 ✕ | 清空选择 |
 *
 * 「锚点」是最近一次普通 / Ctrl 点击的那条；Shift 点击不移动锚点，
 * 所以可以连续 Shift 点击把范围越拉越大或往回缩。
 */

/** 点击时按下的修饰键（鼠标事件原样透传即可） */
export interface ChatSelectionModifiers {
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

export interface ChatSelectionClickResult {
  /** 点击之后的选择集，按 visibleIds 的顺序排列 */
  selected: string[]
  /** 新锚点 */
  anchor: string
  /**
   * 普通点击且之前没有任何选择时为 true —— 保持历史行为，直接打开这条会话。
   * 进了多选世界后普通点击只改选择，打开交给双击。
   */
  open: boolean
}

/**
 * visibleIds 里锚点到目标之间的所有 id（含两端，方向无关）。
 * 锚点不在列表里（被删了 / 被归档了 / 折叠进别的分组）就退化为只选目标。
 */
export function resolveSelectionRange(
  visibleIds: readonly string[],
  anchorId: string,
  targetId: string
): string[] {
  const anchorIndex = visibleIds.indexOf(anchorId)
  const targetIndex = visibleIds.indexOf(targetId)

  if (anchorIndex === -1 || targetIndex === -1) {
    return [targetId]
  }

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return visibleIds.slice(start, end + 1)
}

/**
 * 处理一条会话行上的点击，返回新的选择集、锚点和是否要打开会话。
 *
 * @param selected 点击前的选择集
 * @param anchorId 点击前的锚点；空串表示还没有锚点
 * @param visibleIds 界面上会话行的渲染顺序（跨置顶 / 工程 / 对话区摊平）
 * @param targetId 被点的会话
 */
export function applySessionClick(
  selected: readonly string[],
  anchorId: string,
  visibleIds: readonly string[],
  targetId: string,
  modifiers: ChatSelectionModifiers
): ChatSelectionClickResult {
  if (modifiers.ctrlKey || modifiers.metaKey) {
    const next = selected.includes(targetId)
      ? selected.filter((id) => id !== targetId)
      : [...selected, targetId]
    return { selected: next, anchor: targetId, open: false }
  }

  if (modifiers.shiftKey) {
    const anchor = anchorId || targetId
    return { selected: resolveSelectionRange(visibleIds, anchor, targetId), anchor, open: false }
  }

  // 普通点击：没有选择时维持「点击即打开」的老习惯；已经在多选里就只改选择
  if (selected.length === 0) {
    return { selected: [], anchor: targetId, open: true }
  }
  return { selected: [targetId], anchor: targetId, open: false }
}

/**
 * 把选择里已经不存在的 id 摘掉（会话被删除、归档、过滤出列表之后）。
 * 顺序跟随传入的选择集，剩空了批量栏自然消失。
 */
export function pruneSelection(
  selected: readonly string[],
  existingIds: ReadonlySet<string>
): string[] {
  return selected.filter((id) => existingIds.has(id))
}
