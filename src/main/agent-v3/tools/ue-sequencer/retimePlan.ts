/**
 * 重定时的算术。**纯函数，不碰引擎。**
 *
 * ## 为什么单独一个文件、为什么先做它
 *
 * 「改一个镜头的时长」要同时改四个地方：子序列内部的 playback range、
 * 父层 shot section、Camera Cuts section、**下游所有 shot 的起点**。
 * 引擎的 `Auto Size` 只管第二层，不做 ripple。
 *
 * 少改一处 = 一条不同步的序列 —— **比不给工具更糟**。所以这段计算是整个
 * 重定时功能里最不能错的部分，把它抽成纯函数就能穷举测，不用开编辑器。
 *
 * 这也是「算术归工具，判断归模型」的落点：让模型自己算帧号，早晚会错一帧，
 * 而错一帧就是穿帮。
 *
 * ## 时间约定
 *
 * 所有区间都是**闭开** `[start, end)`。段长 = `end - start`。
 * 前一段的 `end` 就是后一段应有的 `start`，**不要再 +1**。
 */

/** 一个可被重定时的段 */
export interface PlanSection {
  /** 稳定标识。由调用方生成，不用下标 —— 一次 ripple 就让下标全错位 */
  id: string
  /** 归属：哪条轨道上的 */
  track: string
  kind: 'shot' | 'camera_cut' | 'other'
  start: number
  end: number
  /**
   * 这个 shot 段指向的子序列。只有 `kind: 'shot'` 才有。
   * 父层段长与子序列内部时长要保持一致，否则截尾或留白。
   */
  subSequence?: { path: string; innerStart: number; innerEnd: number }
}

export interface PlanInput {
  /** 序列自身的播放范围 */
  playback: { start: number; end: number }
  sections: PlanSection[]
}

/**
 * 拉长/缩短一个段的两种含义。**必须让用户选，不许工具替他猜。**
 *
 * 「这个镜头加 2 秒」在专业用户嘴里是两件完全不同的事：
 *
 *   - `extend` —— 时长变长，**关键帧位置不动**，多出来的时间加在末尾。
 *     运动速度感不变，相当于在结尾多停一会儿
 *   - `scale`  —— 关键帧**按比例拉开**，同样的动作用更长时间演完，看起来变慢
 *
 * 猜错的代价是用户要把整段重做。
 */
export type StretchMode = 'extend' | 'scale'

export type RetimeOp =
  | {
      /** 在某一帧处插入/删除时间，其后的一切整体平移 */
      type: 'shift_after'
      /** 从这一帧起（含）开始受影响 */
      pivot: number
      /** 正数插入时间，负数删除时间 */
      delta: number
    }
  | {
      /** 把某个段改成指定时长，下游顺延 */
      type: 'set_duration'
      sectionId: string
      duration: number
      mode: StretchMode
    }

/** 一个段的改动。`before === after` 的段不会出现在计划里 */
export interface SectionChange {
  id: string
  track: string
  kind: PlanSection['kind']
  before: { start: number; end: number }
  after: { start: number; end: number }
  /**
   * 段内关键帧要不要按比例缩放。
   * `scale` 模式下为伸缩比例，其余情况为 `undefined`（关键帧只跟着平移）。
   */
  keyScale?: number
}

export interface RetimePlan {
  changes: SectionChange[]
  playback: { before: { start: number; end: number }; after: { start: number; end: number } }
  /**
   * 需要同步改内部范围的子序列。
   *
   * **不改这个就是「父层截短了丢结尾」** —— 引擎不会自动跟。
   */
  subSequences: Array<{ path: string; before: [number, number]; after: [number, number] }>
  /** 拦下来的问题。非空时**不要执行**，先把话说给用户听 */
  problems: string[]
}

/** 段长。闭开区间，所以直接相减 */
function lengthOf(s: { start: number; end: number }): number {
  return s.end - s.start
}

/**
 * 算出完整的重定时计划。
 *
 * 不修改入参，也不接触引擎 —— 调用方拿到计划后自己决定是展示（dry run）
 * 还是执行。
 */
export function planRetime(input: PlanInput, op: RetimeOp): RetimePlan {
  const problems: string[] = []
  const changes: SectionChange[] = []
  const subSequences: RetimePlan['subSequences'] = []

  const pushChange = (
    s: PlanSection,
    after: { start: number; end: number },
    keyScale?: number
  ): void => {
    if (s.start === after.start && s.end === after.end) return
    changes.push({
      id: s.id,
      track: s.track,
      kind: s.kind,
      before: { start: s.start, end: s.end },
      after,
      ...(keyScale !== undefined ? { keyScale } : {})
    })

    // 父层段长变了，子序列内部范围必须跟着变，否则截尾或留白
    if (s.subSequence) {
      const inner = s.subSequence
      const innerLen = inner.innerEnd - inner.innerStart
      const outerLen = lengthOf(after)
      if (innerLen !== outerLen) {
        subSequences.push({
          path: inner.path,
          before: [inner.innerStart, inner.innerEnd],
          after: [inner.innerStart, inner.innerStart + outerLen]
        })
      }
    }
  }

  if (op.type === 'shift_after') {
    if (op.delta === 0) {
      problems.push('delta 是 0，没有任何改动。')
      return emptyPlan(input, problems)
    }

    for (const s of input.sections) {
      if (s.end <= op.pivot) continue

      if (s.start >= op.pivot) {
        // 整段在支点之后：平移
        pushChange(s, { start: s.start + op.delta, end: s.end + op.delta })
      } else {
        // 支点落在段中间：只动末端，等于就地伸缩
        const after = { start: s.start, end: s.end + op.delta }
        if (lengthOf(after) <= 0) {
          problems.push(
            `删掉这么多时间会让 ${s.track} 上的段「${s.id}」长度变成 ${lengthOf(after)} 帧（非正数）。` +
              '先缩小 delta，或者把这个段单独处理。'
          )
          continue
        }
        pushChange(s, after)
      }
    }

    const playbackAfter = {
      start: input.playback.start,
      end: input.playback.end + op.delta
    }
    if (playbackAfter.end <= playbackAfter.start) {
      problems.push('删掉这么多时间会让整条序列的播放范围变成空的。')
    }

    return {
      changes,
      playback: { before: input.playback, after: playbackAfter },
      subSequences,
      problems
    }
  }

  // ── set_duration ────────────────────────────────────────────────────
  const target = input.sections.find((s) => s.id === op.sectionId)
  if (!target) {
    problems.push(`找不到段「${op.sectionId}」。先用 sequence_describe 拿到正确的段标识。`)
    return emptyPlan(input, problems)
  }
  if (op.duration <= 0) {
    problems.push(`时长必须是正数，收到 ${op.duration}。`)
    return emptyPlan(input, problems)
  }

  const oldLen = lengthOf(target)
  const delta = op.duration - oldLen
  if (delta === 0) {
    problems.push(`段「${op.sectionId}」已经是 ${op.duration} 帧，没有改动。`)
    return emptyPlan(input, problems)
  }

  // scale 模式下关键帧按比例拉开；extend 模式下关键帧位置不动
  const keyScale = op.mode === 'scale' ? op.duration / oldLen : undefined
  pushChange(target, { start: target.start, end: target.start + op.duration }, keyScale)

  // 三类各走各的路。原来只有「起点在目标末尾之后就平移」一条，
  // 于是**与目标同跨度的平行段（正是对应的 Camera Cuts）被整个跳过** ——
  // shot 拉长了、它的切轨没拉，中间那段就是黑帧。本模块存在的全部理由就是防这个。
  for (const s of input.sections) {
    if (s.id === target.id) continue

    if (s.end <= target.start) continue // 完全在目标之前，不动
    if (s.start >= target.end) {
      pushChange(s, { start: s.start + delta, end: s.end + delta }) // 完全在之后，平移
    } else {
      pushChange(s, { start: s.start, end: s.end + delta }) // 与目标重叠，末端跟着伸缩
    }
  }

  return {
    changes,
    playback: {
      before: input.playback,
      after: { start: input.playback.start, end: input.playback.end + delta }
    },
    subSequences,
    problems
  }
}

function emptyPlan(input: PlanInput, problems: string[]): RetimePlan {
  return {
    changes: [],
    playback: { before: input.playback, after: input.playback },
    subSequences: [],
    problems
  }
}

/**
 * 计划 → 人话。
 *
 * 审批门要展示的是**这个**，不是工具名加一段参数 JSON。
 * 「一次操作跨 300 个文件，一次看一个等于没审」—— 用户看不清改了什么，
 * 就只能盲签，盲签几次之后就变成无脑点通过。
 */
export function formatPlan(plan: RetimePlan): string {
  if (plan.problems.length > 0) {
    return ['这次重定时没法执行：', ...plan.problems.map((p) => `- ${p}`)].join('\n')
  }

  if (plan.changes.length === 0) {
    return '没有任何段需要改动。'
  }

  const lines = [
    `播放范围 [${plan.playback.before.start}, ${plan.playback.before.end}) → ` +
      `[${plan.playback.after.start}, ${plan.playback.after.end})`,
    '',
    `会改动 ${plan.changes.length} 个段：`
  ]

  // 相机切轨排前面：它错了就是黑帧，用户最该先看这几行
  const order = { camera_cut: 0, shot: 1, other: 2 }
  const sorted = [...plan.changes].sort((a, b) => order[a.kind] - order[b.kind])

  for (const c of sorted) {
    const scale = c.keyScale !== undefined ? `，关键帧按 ${c.keyScale.toFixed(3)}× 拉伸` : ''
    lines.push(
      `- [${c.kind}] ${c.track}：[${c.before.start}, ${c.before.end}) → ` +
        `[${c.after.start}, ${c.after.end})${scale}`
    )
  }

  if (plan.subSequences.length > 0) {
    lines.push('', `同时要改 ${plan.subSequences.length} 条子序列的内部范围：`)
    for (const s of plan.subSequences) {
      lines.push(`- ${s.path}：[${s.before[0]}, ${s.before[1]}) → [${s.after[0]}, ${s.after[1]})`)
    }
    lines.push('', '（不改子序列内部范围的话，父层截短就丢结尾、拉长就多一段空白）')
  }

  return lines.join('\n')
}
