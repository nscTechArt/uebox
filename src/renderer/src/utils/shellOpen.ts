/**
 * 「打开某个东西」失败了要说出来。
 *
 * 主进程那批 `shell:*` 处理器（ipc/shell.ts）失败时**返回** `{ success: false, error }`，
 * 而不是抛异常 —— 它们还特意把「路径不存在」单拎成 `pathNotFound`，就是为了让用户
 * 分得清是文件没了还是盒子出毛病。可渲染层十来处写的是：
 *
 *   try { await window.api.shell.openPath(p) } catch { message.error(...) }
 *
 * 返回值没人看，catch 又永远不触发（人家根本不抛）。于是打不开的结果是**点了完全
 * 没反应**，用户只能怀疑按钮坏了。这不是假想，是用户实际报上来的现象
 * （右键「打开本地路径」，浏览路径填错，静默）。
 *
 * 这里只做判断、不碰 UI：返回「要不要提示、提示哪一条」，消息和 i18n 交给调用方，
 * 这样能单测，也不用把 antd 拖进工具函数里。
 */

export interface ShellOpenResult {
  success: boolean
  error?: string
  pathNotFound?: boolean
}

export interface ShellOpenFailure {
  /** 路径不存在是用户自己能修的，不算错误，用 warning */
  level: 'warning' | 'error'
  /** 打不开的那个目标，必须带给用户 —— 十次失败九次是路径本身不对 */
  target: string
  /** 系统给的原因，可能为空 */
  error: string
  pathNotFound: boolean
}

/**
 * @returns 打开成功返回 null；失败返回该怎么提示
 */
export function describeShellOpenFailure(
  result: ShellOpenResult | undefined | null,
  target: string
): ShellOpenFailure | null {
  if (result?.success) return null

  return {
    level: result?.pathNotFound ? 'warning' : 'error',
    target,
    error: result?.error || '',
    pathNotFound: Boolean(result?.pathNotFound)
  }
}
