/**
 * 防冷场：长任务跑着的时候别让用户对着安静的麦克风等。
 *
 * ## 为什么要有它
 *
 * 派出去的活可能跑好几分钟。这期间只有 Agent 自己调 `voice_report`、或者换了
 * 阶段才会有播报 —— 真机上常常是一分多钟一声不吭。用户戴着耳机，既不知道
 * 还在不在做，也不知道是不是断线了，只能自己开口问「还在吗」。
 *
 * 详细反馈开启时，**安静满一分钟就主动汇报**。有活在跑就去看一眼进度
 * 照实汇报；没活在跑就是闲着 —— 搭话三次还没人应，说一句「先退下了」把连接
 * 断掉。空闲搭话和自动结束由独立开关控制。实时语音按连接时长计费，用户走开忘了挂断
 * 的话那一路会一直烧着额度。
 *
 * ## 为什么判断逻辑单独放这儿
 *
 * `ipc/realtimeVoice.ts` 里全是 Electron 和 WebSocket，测不了。而这一层最容易
 * 错的恰恰是**什么时候不该开口**（用户正说着话、模型正说着话、刚播报完），
 * 错了的样子是抢话和碎碎念。纯函数才测得住。
 */

/**
 * 安静多久算冷场。
 *
 * 算的是**一点反馈都没有**的 60 秒：用户说话、模型说话、任务表的任何一条播报
 * （进度、结果、反问、审批）都把这个钟拨回零。所以后台活跃着的时候不会撞上它 ——
 * 只有真正一声不吭满一分钟才开口。
 *
 * 短了变碎碎念（Agent 两条进度之间本来就有几十秒），长了用户已经先开口问
 * 「还在吗」了。
 */
export const SILENCE_GAP_MS = 60_000

/**
 * 闲着的时候最多搭几次话。
 *
 * 第三次就是告别那一次 —— 「搭话三次」这句话里包含它。前两次是「我还在」，
 * 第三次是「先退下了」，然后真的断开。
 */
export const CHATTER_ROUNDS = 3

export interface SilenceInput {
  now: number
  /** 偏好设置里的开关 */
  enabled: boolean
  /** 无人回应时自动结束，与进度反馈独立 */
  autoHangupEnabled: boolean
  /** 厂商真的接受了这条会话（`vendorReady`），没接受之前发什么都没人收 */
  connected: boolean
  /** 此刻有人在说话（用户或模型），包括本机语音合成正在念 */
  talking: boolean
  /** 上一次有人说话/播报是什么时候 */
  lastTalkAt: number
  /** 有没有活在跑 */
  hasRunning: boolean
  /** 已经搭过几次话（用户一开口就清零） */
  chatterDone: number
}

export type SilenceAction =
  /** 什么都别做 */
  | { type: 'none' }
  /** 有活在跑：看一眼进度，照实汇报 */
  | { type: 'report' }
  /** 闲着：搭一句话。`round` 从 1 起 */
  | { type: 'chatter'; round: number }
  /** 搭够了：说一句告别再断开 */
  | { type: 'hangup' }

/**
 * 这一秒该不该开口，开口说哪一类。
 *
 * **有活在跑就永远不会走到 `hangup`。** 用户可能只是在等结果，把他等着的那条
 * 连接掐掉，结果播报就没人念了 —— 那比冷场糟得多。
 */
export function decideSilenceAction(input: SilenceInput): SilenceAction {
  if (!input.connected) return { type: 'none' }
  // 有人正说着话，场子不空
  if (input.talking) return { type: 'none' }
  if (input.now - input.lastTalkAt < SILENCE_GAP_MS) return { type: 'none' }

  if (input.hasRunning) return { type: input.enabled ? 'report' : 'none' }
  if (!input.autoHangupEnabled) return { type: 'none' }

  const round = input.chatterDone + 1
  return round >= CHATTER_ROUNDS ? { type: 'hangup' } : { type: 'chatter', round }
}

/**
 * 搭话说什么。
 *
 * 走的是 `announce` 那条 TTS 直合成的路，所以这是**逐字念出来的原话**，
 * 不是给模型的提示 —— 写得像人说的话，别像系统提示音。
 */
export function chatterLine(round: number): { speech: string; context: string } {
  const speech = round <= 1 ? '我还在这儿，有什么要我做的吗？' : '这边一直听着呢，需要我做点什么？'
  return {
    speech,
    context:
      '这一句是盒子自己主动搭的话（已经安静一分钟了，没有任务在跑）。' +
      '用户接下来说什么就正常接着聊，别把这句当成他说的话。'
  }
}

/**
 * 一件活念出来时叫什么。
 *
 * **不能把用户交代的原话整段念回去。** 真机上那条指令是「把关卡里的游轮改成
 * 泰坦尼克号风格：调整船体造型、增加多层客舱、加装救生艇、改配色为黑 hull 白
 * 上层建筑，还原经典外观」—— 逐字念一遍要二十多秒，而且用户三分钟前刚说完，
 * 他要听的是「做到哪了」，不是自己那段话的复读。
 *
 * 所以只留冒号前那半截（他说的「做什么」），再按逗号断一次。规则这条是兜底，
 * 好听的那一版由模型压（见 `PROGRESS_SYSTEM_PROMPT`）。
 */
export function shortenInstruction(text: string, max = 16): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  // 「改成泰坦尼克号风格：调整船体…」—— 冒号后面全是细节，念不得
  const head = flat.split(/[：:]/)[0].trim() || flat
  if (head.length <= max) return head
  const clause = head.split(/[，,、；;。]/)[0].trim()
  if (clause && clause.length <= max) return clause
  return `${head.slice(0, max)}…`
}

/**
 * 让模型把「现在做到哪了」说成一句人话时的提示词。
 *
 * 为什么要过一次模型：手写模板念出来是「跟你说一声，「A」在改蓝图；「B」还在做。」
 * ——信息对，但没有活人感，而且两件活并排念像报菜名。模型能用**用户自己的说法**
 * 简称那件事（「大本钟的材质」「游轮那个」），这正是「结合上下文」的地方。
 *
 * 红线还是那条：**不许编**。没做完不能说做完了，事实只能来自给它的那几条。
 * 压不出来（没配模型、超时、跑偏）就退回规则那句，宁可平淡也不能说错。
 */
export const PROGRESS_SYSTEM_PROMPT = [
  '你是用户身边的助手，正在后台替他干活。已经安静一分钟了，你要主动搭一句话，',
  '告诉他手上这几件事做到哪了。用户没看屏幕。',
  '规矩：',
  '- 一到两句，不超过 60 个字，像同事从工位探个头说一句，不是播报系统状态。',
  '- 用他自己的说法简称那件事（「大本钟那个材质」「游轮那边」），',
  '  **绝对不要把他交代的整段要求复述一遍**，他刚说完，再念一遍是折磨。',
  '- 只说给你的这几条事实：在做什么、做到哪、做了多久。没给的一个字都不许编。',
  '- 都还没做完。不许说「做好了」「已完成」，也不许猜还要多久。',
  '- 有事卡着等他（要点头、要回答）的，那件必须点出来，那是他现在唯一要动手的事。',
  '- 不用 markdown，不念路径、代码、id、工具名、任务号。',
  '- 只输出那句话本身，不要前缀、不要引号。'
].join('\n')

/** 断开之前那一句。说清楚「再叫我」，不然用户以为是掉线了 */
export const FAREWELL: { speech: string; context: string } = {
  speech: '这边没什么事，我先退下了，需要的时候再叫我。',
  context: '没有任务在跑，也一直没人说话，语音这就挂断了。'
}
