/**
 * 语音助手落在哪条对话上。
 *
 * ## 说话这一半：**从哪条对话开的口，就写回哪条**
 *
 * 曾经有一条固定的「语音助手」对话，所有语音对白都往它那儿写。真机上两头都别扭：
 * 每次点球体都回到同一条，几天下来是一条越滚越长、什么都混在一起的流水账；
 * 而在某条对话里点麦克风，明明是想接着眼前这段上下文往下聊，却被扔去那条固定的，
 * 语音看不见用户刚才在看什么。
 *
 * 现在没有「语音专用的那条对话」了 —— 语音会话开的时候绑定一条对话（见
 * `voiceAssistant.ts` 的 `startVoiceIn`），对白写它、上文也读它：
 *
 *   - 欢迎页的球体：绑当前这条。球体只在**没有任何消息**的对话上出现，
 *     所以每次主动开口都是一条干净的新对话，互不影响。
 *   - 对话里的麦克风：绑正开着的这条，语音接着眼前的上下文说。
 *
 * ## 干活这一半：**和说话那条一对一**
 *
 * 语音派出去的活**不**落在说话那条上。一个 `sid`、一个消息列表、一个
 * `currentAgentProcess`、一份 transcript、一条 agent 会话 —— 五样东西两个说话人
 * 共用时，真机上接连炸出四个问题：Agent 的过程日志渲染两遍、分不清哪句是语音说的、
 * 语音闲聊污染 Agent 记忆、语音这轮和 Agent 那次运行抢同一条会话。详见
 *
 * 但也**不是全局固定的一条**。曾经是，说话那半改成一通电话一条之后它就成了漏网的
 * 那一半：昨天在 A 工程派的活和今天在 B 工程派的活共用同一条 agent 会话、同一份
 * transcript，上下文越滚越脏 —— 而 Agent 每一轮都带着这份 transcript 去推理，
 * 脏进去的东西会直接影响它对下一件活的判断。
 *
 * 所以按说话那条**派生**出来：一通电话配一条任务会话（`voiceTaskSessionId`）。
 * 同一条对话里挂断再开口还是同一条 —— 那本来就是同一段事情的延续，agent 会话号
 * 也跟着复用；换一条对话开口就是另一条，互相看不见。
 *
 * 派生而不是每件活开一条新的：一件事往往要来回好几轮，一件活一条会让同一件事的
 * 上下文散在好几条对话里，还容易两条会话同时改同一个工程。代价是同一条会话同时
 * 只能跑一件（`agent-v3:execute` 本来就拒并发），所以新活来了要么排队、要么插进
 * 正在跑的那轮 —— 见 `taskBus.ts`。
 */

/**
 * ## 一通电话，几个灶
 *
 * 上面那句「派生而不是每件活开一条新的」当时是对的，但它当成了**一条**：
 * 一通电话所有的活都挤在同一条 agent 会话上，而 `agent-v3:execute` 拒同会话
 * 并发 —— 于是一件长活跑着的时候，后面所有的活只能排队干等，哪怕它们
 * 八竿子打不着。真机上这就是最难受的地方。
 *
 * 拦并发的从来只是「同一条会话」，后厨本身允许多条会话并行（`activeAgents`
 * 是个 Map，`assetLock` 就是为这个存在的）。所以现在按**灶**分：一通电话可以有
 * 几个灶（上限 `VOICE_MAX_WORKERS`），一个灶一条 agent 会话、一条侧边栏对话。
 *
 * 「一件活一条」那个毛病没回来 —— 灶是**按类**分的，不是按活分的：同一类活始终
 * 落在同一个灶上，上下文接得住（「再把刚才那盏灯调回去」），而且天然排队。
 * 挑哪个灶由前台模型判断，判据和代价写在 `frontDesk.ts` 的工具描述里。
 */

/**
 * 这通电话某个灶的活落在哪条对话上。
 *
 * 从说话那条的 id 加灶名派生，所以是纯函数、不用另存一份对应关系。
 * 前缀写死，普通会话 id 是 base36 时间戳，撞不上。
 */
const VOICE_TASK_PREFIX = 'voice-tasks-'

/**
 * 灶名和 chatSid 之间的分隔符。
 *
 * `::` 而不是 `-`：普通会话 id 是 base36 时间戳，里面不会有它，
 * 而灶名归一之后可能带连字符（`content-cleanup`）—— 用 `-` 分的话切不回来。
 */
const WORKER_SEPARATOR = '::'

export function voiceTaskSessionId(chatSid: string, workerKey: string): string {
  return `${VOICE_TASK_PREFIX}${chatSid}${WORKER_SEPARATOR}${workerKey}`
}

/** 这条对话是某通电话的任务对话吗 */
export function isVoiceTaskSessionId(sessionId: string): boolean {
  return sessionId.startsWith(VOICE_TASK_PREFIX)
}

/** 这条任务对话属于哪通电话。不是任务对话就返回空串 */
export function voiceTaskOwnerSid(sessionId: string): string {
  if (!isVoiceTaskSessionId(sessionId)) return ''
  const rest = sessionId.slice(VOICE_TASK_PREFIX.length)
  const at = rest.lastIndexOf(WORKER_SEPARATOR)
  return at === -1 ? rest : rest.slice(0, at)
}
