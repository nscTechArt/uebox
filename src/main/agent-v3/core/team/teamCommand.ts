/**
 * `/team <一句话>`：开启工作室模式。
 *
 * 和 `/goal` 并列、互不相干（见 `goalLoop.ts` 的 `parseGoalCommand`）。命令词在主进程
 * 吃掉，模型收到的是目标本身 —— 理由同 `/goal`：渲染层多带一个字段，
 * 「从断点继续」、语音派活这些不经过输入框的路径就都得各自补一遍。
 *
 * 设计稿：docs/AI游戏工作室设计-2026-09-25.md。
 */
export function parseTeamCommand(prompt: string): string | null {
  const match = /^\s*\/team\b[ \t]*([\s\S]*)$/.exec(prompt)
  if (!match) return null
  const objective = (match[1] ?? '').trim()
  // 只打了 `/team`：当普通消息发出去，让模型自己问要做什么。
  // 在这里报错的话，用户得到的是一句系统错误，而不是一次对话
  return objective || null
}

/**
 * 这一轮挂哪一套：`/goal` 的复核还是工作室的交付闸。
 *
 * 两套都跨轮沿用，又各有一道收尾闸 —— 叠在一起的话收尾时两道都往回推，
 * 复核员和验收员各跑一遍，谁也没设计过这种组合。所以只留一套：
 * 新敲的命令替掉旧的；都没敲就沿用上一轮。老执行记录里两套都在的，留工作室
 * （团队、任务板都在盘上，丢掉代价更大）。
 */
export function activeLoop(
  typed: 'goal' | 'team' | null,
  previous: { goal?: unknown; team?: unknown } | undefined
): 'goal' | 'team' | null {
  if (typed) return typed
  if (previous?.team) return 'team'
  if (previous?.goal) return 'goal'
  return null
}
