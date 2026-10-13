/**
 * 队员此刻在干什么 → 办公室里的小人该做什么动作。
 *
 * 只按工具名的词根粗分五类，分错了顶多是小人换个姿势，不影响任何判断；
 * 小人头顶的悬停卡片照样写着真实的工具名。
 */

export type ToolKind =
  /** 改东西：建、设、连、删、存 —— 敲键盘 */
  | 'write'
  /** 看东西：读图表、搜资产、查日志 —— 盯屏幕、翻页 */
  | 'read'
  /** 等机器：编译、跑脚本、执行命令 —— 往后一靠等进度条 */
  | 'run'
  /** 看画面：截图、对准视口 —— 屏幕上是一张小风景 */
  | 'look'
  /** 试玩 —— 拿手柄 */
  | 'play'
  /** 跟队友说话 */
  | 'talk'

const RULES: [RegExp, ToolKind][] = [
  [/^team_/, 'talk'],
  [/(autoplay|playtest|inject_input)/, 'play'],
  [/(screenshot|capture|focus_viewport|preview|analyze_(image|video))/, 'look'],
  [/(compile|run_|console_command|build|restart|trace|collect_garbage|fixup)/, 'run'],
  [
    /(describe|^ue_get_|_get_|search|list|inspect|audit|slice|dependencies|referencers|read|find|guidelines|log|health|stats|ranking|refs|size_map|_map$)/,
    'read'
  ]
]

export function toolKind(tool: string | undefined): ToolKind {
  const name = (tool ?? '').toLowerCase()
  for (const [pattern, kind] of RULES) if (pattern.test(name)) return kind
  return 'write'
}
