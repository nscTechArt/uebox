/**
 * 什么时候该插话，什么时候闭嘴。
 *
 * ## 为什么需要纪律
 *
 * 后台任务一跑起来，进度事件是**每秒好几条**的量级（每个工具调用一条）。
 * 原样念出来就是碎碎念：用户想说句话都插不进去，而真正要紧的那条
 * （失败了、Agent 在问你）淹在里面。
 *
 * 反过来，全都压着不播也不行 —— 那就退回成冷场了。
 *
 * 所以分两档：
 *
 *   - **高优先级**：任务结束、失败、Agent 反问用户。这几条是**用户在等的答案**，
 *     模型正在说话也要打断它播。
 *   - **低优先级**：中间进度（「在改蓝图了」）。锦上添花，能省则省。
 *
 * 两档共同的红线：**用户正在说话时一个字都不插**。抢用户的话比冷场难受得多，
 * 而且实时语音的打断是双向的 —— 我们一插播，服务端可能把用户那半句话判成结束。
 *
 * 这个模块刻意是纯函数：时间和状态都从参数进来。播报时机错了不会报错，
 * 只是听起来烦或者听不到，那种 bug 必须能用单测钉住。
 */

import type { ToolRisk } from '../../agent-v3/tools/defineTool'

/** 谁在说话。语音会话没开的时候是 `off` */
export interface VoiceFloor {
  /** 会话开着 */
  active: boolean
  /** 用户正在说话（识别到了非终态文本） */
  userSpeaking: boolean
  /** 模型正在播报 */
  assistantSpeaking: boolean
}

export type NoticePriority = 'low' | 'high'

export interface VoiceNotice {
  /** 哪件任务的。同一件的低优先级通知会互相顶掉 —— 进度只有最新的那条有意义 */
  taskId: string
  /** 说给用户听的原话 */
  speech: string
  /** 进模型上下文的那份。可以带对模型的指令 */
  context: string
  priority: NoticePriority
  /**
   * 这条是「在等用户答」的那一类。用户在界面上答掉之后它就作废了 ——
   * 还压在队里的话，过一会儿念出来是在问一个已经不存在的问题
   */
  kind?: 'question' | 'approval'
}

/**
 * 两条低优先级进度之间至少隔这么久。
 *
 * 八秒是「说完一句话、用户消化一下」的量级。调到两三秒它就变成实况解说，
 * 调到半分钟又跟没有一样。
 */
export const PROGRESS_THROTTLE_MS = 8_000

export type NoticeAction = 'speak' | 'queue' | 'drop'

export interface NoticeDecisionInput {
  priority: NoticePriority
  floor: VoiceFloor
  /** 上一次真正播出去的时刻。从没播过给 0 */
  lastSpokenAt: number
  now: number
}

/**
 * 现在能不能播这条。
 *
 * `queue` 表示压着等 —— 等用户说完、模型说完、或者节流窗口过去。
 * `drop` 只在会话根本没开的时候出现：没人听，攒着也没意义。
 *
 * **模型在说话时高优先级也等，不打断。** 原先的规矩是「用户在等的答案，模型正说着
 * 也要打断它播」。真机上这条把整路会话弄哑了：Agent 刚派出去一秒就反问，
 * 此时模型那句「开始做了」还没说完，我们往豆包里塞了一段 TTS ——
 * 从那一刻起它再没发过任何事件（不回话、不念问题、跑完也不念）。
 * 等它说完那几秒，代价是用户晚几秒听到问题；不等的代价是整通电话作废。
 */
export function decideNotice(input: NoticeDecisionInput): NoticeAction {
  const { priority, floor, lastSpokenAt, now } = input

  if (!floor.active) return 'drop'
  // 红线：用户在说话，什么都不插
  if (floor.userSpeaking) return 'queue'
  // 模型在说就等它说完。高优先级只是免节流，不是能打断
  if (floor.assistantSpeaking) return 'queue'

  if (priority === 'high') return 'speak'
  return now - lastSpokenAt >= PROGRESS_THROTTLE_MS ? 'speak' : 'queue'
}

/**
 * 把一条通知放进等待队列。
 *
 * 同一件任务的低优先级通知**互相顶掉**：进度是「现在在做什么」，
 * 攒三条旧的出来连着念，用户听到的是三个已经过去的状态。
 * 高优先级一条都不能丢 —— 失败和反问各是各的事。
 */
export function enqueueNotice(queue: VoiceNotice[], notice: VoiceNotice): VoiceNotice[] {
  if (notice.priority === 'high') return [...queue, notice]
  const kept = queue.filter((item) => !(item.priority === 'low' && item.taskId === notice.taskId))
  return [...kept, notice]
}

/**
 * 排到现在，该放哪些出去。
 *
 * 返回 `[要播的, 还得继续等的]`。一次只放一条：连着播两条会让模型把它们
 * 揉成一大段念出来，而这几条本来就是分开的事。
 */
export function drainNotices(
  queue: VoiceNotice[],
  floor: VoiceFloor,
  lastSpokenAt: number,
  now: number
): [VoiceNotice | null, VoiceNotice[]] {
  for (let index = 0; index < queue.length; index += 1) {
    const notice = queue[index]
    const action = decideNotice({ priority: notice.priority, floor, lastSpokenAt, now })
    if (action === 'speak') {
      return [notice, [...queue.slice(0, index), ...queue.slice(index + 1)]]
    }
    if (action === 'drop') {
      // 会话没了，整队都没人听
      return [null, []]
    }
  }
  return [null, queue]
}

/**
 * 工具名 → 说得出口的一句「在做什么」。
 *
 * 按命名空间粗分，不逐个工具翻译：42 个 `ue_*` 各念各的名字，用户既记不住
 * 也不关心；他想知道的是「动到我的蓝图了没有」。
 *
 * 正因为用户关心的就是这个，**读和写不能念同一句**。真机上「他那个动画蓝图是
 * 怎么选的」只是查了一下，语音却报「在改蓝图」，用户以为资产被动过
 * （2026-09-17 反馈）。读只说「在看」。
 *
 * `risk` 从工具注册表来（`listToolRisks()`），这里不另抄一张读写名单 ——
 * 抄了必然漂移。拿不到风险等级就不猜：返回空串，宁可不播也不乱说。
 *
 * 返回空串表示这个工具不值得播 —— 查询类的中间步骤说出来只是噪音。
 */
export function stageOf(toolName: string, risk: ToolRisk | undefined): string {
  if (!risk) return ''
  const reading = risk === 'safe'
  if (toolName.startsWith('blueprint_')) return reading ? '在看蓝图' : '在改蓝图'
  if (toolName.startsWith('material_')) return reading ? '在看材质' : '在调材质'
  if (toolName.startsWith('widget_')) return reading ? '在看界面控件' : '在改界面控件'
  if (toolName.startsWith('level_') || toolName.startsWith('ue_open_level'))
    return reading ? '在看关卡' : '在动关卡'
  if (toolName.startsWith('project_')) return reading ? '在看工程' : '在处理工程'
  if (toolName === 'ue_playtest') return '在运行试玩'
  if (toolName === 'ue_save' || toolName.startsWith('ue_save_')) return '在保存'
  if (toolName.startsWith('ue_content_import')) return '在导入资产'
  if (toolName.startsWith('ue_spawn') || toolName.startsWith('ue_destroy')) return '在增删场景物件'
  if (toolName.startsWith('ue_set_')) return '在改属性'
  return ''
}
