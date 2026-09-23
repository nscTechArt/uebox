/**
 * 规则策略 —— 机器人的默认决策者，也是以后任何替换策略要打败的基线。
 *
 * 三类决策点（见 `types.ts` 的 DecisionKind）都在这里用确定性规则回答。
 * 规则故意写得笨而透明：它的用处是**给出一条可复现的基线**，
 * 判定模型或大模型接进来之后，拿同一批决策点回放，得明显超过它才算数。
 */

import type { AutoplayPolicy, Choice, DecisionOption, DecisionPoint } from './types'

/**
 * 不点的按钮。
 *
 * 机器人自己挑按钮点（维护者 2026-09-23 拍板推翻了设计稿 §2.4 的「第一版不点 UI」），
 * 这一道是那个决定的护栏：设计稿 §13.5 第 40 条 —— 注入恰好点到「删除存档」
 * 「重置进度」是不可逆的，而游戏里的「购买」可能接着真实支付 SDK。
 *
 * 宁可错拦：拦错一个按钮的代价是这次没探到那个界面，报告里会写明拦了哪个；
 * 放错一个的代价可能是用户的存档。所以「退出」「离开」也在里面 ——
 * 它们多半是结束 PIE 或回主菜单，点了只会让这次试玩提前没了。
 */
export const DENIED_BUTTON_PATTERN =
  /删除|删档|清除|清空|重置|退出|离开|注销|登出|购买|支付|充值|付款|卸载|覆盖|\b(delete|erase|remove|reset|quit|exit|leave|log ?out|sign ?out|purchase|buy|pay|uninstall|overwrite|wipe|clear)\b/i

/**
 * 看着像「往前推进」的按钮：开始、继续、确定、下一步、跳过。
 * 英文词带词边界 —— 不带的话 "Display" 会命中 play、"Replay" 会被当成 pay 拦掉
 */
export const PROGRESS_BUTTON_PATTERN =
  /开始|继续|进入|确定|确认|下一步|跳过|返回游戏|\b(start|play|continue|resume|enter|begin|confirm|ok|next|skip)\b/i

export function isDeniedButton(text: string): boolean {
  return DENIED_BUTTON_PATTERN.test(text)
}

/** 脱困动作按这个顺序试，每种只试一次 */
export const UNSTICK_ORDER = [
  'jump_forward',
  'strafe_left',
  'strafe_right',
  'back_off',
  'replan'
] as const

function chooseUi(point: DecisionPoint): Choice {
  const tried = new Set(point.state.tried ?? [])
  const usable = point.options.filter(
    (option) => option.features?.enabled !== false && option.features?.denied !== true
  )
  if (usable.length === 0) {
    const denied = point.options.filter((option) => option.features?.denied === true)
    return {
      optionId: null,
      reason:
        denied.length > 0
          ? `屏幕上能点的按钮都在拦截名单里（${denied.map((o) => o.label).join('、')}）`
          : '屏幕上没有可点的按钮'
    }
  }

  const untried = usable.filter((option) => !tried.has(option.id))
  const progress = untried.find((option) => PROGRESS_BUTTON_PATTERN.test(option.label))
  if (progress) {
    return { optionId: progress.id, reason: `按钮文字「${progress.label}」像是往前推进的那个` }
  }
  if (untried.length > 0) {
    // 目标模式只想尽快回到可操作状态，没有明显的「开始」就不乱点；
    // 探索模式要把界面也走一遍，挨个点没点过的
    if (point.state.mode === 'goal') {
      return {
        optionId: null,
        reason: `没有看着像「开始 / 继续」的按钮（剩下：${untried.map((o) => o.label || o.id).join('、')}），目标模式不乱点`
      }
    }
    return { optionId: untried[0].id, reason: '探索模式：挨个点还没点过的按钮' }
  }
  return { optionId: null, reason: '这个界面上的按钮都点过了' }
}

function chooseWaypoint(point: DecisionPoint): Choice {
  if (point.options.length === 0) {
    return { optionId: null, reason: '没有候选点' }
  }
  // 新鲜度最高的：离去过的地方最远。并列时取更近的那个，少走冤枉路
  const score = (option: DecisionOption): number => Number(option.features?.novelty ?? 0)
  const distance = (option: DecisionOption): number =>
    Number(option.features?.distance ?? Number.MAX_SAFE_INTEGER)
  const best = [...point.options].sort(
    (a, b) => score(b) - score(a) || distance(a) - distance(b)
  )[0]
  return {
    optionId: best.id,
    reason: `离已经去过的地方最远（新鲜度 ${Math.round(score(best))}）`
  }
}

function chooseUnstick(point: DecisionPoint): Choice {
  const available = new Map(point.options.map((option) => [option.id, option]))
  for (const id of UNSTICK_ORDER) {
    const option = available.get(id)
    if (option && option.features?.tried !== true && option.features?.available !== false) {
      return { optionId: id, reason: `按固定顺序试下一种脱困方式：${option.label}` }
    }
  }
  return { optionId: null, reason: '几种脱困方式都试过了' }
}

/** 规则策略是同步的：显式写出来，测试和回放脚本不用 await */
export const rulePolicy = {
  name: 'rule',
  choose(point: DecisionPoint): Choice {
    switch (point.kind) {
      case 'ui':
        return chooseUi(point)
      case 'waypoint':
        return chooseWaypoint(point)
      case 'unstick':
        return chooseUnstick(point)
    }
  }
} satisfies AutoplayPolicy
