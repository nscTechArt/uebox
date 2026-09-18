/**
 * 「审查本轮改动」的契约。
 *
 * 主进程、preload 类型声明、渲染层三边共用一份 —— 这些结构里最容易出问题的是
 * `code`：界面按它取文案，主进程按它归类，两边各写一份枚举必然会在某次新增
 * 检查项时分叉，表现是界面上冒出一行空白的建议。
 *
 * ## 这不是代码审查
 *
 * Codex 那类工具审的是 git diff。虚幻盒子这边没有 diff 可审 —— agent 动的是
 * 编辑器内存里的蓝图和材质，用户拿到的是「改完了」四个字。真正会咬人的是另一批
 * 东西：说建好了其实没建成、改完忘了保存、蓝图编译报错、引用指向了不存在的资产。
 * 这些引擎自己知道，只是从来没人替用户去问一遍。
 */

/** 一条要审查的改动。由界面的「本轮改动」清单折算而来 */
export interface AgentReviewTarget {
  /** 引擎内资产路径（`/Game/…`）。本地文件和 Actor 名不进这里 */
  path: string
  /** 这一轮对它做了什么。决定检查项：新建的要查在不在，删掉的要查还有谁引用它 */
  action: 'created' | 'modified' | 'deleted'
  /** 资产类别，来自改动清单。只用于命名建议，认不出就留空 */
  kind?: string
}

/**
 * 检查项。**新增时必须同步加 i18n 文案**（`assistant.review.codes.*`）。
 *
 * - `missing`：说是建好/改好了，工程里却找不到
 * - `still-there`：说是删掉了，它还在
 * - `unsaved`：改动只在编辑器内存里，没落盘
 * - `compile-error` / `compile-warning`：蓝图编译状态
 * - `broken-dependency`：这个资产引用了不存在的东西
 * - `orphan-referencer`：删掉的资产还有别人在引用
 * - `naming`：命名和 UE 惯例不一致（只对新建资产提，且只是建议）
 * - `check-failed`：这一项没查成，引擎报了错
 */
export type AgentReviewCode =
  | 'missing'
  | 'still-there'
  | 'unsaved'
  | 'compile-error'
  | 'compile-warning'
  | 'broken-dependency'
  | 'orphan-referencer'
  | 'naming'
  | 'check-failed'

/**
 * 严重程度。
 *
 * `error` 是「这一轮没做成，或者做出来的东西是坏的」；`warning` 是「做成了，
 * 但有个坑等着」；`info` 是建议，可以不理。界面按这三档排序和着色。
 */
export type AgentReviewSeverity = 'error' | 'warning' | 'info'

export interface AgentReviewFinding {
  target: string
  code: AgentReviewCode
  severity: AgentReviewSeverity
  /**
   * 附加信息：断掉的引用路径、还在引用它的资产、引擎的原始报错。
   *
   * 已经是给人看的字符串，界面直接显示。空串表示这条 code 本身就说完了。
   */
  detail?: string
}

export interface AgentReviewResult {
  /** 审查跑起来了没有。false 时 findings 一定是空的 */
  success: boolean
  /** 实际送进引擎查的资产数 */
  checked: number
  findings: AgentReviewFinding[]
  /**
   * 引擎那一半查了没有。
   *
   * 没连引擎时只剩命名这类静态检查 —— 界面必须说清楚，否则「没查出问题」
   * 会被读成「一切正常」，而实际上最要紧的几项根本没跑。
   */
  engineChecked: boolean
  /** 引擎那一半没跑成的原因，engineChecked 为 false 时才有 */
  engineError?: string
}

/** 严重程度排序用，数字小的排前面 */
export const REVIEW_SEVERITY_ORDER: Readonly<Record<AgentReviewSeverity, number>> = Object.freeze({
  error: 0,
  warning: 1,
  info: 2
})
