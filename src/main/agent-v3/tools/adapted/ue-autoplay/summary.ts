/**
 * 把一次试玩读成一段结论。
 *
 * 和 `ue_playtest` 的 summarize 同一个理由：模型不一定逐条看数组，
 * 而这份报告里最容易被说错的几件事 —— 「探索没出事 ≠ 功能正常」
 * 「机器人走得动 ≠ 玩家按得动」—— 必须写进正文，不能只留在字段里。
 */

import { formatVec } from './geometry'
import type { AutoplayResult, Finding, FindingKind } from './runner'
import type { PieRunReport } from './types'

const OUTCOME_HEADLINE: Record<AutoplayResult['outcome'], string> = {
  goal_reached: '✅ 目标达成',
  goal_failed: '❌ 目标没达成',
  explored: '探索跑完',
  no_pawn: '❌ 没有可操作的玩家角色',
  blocked_by_ui: '⚠️ 卡在界面上',
  no_movement: '⚠️ 找不到能让角色走动的输入',
  session_ended: '⚠️ 游戏提前停了',
  objective_done: '判定模型认为目标已完成',
  objective_unfinished: '❌ 时间用完，目标没完成'
}

const FINDING_LABEL: Record<FindingKind, string> = {
  error_after_action: '运行时错误',
  fell_out: '掉出世界',
  long_fall: '一直在往下掉',
  respawned: '角色重生',
  pawn_lost: '角色没了',
  stuck: '卡住',
  unreachable: '到不了',
  target_missing: '找不到目标',
  blocked_by_ui: '卡在界面上',
  no_movement_binding: '没有移动输入',
  move_input_ignored: '移动输入被游戏忽略',
  edge_avoided: '边缘没护栏'
}

/** 越靠前越要紧 */
const FINDING_ORDER: FindingKind[] = [
  'error_after_action',
  'fell_out',
  'long_fall',
  'pawn_lost',
  'respawned',
  'unreachable',
  'target_missing',
  'blocked_by_ui',
  'stuck',
  'no_movement_binding',
  'edge_avoided',
  'move_input_ignored'
]

function describeFinding(finding: Finding): string {
  const where = finding.at ? ` @ ${formatVec(finding.at)}` : ''
  const when = typeof finding.t === 'number' ? `第 ${finding.t.toFixed(1)} 秒` : ''
  const after = finding.after ? `，上一步：${finding.after}` : ''
  return `- [${FINDING_LABEL[finding.kind]}] ${when}${where}${after}：${finding.detail}`
}

export function summarizeAutoplay(
  result: AutoplayResult,
  report: PieRunReport | null,
  tracePath?: string
): string {
  const lines: string[] = []

  lines.push(
    `${OUTCOME_HEADLINE[result.outcome]}${result.outcomeNote ? `：${result.outcomeNote}` : ''}`
  )

  const stats = [
    `${result.steps} 步操作`,
    `${result.decisions} 个决策点`,
    `走过 ${result.cellsVisited} 个格子（每格 4 米）`,
    `累计移动约 ${Math.round(result.distanceTravelled / 100)} 米`
  ]
  if (report?.elapsed_seconds !== undefined) stats.unshift(`跑了 ${report.elapsed_seconds} 秒`)
  lines.push(stats.join('，'))

  if (result.goal) {
    const goal = result.goal
    const parts: string[] = []
    if (goal.targetLabel) {
      parts.push(
        goal.reachedTarget
          ? `走到了「${goal.targetLabel}」`
          : `没走到「${goal.targetLabel}」${goal.closestDistance !== undefined ? `（最近 ${goal.closestDistance} 单位）` : ''}`
      )
    }
    if (goal.pressed) parts.push('到位后按了指定的输入')
    if (goal.logSeen !== undefined)
      parts.push(goal.logSeen ? '等到了指定的 PrintString' : '没等到指定的 PrintString')
    if (parts.length > 0) lines.push(`目标：${parts.join('；')}`)
  }

  // 怎么动的 —— 决定了下面每条结论的适用范围
  const how: string[] = []
  if (result.move) {
    how.push(
      result.move.kind === 'action'
        ? `移动用动作 ${result.move.name}（${result.move.axis} 轴，动作层注入）`
        : `移动用按键 ${result.move.name}`
    )
  }
  if (result.jump)
    how.push(`跳跃用${result.jump.kind === 'action' ? '动作' : '按键'} ${result.jump.name}`)
  if (how.length > 0) lines.push(how.join('；'))
  for (const note of result.calibrationNotes) lines.push(`⚠️ ${note}`)

  const findings = [...result.findings].sort(
    (a, b) => FINDING_ORDER.indexOf(a.kind) - FINDING_ORDER.indexOf(b.kind)
  )
  if (findings.length > 0) {
    lines.push('', `## 发现（${findings.length}）`)
    for (const finding of findings) lines.push(describeFinding(finding))
  } else if (result.outcome === 'explored') {
    lines.push('', '这一轮没发现卡住、掉出世界或运行时错误。')
  }

  if (result.controller) {
    const c = result.controller
    const sorted = [...c.latencyMs].sort((a, b) => a - b)
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
    const counts = Object.entries(c.actionCounts)
      .map(([kind, n]) => `${kind} ${n}`)
      .join('、')
    lines.push(
      '',
      '## 控制器',
      `- 决策者：${c.brain === 'judge' ? '判定模型（Jev）' : '规则基线'}，${c.ticks} 步` +
        (c.brain === 'judge'
          ? `，其中 ${c.judgeDecisions} 步由判定模型选（延迟中位 ${p50}ms）`
          : ''),
      `- 动作分布：${counts || '无'}`
    )
    if (c.lastDone !== undefined) {
      lines.push(
        `- 最后一步判定模型认为「目标已完成」的概率 ${c.lastDone.toFixed(2)} ` +
          '—— **这是判断，不是断言**；要确证就给 until_log'
      )
    }
  }

  if (result.sweep.length > 0) {
    const silent = result.sweep.filter(
      (entry) => entry.effects.length === 0 && entry.errors.length === 0
    )
    const erroring = result.sweep.filter((entry) => entry.errors.length > 0)
    lines.push('', `## 输入扫描（${result.sweep.length} 个动作）`)
    for (const entry of erroring) {
      lines.push(`- ${entry.action}：**按下后报错** —— ${entry.errors[0]}`)
    }
    for (const entry of result.sweep.filter((e) => e.effects.length > 0 && e.errors.length === 0)) {
      lines.push(`- ${entry.action}：${entry.effects.join('、')}`)
    }
    if (silent.length > 0) {
      lines.push(
        `- 没观察到效果：${silent.map((entry) => entry.action).join('、')} —— ` +
          '**不等于坏了**：放音效、改界面数字、在别处生成东西、需要特定条件才生效，这里都看不见'
      )
    }
  }

  if (result.uiClicks.length > 0 || result.uiDenied.length > 0) {
    lines.push('', '## 界面')
    for (const click of result.uiClicks) lines.push(`- 点了「${click.text}」（${click.reason}）`)
    if (result.uiDenied.length > 0) {
      lines.push(
        `- 没点（在拦截名单里）：${result.uiDenied.map((text) => `「${text}」`).join('、')}`
      )
    }
  }

  if (report) {
    const run: string[] = []
    if (report.error_count) run.push(`${report.error_count} 个运行时错误`)
    if (report.warning_count) run.push(`${report.warning_count} 个警告`)
    run.push(`${report.print_strings?.length ?? 0} 条 PrintString`)
    if (report.fixed_fps) run.push(`固定步长 ${report.fixed_fps} fps`)
    if (report.ended_by === 'stopped_externally')
      run.push('**被外部停止**（用户按了停止或游戏自己退出）')
    lines.push('', `整段运行：${run.join('，')}（明细见 errors / print_strings）`)
    const editorOnly = report.levels?.editor_only_levels ?? []
    if (editorOnly.length > 0) {
      lines.push(
        `⚠️ ${editorOnly.length} 个子关卡没进这次游戏世界（${editorOnly.join('、')}），地面或墙可能少了一块`
      )
    }
  }

  // 适用范围 —— 每次都要说
  lines.push('', '## 这份报告证明不了什么')
  if (result.move?.kind === 'action') {
    lines.push(
      '- 移动走的是动作层注入，**绕开了键位映射**：机器人走得动不代表按键绑对了，验键位用 ue_inject_input 的 key'
    )
  }
  if (result.uiClicks.length > 0) {
    lines.push('- 点按钮是直接触发 OnClicked，**没走屏幕命中测试**：点得开不代表玩家点得到')
  }
  if (result.outcome === 'explored') {
    lines.push(
      '- 探索模式没有断言，**只能说明这段时间里没崩、没卡死、没掉出世界**，不能据此说某个功能正常'
    )
  }
  for (const warning of result.inputWarnings) lines.push(`- ${warning}`)
  if (result.logsDropped) lines.push('- 日志刷得太快，中间有一段被挤掉了，按动作归因的错误可能不全')

  if (tracePath) lines.push('', `决策记录：${tracePath}`)

  return lines.join('\n')
}
