/**
 * 「思考档位阶梯」编辑器的取值逻辑。
 *
 * ## 这张表是干什么的
 *
 * 各家模型支持的思考档位差得很远：有的是 minimal/low/medium/high，
 * 有的只有 low/high/max。内核靠这张表知道「哪几档存在、厂商管它们叫什么」，
 * 输入框里的档位下拉就是照着它列的。
 *
 * 数据平时来自 pi 自带的目录（随包发的快照）。**厂商没有任何接口能报出这个**，
 * 所以 pi 目录覆盖不到的模型（新型号、自建网关、数据过期）只能由用户自己填 ——
 * 这个编辑器就是那条兜底路径。
 *
 * ## 每一档必须有三种状态
 *
 * - `inherit` 没写这个键 —— 跟随内置数据 / 内核缺省
 * - `absent`  值为 `null` —— 这一档**不存在**，下拉里不列
 * - `custom`  值为字符串 —— 存在，且厂商管它叫别的名字
 *
 * `absent` 与 `inherit` 是**两回事**，不能合并成「留空」：合并之后就没法表达
 * 「这一档我确定它没有」，界面会照旧列出模型根本没有的档位。
 */

/** 内核认识的档位，顺序即强度。`off` 不在其中 —— 它不需要映射 */
export const THINKING_LEVELS: readonly string[] = Object.freeze([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

export type LadderState = 'inherit' | 'absent' | 'custom'

export const LADDER_STATES: readonly LadderState[] = Object.freeze(['inherit', 'absent', 'custom'])

export type ThinkingLadder = Record<string, string | null> | undefined

/** 这一档现在是哪种状态 */
export function ladderState(map: ThinkingLadder, level: string): LadderState {
  if (!map || !(level in map)) return 'inherit'
  return map[level] === null ? 'absent' : 'custom'
}

/** 自定义状态下填的那个名字。其余状态下为空串 */
export function ladderValue(map: ThinkingLadder, level: string): string {
  const raw = map?.[level]
  return typeof raw === 'string' ? raw : ''
}

/**
 * 切换某一档的状态，返回**新的**表。
 *
 * 切到 `custom` 时预填档位原名：绝大多数模型的名字就是档位本身，
 * 让用户面对一个空框反而要猜该填什么。
 *
 * 表被清空时返回 undefined 而不是 `{}` —— 留一个空对象在 models.json 里，
 * 「用户配过」和「没配过」就分不开了。
 */
export function setLadderState(
  map: ThinkingLadder,
  level: string,
  state: LadderState
): ThinkingLadder {
  const next = { ...(map ?? {}) }
  if (state === 'inherit') {
    delete next[level]
  } else if (state === 'absent') {
    next[level] = null
  } else {
    next[level] = ladderValue(map, level) || level
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * 改自定义状态下那个名字。
 *
 * 清空输入框**不会**掉回 inherit：用户正在编辑，中途清空是常事，
 * 这时候把状态换掉会让输入框直接消失。空值留到保存时由主进程丢弃。
 */
export function setLadderValue(map: ThinkingLadder, level: string, value: string): ThinkingLadder {
  return { ...(map ?? {}), [level]: value }
}

/** 编辑器按钮上那个角标：配过几档。没配过时为空串 */
export function ladderBadge(map: ThinkingLadder): string {
  const count = map ? Object.keys(map).length : 0
  return count > 0 ? ` (${count})` : ''
}
