/**
 * 判定模型策略 —— 把决策点当成一道多选题交给结构化判定（Jev 一类）。
 *
 * ## 为什么是「包在规则外面」而不是替换规则
 *
 * `judge.ts` 那三条硬约束在这里一条不少：
 *
 * 1. **没配置 / 失败 / 超时 → 回落到规则。** 判定器是可选增强，不能变成新的故障源。
 * 2. **只能往保守方向偏。** 拦截名单里的按钮、禁用的按钮、已经试过的脱困方式
 *    **根本不给它看** —— 它只在规则认为安全的选项里挑。它的答案是输入，不是许可。
 * 3. **问题一律英文写。** state 里的按钮文字是中文躲不掉，问题本身不必。
 *
 * 此外 `confidence` 不够时也回落：34/33/33 的分布和 95/3/2 回的是同一个 choice，
 * 只看 choice 就是把掷骰子当判断（`confidentChoice` 的注释）。
 *
 * ## 为什么 ask 是注入的
 *
 * 真实调用在 `judge.ts`，它拖着 electron 的 `app`（读设置）。这里只要一个
 * 「给 state 和问题、回答案」的函数：工具里传 `judge`，测试和离线回放传直连 HTTP 的版本。
 */

import { isDeniedButton, rulePolicy } from './policy'
import type { AutoplayPolicy, Choice, DecisionOption, DecisionPoint } from './types'

/** 与 `judge.ts` 的 ChoiceQuestion / ChoiceAnswer 同形；这里不 import，免得把 electron 拖进来 */
export interface JudgeChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string | null>
}

export interface JudgeChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

export type AskJudge = (
  state: Record<string, unknown>,
  questions: Record<string, JudgeChoiceQuestion>
) => Promise<{ answers: Record<string, unknown>; model?: string } | null>

export interface JudgePolicyOptions {
  ask: AskJudge
  /** 低于这个 confidence 就回落到规则。默认 0.5 —— 起点，不是调好的值 */
  minConfidence?: number
  /**
   * 哪几类决策点交给判定器，其余直接走规则。默认只有 `ui`。
   *
   * 2026-09-23 第一次真调用（tests/manual/autoplay-jev.mts）：waypoint 6 次全部
   * 不够笃定（0.22–0.48）—— 选路点靠比数字，正是厂商自己列的「不会数数」；
   * unstick 32 次里只有 5 次过了 0.5，过了的也只是在「跳 / 让 / 退」之间凭空挑一个
   * （它看不见障碍物）。每次还要花 ~350ms。只有按钮文字这一类它有东西可读。
   */
  kinds?: ReadonlyArray<DecisionPoint['kind']>
  /** 每次问完的回调（记录延迟、原始分布），给评测脚本用 */
  onAnswer?: (event: JudgeEvent) => void
}

export interface JudgeEvent {
  kind: DecisionPoint['kind']
  offered: string[]
  answer: JudgeChoiceAnswer | null
  ms: number
  usedJudge: boolean
  fallbackReason?: string
}

/** 「一个都不该点」的哨兵选项。给判定器一个说「没有」的出口，否则它只能硬挑一个 */
const NONE = '__none__'

const INSTRUCTIONS: Record<DecisionPoint['kind'], string> = {
  ui:
    'A game is showing a menu that blocks play. An automated tester must press one on-screen button ' +
    'to get into (or back to) normal gameplay. Pick the button whose text most likely starts, resumes ' +
    `or continues play. Pick "${NONE}" if none of the buttons would lead to gameplay. ` +
    'The `state.tried` list holds buttons already pressed on this screen; prefer ones not yet tried.',
  waypoint:
    'An automated tester is exploring a game level and must pick the next point to walk to. ' +
    'Prefer the point that covers the most new ground: a higher `novelty` means farther from anywhere ' +
    'already visited; `visits` counts how often that area was entered. Among similar candidates prefer the closer one.',
  unstick:
    "An automated tester's character is stuck against an obstacle while walking toward a waypoint. " +
    'Pick the recovery move most likely to get it moving again.'
}

function offeredOptions(point: DecisionPoint): DecisionOption[] {
  switch (point.kind) {
    case 'ui':
      // 保守方向：危险按钮、禁用按钮不进选项表 —— 判定器只能在安全集合里挑
      return point.options.filter(
        (o) =>
          o.features?.enabled !== false && o.features?.denied !== true && !isDeniedButton(o.label)
      )
    case 'unstick':
      return point.options.filter(
        (o) => o.features?.tried !== true && o.features?.available !== false
      )
    case 'waypoint':
      return point.options
  }
}

function describeOption(point: DecisionPoint, option: DecisionOption): string {
  if (point.kind === 'ui')
    return option.label ? `Button text: "${option.label}"` : 'Button with no text'
  const features = Object.entries(option.features ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ')
  return features ? `${option.label} (${features})` : option.label
}

export function createJudgePolicy(options: JudgePolicyOptions): AutoplayPolicy {
  const minConfidence = options.minConfidence ?? 0.5
  const kinds = new Set(options.kinds ?? ['ui'])

  return {
    name: 'judge',
    async choose(point: DecisionPoint): Promise<Choice> {
      const offered = offeredOptions(point)
      const fallback = (reason: string, answer: JudgeChoiceAnswer | null, ms: number): Choice => {
        options.onAnswer?.({
          kind: point.kind,
          offered: offered.map((o) => o.id),
          answer,
          ms,
          usedJudge: false,
          fallbackReason: reason
        })
        const rule = rulePolicy.choose(point)
        return { ...rule, reason: `${rule.reason}（判定器${reason}，按规则）` }
      }

      if (!kinds.has(point.kind)) return fallback('不管这类决策', null, 0)
      // 只剩 0 或 1 个能选的：没有需要判断的东西，别花一次调用
      if (offered.length <= 1) return fallback('无需判断', null, 0)

      const criteria: Record<string, string | null> = {}
      for (const option of offered) criteria[option.id] = describeOption(point, option)
      if (point.kind === 'ui') criteria[NONE] = 'None of these buttons leads to gameplay'

      const started = Date.now()
      const result = await options.ask(
        { decision: point.kind, ...point.state },
        { pick: { type: 'choice', instructions: INSTRUCTIONS[point.kind], criteria } }
      )
      const ms = Date.now() - started
      const answer = result?.answers?.pick as JudgeChoiceAnswer | undefined
      if (!answer || answer.type !== 'choice') return fallback('没有回答', null, ms)
      if (answer.confidence < minConfidence) {
        return fallback(`不够笃定（${answer.confidence.toFixed(2)}）`, answer, ms)
      }

      options.onAnswer?.({
        kind: point.kind,
        offered: offered.map((o) => o.id),
        answer,
        ms,
        usedJudge: true
      })

      if (answer.choice === NONE) {
        return {
          optionId: null,
          reason: `判定器认为没有能进游戏的按钮（${answer.confidence.toFixed(2)}）`
        }
      }
      if (!criteria[answer.choice])
        return fallback(`回了不在表里的选项 ${answer.choice}`, answer, ms)
      const picked = offered.find((o) => o.id === answer.choice)
      return {
        optionId: answer.choice,
        reason: `判定器选了「${picked?.label ?? answer.choice}」（confidence ${answer.confidence.toFixed(2)}）`
      }
    }
  }
}
