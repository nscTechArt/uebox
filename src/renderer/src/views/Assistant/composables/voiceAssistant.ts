import { effectScope, watch, type EffectScope } from 'vue'
import { message } from '@renderer/utils/messageManager'
import i18n from '@renderer/i18n'
import { agentV3API } from '@renderer/api/agentV3'
import { answerAgentQuestion, recordUserSteer } from './agentEventDispatcher'
import { useChatMessagesStore, type ChatMessageContent } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import { appExecuteAgent } from './appAgentRunner'
import { voiceConversationHistory } from './voiceConversationHistory'
import { ensurePermissionMode } from './sessionPermissionMode'
import {
  useRealtimeVoice,
  type RealtimeVoiceHistoryMessage,
  type RealtimeVoiceState,
  type VoiceSessionRef
} from './useRealtimeVoice'
import { isVoiceTaskSessionId, voiceTaskSessionId } from './voiceSessions'
import { setVoiceCallActive } from './voiceCallState'
import {
  VOICE_MAX_WORKERS,
  normalizeWorkerKey,
  withVoiceDispatchContext,
  withVoiceSteerContext,
  workerLabel,
  type VoiceDispatchTurn
} from '@core/shared/voiceFrontDesk'

/**
 * 语音助手：整个应用只有**一路**，不挂在任何页面组件上。
 *
 * ## 为什么不能放在 Welcome.vue 里
 *
 * 每条对话是一个独立的 keep-alive 页面实例（缓存键带 sid）。语音会话原先由
 * Welcome.vue 里的 `useRealtimeVoice` 持有：点侧边栏切到「语音任务」那条，
 * 新页面实例的语音状态是空的，旧实例被替换掉时还顺手把麦克风关了。
 * 用户看到的就是「切一下会话，语音助手没了」。
 *
 * 语音是一通电话，不是某个页面的附属品：任务跑着的时候用户要能去看
 * 「语音任务」的过程、去看资产库、去干别的，回来接着说。所以这一路放在
 * 模块级，谁都不拥有它。只有三件事能挂断：用户点球体、清空「语音助手」
 * 那条对话、应用关闭（主进程在 sender 销毁时自己收尾）。
 *
 * ## 页面只是个观众
 *
 * 语音写消息进 store、停 agent 走 IPC、派活走应用级的 `appAgentRunner` —— 没有
 * 一件事需要页面在场。页面登记「宿主」只为两件纯显示的事：**滚到底**、
 * **更新上下文标签**；调用点都是 `?.`，没人在就不做。
 *
 * 曾经派活也要借宿主（`useAgentMode.executeAgent` 是页面级的），于是助手页一关
 * 就派不出活 —— 而助手路由没开 keepAlive，用户切个页面就等于"关了"。那条
 * 「助手页面都关了」的错已经删掉，见 `appAgentRunner.ts`。
 *
 * ## 一路语音，但每次通话绑一条对话
 *
 * 连接只有一路，写去哪儿却是每次通话各自决定的：`startVoiceIn(sid)` 记下这次
 * 绑的是哪条对话，对白写它、上文读它。为什么不再用一条固定的「语音助手」对话，
 * 见 `voiceSessions.ts`。
 *
 * 完整设计。
 */

/**
 * 一个正开着的助手页。**只用来做显示上的配合**，跑活不靠它。
 *
 * 这里原来还有一个 `executeAgent` —— 派活得借页面。现在派活走应用级的
 * `appAgentRunner`，这个接口就只剩「你正对着哪条对话」和两件视图上的事了。
 */
export interface VoiceHost {
  /** 这个页面正对着哪条对话 */
  sid: () => string
  /** 只在页面正对着语音那两条对话之一时才会被调 */
  scrollToBottomIfNeeded: () => void
  /** 用户说了一句（只在页面正对着「语音助手」时调），页面顺手更新上下文标签 */
  onUserText?: (text: string) => void
}

/** 登记过的宿主，最近登记的排最后 */
const hosts: VoiceHost[] = []

/** 页面登记为宿主。再登记一次就挪到最后。返回注销函数 */
export function attachVoiceHost(host: VoiceHost): () => void {
  detachVoiceHost(host)
  hosts.push(host)
  return () => detachVoiceHost(host)
}

function detachVoiceHost(host: VoiceHost): void {
  const at = hosts.indexOf(host)
  if (at >= 0) hosts.splice(at, 1)
}

/** 正对着某条对话的那个页面，没人对着就 undefined */
function hostFacing(sid: string): VoiceHost | undefined {
  return hosts.find((host) => host.sid() === sid)
}

function t(key: string, params?: Record<string, string>): string {
  return params ? i18n.global.t(key, params) : i18n.global.t(key)
}

function textOf(content: ChatMessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((item) => item.type === 'text' && item.text)
    .map((item) => item.text)
    .join('\n')
}

/**
 * 这次通话绑的是哪条对话。空串表示还没开过口。
 *
 * 挂断**不清空**：结束前后还会有几条落定的气泡和收尾播报要写，清了它们就没地方去。
 * 下一次 `startVoiceIn` 会把它覆盖掉。
 */
let boundSid = ''

/** 这次通话写进哪条对话。给界面判断「眼前这条是不是正在通话的那条」用 */
export function voiceChatSid(): string {
  return boundSid
}

/**
 * 这通电话开过的灶，**最近用过的排最后**。
 *
 * 只存归一后的键，其余（对话、agent 会话号）都在 store 里 —— 挂断再接上时
 * 灶还在，从 store 里认得回来。这个数组只负责「最近用的是哪个」这一件事。
 */
let workerOrder: string[] = []

/** 归一键 → 模型最初给的那个写法。只影响念出来好不好听 */
const workerLabels = new Map<string, string>()

/** 这通电话的一个灶 */
export interface VoiceWorkerRef {
  /** 归一后的键，匹配用 */
  key: string
  /** 说给用户听的名字 */
  label: string
  agentSessionId: string
}

/** 这次通话某个灶的活落在哪条对话上，没绑就是空串 */
export function voiceTaskSid(workerKey: string): string {
  return boundSid ? voiceTaskSessionId(boundSid, workerKey) : ''
}

/** 灶名说给用户听的那一份。存的是归一后的键，念的时候还原成模型给的写法 */
function workerLabelOf(key: string): string {
  return workerLabels.get(key) || key
}

/**
 * 这通电话现在有哪些灶。
 *
 * **从 store 里认**，不从内存那份数组认：挂断再开口时内存是空的，而侧边栏上
 * 那几条任务对话还在、agent 会话号也还在。只按内存算的话，接上之后模型看到
 * 「一个灶都没有」，一派活就又开一个新的，上一通的上下文全丢了。
 */
export function voiceWorkers(): VoiceWorkerRef[] {
  if (!boundSid) return []
  const chatStore = useChatSessionsStore()
  const prefix = voiceTaskSessionId(boundSid, '')
  const found = chatStore.sessions
    .filter((item) => item.id.startsWith(prefix) && !item.archived)
    .map((item) => {
      const key = item.id.slice(prefix.length)
      return {
        key,
        label: workerLabelOf(key),
        agentSessionId: chatStore.getAgentSessionId(item.id)
      }
    })
    .filter((item) => !!item.key && !!item.agentSessionId)

  // 最近用过的排最后：「不填就排最近那个」和「满了顶到最久没用的」都靠这个顺序
  const rank = (key: string): number => workerOrder.indexOf(key)
  return found.sort((a, b) => rank(a.key) - rank(b.key))
}

/**
 * 挑一个灶，没有就现开一个。
 *
 * 三条规矩，代价都不对称：
 *
 * 1. **名字对得上就用它**（同类合并）—— 那个灶记得上一件做过什么，而且同一条
 *    agent 会话天然排队，两件同类的活不可能同时改到一处去。
 * 2. **新名字 + 还有空位 → 开新灶**，真并行。
 * 3. **新名字 + 灶满了 → 排到最久没用的那个灶后面**，并照实说。回绝的话模型还得
 *    再猜一轮，而这一轮里用户什么都听不到；排错了只是慢一点。
 *
 * 不填名字走的是「最近用过的那个」，也就是最保守的排队 —— 模型没想清楚的时候，
 * 不该顺手开一个新灶出来并行。
 */
export function ensureVoiceWorker(raw: string): VoiceWorkerRef & { full: boolean } {
  if (!boundSid) throw new Error('语音还没绑定对话，先开一路语音再派活。')

  const pool = voiceWorkers()
  const wanted = normalizeWorkerKey(raw)

  const hit = wanted ? pool.find((item) => item.key === wanted) : undefined
  if (hit) {
    inheritWorkerContext(voiceTaskSid(hit.key))
    touchWorker(hit.key)
    return { ...hit, full: false }
  }

  // 不填、或者灶满了：落到现有的灶上排队。没填就排最近用的，满了就排最久没用的
  if (!wanted || pool.length >= VOICE_MAX_WORKERS) {
    const fallback = wanted ? pool[0] : pool[pool.length - 1]
    if (fallback) {
      inheritWorkerContext(voiceTaskSid(fallback.key))
      touchWorker(fallback.key)
      return { ...fallback, full: !!wanted }
    }
  }

  // 一个灶都还没有时，不填名字也得开一个，用个中性的名字
  return { ...openWorker(wanted ? raw : '任务'), full: false }
}

/** 真开一个灶：建对话、发一个 agent 会话号 */
function openWorker(raw: string): VoiceWorkerRef {
  const key = normalizeWorkerKey(raw)
  workerLabels.set(key, workerLabel(raw))
  const chatSid = voiceTaskSid(key)
  const chatStore = useChatSessionsStore()
  chatStore.ensureSession(chatSid, voiceTaskTitle(key))
  inheritWorkerContext(chatSid)

  const existing = chatStore.getAgentSessionId(chatSid)
  const agentSessionId = existing || crypto.randomUUID()
  if (!existing) chatStore.setAgentSessionId(chatSid, agentSessionId)

  touchWorker(key)
  return { key, label: workerLabelOf(key), agentSessionId }
}

/** 旧版本生成但从未打开的任务同样需要补上配置；已有明确选择保留。 */
function inheritWorkerContext(chatSid: string): void {
  const chatStore = useChatSessionsStore()
  const target = chatStore.sessionById(chatSid)
  if (target && target.project === undefined)
    chatStore.setProject(chatSid, chatStore.getProject(boundSid))
  if (!chatStore.getPermissionMode(chatSid)) {
    chatStore.setPermissionMode(chatSid, ensurePermissionMode(boundSid))
  }
}

function touchWorker(key: string): void {
  workerOrder = [...workerOrder.filter((item) => item !== key), key]
}

/** 「语音任务 · 把主灯调暗 · 灯光」。说话那条还没起名时就只有后半截 */
function voiceTaskTitle(workerKey: string): string {
  const chatTitle = useChatSessionsStore().sessionById(boundSid)?.title || ''
  const plain = t('assistantInputComposer.voice.taskSessionTitle')
  const base =
    !chatTitle || chatTitle === t('assistant.chatFlow.unnamedSession')
      ? plain
      : t('assistantInputComposer.voice.taskSessionTitleFor', { name: chatTitle })
  return `${base} · ${workerLabelOf(workerKey)}`
}

/** 标题取用户的第一句话。太长的截断 —— 侧边栏一行也就这么宽 */
const VOICE_TITLE_MAX_CHARS = 20

/**
 * 开一路语音，对白写进 `sid` 这条对话。
 *
 * 两个入口共用：欢迎页的球体（`sid` 是一条还没有任何消息的新对话）和对话里的
 * 麦克风（`sid` 是用户正开着的这条，语音接着眼前的上下文说）。已经在通话中就
 * 什么都不做 —— 换绑要先挂断，不然上文是上一条的、话却写到新的那条去了。
 */
export async function startVoiceIn(sid: string): Promise<void> {
  const voice = useVoiceAssistant()
  if (!sid || voice.active.value || voice.connecting.value) return

  /*
   * 换了一条对话开口 = 换了一通电话，灶的使用顺序跟着清掉。
   * 不清的话「不填就排最近用的那个」会挑到上一通的灶 —— 灶本身按 store 认得回来，
   * 但「最近用的」是上一通的事实，拿它当这一通的默认是错的。
   * 同一条对话挂断再开口不清：那本来就是同一段事情的延续。
   */
  if (sid !== boundSid) workerOrder = []
  boundSid = sid
  // 和打字那条路用同一个占位标题，用户说第一句时照 `nameVoiceSession` 换掉
  useChatSessionsStore().ensureSession(sid, t('assistant.chatFlow.unnamedSession'))
  await voice.start()
}

/**
 * 开语音时交给实时模型的上文。
 *
 * 读的是**这次绑的那条对话**的记录 —— 在某条对话里点麦克风，语音要接的就是
 * 眼前这段；欢迎页开的是新对话，读出来自然是空的。
 * 条数和长度的上限由主进程按厂商协议再收一次口（见 `ipc/realtimeVoice.ts`）。
 */
export function voiceHistory(): RealtimeVoiceHistoryMessage[] {
  if (!boundSid) return []
  return voiceConversationHistory(useChatMessagesStore().getMessages(boundSid))
}

/**
 * 派活时随指令一起交给后厨的那几轮对白。
 *
 * 读的和 `voiceHistory` 是同一处（这次通话绑的那条对话），但去向完全不同：
 * 那个是**开语音时**给实时模型接上文，这个是**每次派活时**给 Agent 消解指代。
 * 条数与长度的上限、以及「这不是新指令」那条纪律都在
 * `withVoiceDispatchContext` 里 —— 主进程和渲染层将来都可能派活，规矩放在
 * 共享那一份才不会各写各的。
 */
function recentVoiceTurns(): VoiceDispatchTurn[] {
  if (!boundSid) return []
  return useChatMessagesStore()
    .getMessages(boundSid)
    .filter((item) => item.status !== 'typing')
    .map((item) => ({ role: item.role, text: textOf(item.content).trim() }))
    .filter((item) => item.text.length > 0)
}

let voiceAssistantMessageId = ''

/**
 * 用户的第一句话顺手给这条对话起个名。
 *
 * 不起的话侧边栏上会排出一列一模一样的「AI会话」，用户分不出哪条是哪条 ——
 * 而「每次开口都是独立的一条」正是靠侧边栏认人的。判据和打字那条路
 * （`useChatFlow.ensureSessionWithTitle`）一样：**标题还是占位符才改**，
 * 所以绑到一条已经聊过的对话上时不会动人家的名字。标签页标题由页面上那条
 * 「会话标题变了就同步」的 watcher 跟着改。
 */
function nameVoiceSession(text: string): void {
  const chatStore = useChatSessionsStore()
  const placeholder = t('assistant.chatFlow.unnamedSession')
  if (chatStore.sessionById(boundSid)?.title !== placeholder) return
  chatStore.updateTitle(boundSid, text.replace(/\s+/g, ' ').slice(0, VOICE_TITLE_MAX_CHARS))
}

function recordVoiceUserText(text: string): void {
  if (!boundSid) return
  voiceAssistantMessageId = ''
  useChatMessagesStore().pushUser(boundSid, text)
  nameVoiceSession(text)
  useChatSessionsStore().appendMessage(boundSid, text)
  const host = hostFacing(boundSid)
  host?.onUserText?.(text)
  host?.scrollToBottomIfNeeded()
}

function updateVoiceAssistantText(text: string): void {
  if (!boundSid) return
  const chatMsgStore = useChatMessagesStore()
  if (!voiceAssistantMessageId) {
    voiceAssistantMessageId = chatMsgStore.pushAssistantTyping(boundSid)
  }
  chatMsgStore.replaceTyping(boundSid, voiceAssistantMessageId, text, false)
  hostFacing(boundSid)?.scrollToBottomIfNeeded()
}

/**
 * 一轮说完，把气泡落定。
 *
 * **不往任何 agent transcript 里写。** 语音只是听和说，它不跑 agent，也就没有
 * transcript 要同步；绑在一条跑过 Agent 的对话上时也一样，那条的 transcript
 * 归 Agent 自己管。
 */
function finishVoiceAssistantText(text: string): void {
  if (!boundSid) return
  const chatMsgStore = useChatMessagesStore()
  if (!voiceAssistantMessageId) {
    voiceAssistantMessageId = chatMsgStore.pushAssistantTyping(boundSid)
  }
  chatMsgStore.replaceTyping(boundSid, voiceAssistantMessageId, text, true)
  useChatSessionsStore().appendMessage(boundSid, text)

  voiceAssistantMessageId = ''
  hostFacing(boundSid)?.scrollToBottomIfNeeded()
}

/**
 * 播报的原话写进这次通话那条对话，和模型自己说的话并排。
 *
 * 念出来的每一句用户都该在屏幕上看得到 —— 不然他听到「工程打开了」，
 * 翻对话却没有这句，分不清是幻听还是漏了。
 */
function recordVoiceAnnouncement(text: string): void {
  if (!boundSid) return
  const chatMsgStore = useChatMessagesStore()
  const id = chatMsgStore.pushAssistantTyping(boundSid)
  chatMsgStore.replaceTyping(boundSid, id, text, true)
  useChatSessionsStore().appendMessage(boundSid, text)
  hostFacing(boundSid)?.scrollToBottomIfNeeded()
}

/**
 * 语音派活的去处：这通电话某个灶那条任务对话，不是当前打开的这条。
 *
 * `worker` 是模型给的灶名。挑灶的规矩（同名合并 / 新名并行 / 满了排队）
 * 在 `ensureVoiceWorker` 里，这里只负责把结果翻译成派活要用的形状。
 */
function currentVoiceSession(worker = ''): VoiceSessionRef {
  const picked = ensureVoiceWorker(worker)
  return {
    agentSessionId: picked.agentSessionId,
    label: picked.label,
    key: picked.key,
    note: workerNote(worker, picked)
  }
}

/**
 * 没按模型的意思挑灶时，回执里要多说的那句。
 *
 * 不说的话它会以为自己开了新灶、转头告诉用户「两件同时在做」，而实际是排队 ——
 * 那是让它对用户撒谎。真机（2026-09-03）上模型**一次都没填过灶名**，
 * 于是每件活都排在同一个灶后面，而用户完全不知道为什么。
 */
function workerNote(raw: string, picked: VoiceWorkerRef & { full: boolean }): string {
  if (!normalizeWorkerKey(raw)) {
    console.warn('[Realtime Voice] 模型没给灶名，按最保守的排到了', picked.label, '这个灶后面')
    return (
      `注意：你没给 worker，这件活被排在「${picked.label}」这个灶后面了，不是同时在做。` +
      `如果它和那个灶正在做的不相干，用一个新灶名重新派一次就能同时跑。`
    )
  }
  if (picked.full) {
    return (
      `注意：灶已经开满 ${VOICE_MAX_WORKERS} 个了，这件活排在最久没用的「${picked.label}」后面，` +
      `不是同时在做。照实跟用户说。`
    )
  }
  return ''
}

/**
 * 能派活的对话。
 *
 * 只列**已经有 agent 会话号**的 —— 没跑过 Agent 的对话给不出 id，
 * 派过去主进程也认不出来。归档的不列：用户说「另一个项目」时不会是指它。
 *
 * **别通电话的任务对话也不列。** 那是这次改动要挡的东西：模型一旦把活派进
 * 上周那通电话的任务会话，它就带着上周那份 transcript 往下推理。自己这通的
 * 不用列，不填 session 就是它（`resolveSession`）。
 */
function listVoiceSessions(): VoiceSessionRef[] {
  const chatStore = useChatSessionsStore()
  return chatStore.sessions
    .filter((item) => !item.archived && !isVoiceTaskSessionId(item.id))
    .map((item) => ({
      agentSessionId: chatStore.getAgentSessionId(item.id),
      label: item.id === boundSid ? `【当前语音对话】${item.title}` : item.title
    }))
    .filter((item) => !!item.agentSessionId)
}

/**
 * 启动一次运行，**不等它跑完** —— 状态和结果由主进程的任务表播报。
 *
 * 走和打字发送**同一套** `executeAgent`，只是目标对话不是用户正开着的这条：气泡、
 * 过程时间线、流式状态都建在目标那条上面，用户切过去就能看到完整过程；工程归属、
 * 审批档位、思考档位也和打字时一致。
 *
 * 曾经直接调裸的 `agentV3API.execute` —— 主进程跑是跑了，界面上那条对话却一个字
 * 都不长：没有气泡、没有事件处理器，用户切过去看到的是空白。再往前借道当前对话
 * 的 `handleSend`，那又是过程日志渲染两遍的成因。
 *
 * 也曾经**借一个挂着的助手页**来跑：助手路由没开 keepAlive，用户切去看素材库那一刻
 * 页面就没了，于是这里回一句「助手页面都关了，请打开一个助手页面再派活」—— 而他
 * 什么也没关。现在用应用级的 `appAgentRunner`，跟哪个页面开着没有关系。
 *
 * 启动失败要晚一点才知道（invoke 要等整轮跑完才返回，拒绝是回调里到的），
 * 所以通过 `fail` 回报，让任务表把那件活标掉 —— 不然它永远占着位子。
 */
async function dispatchToVoiceTasks(
  instruction: string,
  agentSessionId: string,
  fail: (reason: string) => void,
  executionInstruction?: string
): Promise<void> {
  const chatStore = useChatSessionsStore()
  const targetSid = chatSidForAgentSession(agentSessionId)
  useChatMessagesStore().pushUser(targetSid, instruction)
  chatStore.appendMessage(targetSid, instruction)
  hostFacing(targetSid)?.scrollToBottomIfNeeded()

  /*
   * 气泡里是用户的原话；交给 Agent 的还多两段：
   *
   * - 最近几轮对白 —— 前台会漏掉限定语（它写「把主灯调暗」，用户上一句说的是
   *   「就刚才那盏，别动别的」）。带上之后后厨遇到歧义能自查，而不是硬做。
   * - 「用 voice_report 报进度和结果」的提醒 —— 工具描述里写了必须报，但模型会漏。
   */
  await appExecuteAgent(executionInstruction || withVoiceDispatchContext(instruction), undefined, {
    chatSid: targetSid,
    onFinished: (outcome) => {
      if (outcome.status === 'error') fail(outcome.text)
    }
  })
}

/**
 * 这个 agent 会话号对应界面上哪条对话。
 *
 * 模型可以把活派给**别的对话**（`list_sessions` + `session` 参数）。上一版不管派给谁，
 * 气泡都往那条固定的「语音任务」里写，而且顺手把它的 agent 会话号改成了别人的 ——
 * 从此这通电话自己的任务全跑到人家那条会话上去了，正是「上下文不干净」最狠的一种。
 *
 * 所以先按会话号回查是哪条对话；查不到才是这通电话自己那条任务对话，现登记上。
 */
function chatSidForAgentSession(agentSessionId: string): string {
  const chatStore = useChatSessionsStore()
  const known = chatStore.sessions.find(
    (item) => chatStore.getAgentSessionId(item.id) === agentSessionId
  )
  if (known) return known.id

  /*
   * 查不到 = 这个会话号不属于界面上任何一条对话。灶是在派活**之前**建好的
   * （`ensureVoiceWorker` 里就 `ensureSession` + `setAgentSessionId` 了），
   * 所以正常路径不会走到这儿。真走到了说明有人绕过了挑灶那一步，
   * 硬猜一条对话把会话号写上去只会把两件活搅到一条会话上 —— 那正是
   * §6.5.2 修过的「上下文不干净」最狠的一种。照实抛。
   */
  throw new Error(`会话 ${agentSessionId} 不属于界面上任何一条对话，没法派活。`)
}

let shared: RealtimeVoiceState | null = null

/**
 * 这一路语音的那几个 watcher 住在哪儿。
 *
 * **必须是游离作用域**（`effectScope(true)`），不能是「第一个调它的那个组件」的。
 * 单例是第一次调 `useVoiceAssistant()` 时建的，而第一次调它的是助手页
 * （`Welcome.vue` 的 setup）—— 助手路由没开 keepAlive，用户切去看资产库那一刻
 * 页面就卸载了，挂在它作用域里的 watcher 全被停掉。可 `shared` 是模块级的，
 * 还在，于是之后再调只会走 `if (shared) return shared` 那条捷径，watcher
 * 再也不会重新挂上。
 *
 * 后果是真机上看得见的：通话状态推不给自动朗读（于是通话中还会自动念，
 * TTS 被麦克风收回去），防冷场和自动挂断的开关也同步不出去。
 *
 * 这是仓库里同一个坑的第四次，前三次是 `followUpDelivery`、`appAgentRunner`、
 * `autoReadAloud`。规矩没变：语音是应用级的一路，它的接线也得活到应用关掉。
 */
let voiceScope: EffectScope | null = null

/**
 * 拿到那一路语音。第一次调时建起来，之后所有页面拿到的都是同一份状态 ——
 * 球体、状态文字、字幕在哪个页面看都一样。
 */
export function useVoiceAssistant(): RealtimeVoiceState {
  if (shared) return shared
  voiceScope = effectScope(true)
  return voiceScope.run(createVoiceAssistant) as RealtimeVoiceState
}

function createVoiceAssistant(): RealtimeVoiceState {
  const aiConfigStore = useAIConfigStore()
  shared = useRealtimeVoice({
    microphoneDeviceId: () => aiConfigStore.voiceMicrophoneDeviceId,
    get connectionTimeoutMessage(): string {
      return t('assistantInputComposer.voice.connectionTimeout')
    },
    // 用 getter 而不是定值：这一路会话活得比任何页面都久，语言切换后这两句要跟着变
    get unsupportedAudioMessage(): string {
      return t('assistantInputComposer.voice.unsupportedAudio')
    },
    get asrFailedMessage(): string {
      return t('assistantInputComposer.voice.asrFailed')
    },
    getHistory: voiceHistory,
    prepareInstruction: (instruction) => withVoiceDispatchContext(instruction, recentVoiceTurns()),
    onUserText: recordVoiceUserText,
    onAssistantText: updateVoiceAssistantText,
    onAssistantDone: finishVoiceAssistantText,
    onAnnouncement: recordVoiceAnnouncement,
    resolveSession: currentVoiceSession,
    listWorkers: voiceWorkers,
    listSessions: listVoiceSessions,
    onDispatch: dispatchToVoiceTasks,
    /**
     * 把一句话插进正在跑的那一轮。
     *
     * 拿**真实返回值**：插不进去就照实说。一律报成功的话，用户以为改过来了，
     * 而 Agent 还在照原样做完 —— 那比插不进去更糟。
     */
    onSteer: async (agentSessionId, instruction) => {
      /*
       * 交给内核的那句带上用户最近一句原话（前台改写会丢限定条件，插队时丢了更要命）；
       * 时间线和气泡里仍只显示前台那句 —— 和派活时「气泡里只有原话」同一个规矩。
       */
      const result = await agentV3API.steer(
        agentSessionId,
        withVoiceSteerContext(instruction, recentVoiceTurns())
      )
      if (result.success === false) return false

      /*
       * 插进内核之后还要**让任务对话上看得见**。
       *
       * 上一版到 IPC 就结束了：语音说「已经调整了」，用户切到任务对话却
       * 什么都没多，和没插一样 —— 界面上唯一能证明那句话进去了的东西
       * 就是时间线里这一条（内核真读进去时它还会被标成已生效）。
       *
       * 流已经收尾（正好在这一瞬跑完）就退回普通气泡：无论如何，
       * 用户在对话里得看见自己说过的话。
       */
      const recorded = recordUserSteer(agentSessionId, instruction, result.steerId)

      // 回查不到对话就到此为止：话已经插进内核了，为了画一条气泡去猜一条
      // 对话只会把两件活搅到一起（见 chatSidForAgentSession 的注释）
      const chatStore = useChatSessionsStore()
      const targetSid = chatStore.sessions.find(
        (item) => chatStore.getAgentSessionId(item.id) === agentSessionId
      )?.id
      if (!targetSid) return true

      if (!recorded) {
        useChatMessagesStore().pushUser(targetSid, instruction)
        chatStore.appendMessage(targetSid, instruction)
      }
      hostFacing(targetSid)?.scrollToBottomIfNeeded()
      return true
    },
    // 用户说「停下」时用。返回真实结果 —— 停不掉就照实说，不假装停了。
    // 界面那边的收尾（气泡、控制器）由 agent-v3:stopped 事件经分发器自己做
    onCancel: async (agentSessionId) => (await agentV3API.stop(agentSessionId)).success !== false,
    /**
     * 空数组表示用户说了「你看着办」。
     *
     * 那对应 `decline`（让 Agent 自己定），不是 `accept` 一个空答案 ——
     * 后者会让 Agent 拿着空字符串当成用户的选择继续做。
     */
    onAnswerQuestion: (toolCallId, answers, agentSessionId) => {
      // 走分发器那条：既回传给主进程，也把屏幕上那张提问卡片收成只读。
      // 直接 replyQuestion 的话 Agent 是继续了，卡片却一直写着「等你回答」
      answerAgentQuestion(
        agentSessionId,
        toolCallId,
        answers.length > 0 ? 'accept' : 'decline',
        answers
      )
    },
    /**
     * 用户口头批准/拒绝一次高风险操作。
     *
     * 审批超时按**拒绝**算，而且要等五分钟 —— 戴着耳机没看屏幕的话，
     * 那五分钟里用户完全不知道有个确认框在等他。这条通道就是补这个洞的。
     */
    onApprove: (toolCallId, verdict) => {
      agentV3API.replyApproval(toolCallId, verdict)
    }
  })

  // 报错弹一次就够。原先每个页面各挂一个 watcher，开几条对话就弹几个
  watch(shared.error, (value) => {
    if (value) message.error(value)
  })

  /*
   * 通话状态推给自动朗读那一头：通话期间一律不念（见 `voiceCallState`）。
   *
   * 连接中就算通话中 —— 麦克风那时已经开了，念出去照样被收进来。
   */
  const state = shared
  watch(() => state.active.value || state.connecting.value, setVoiceCallActive, {
    immediate: true
  })

  /*
   * 防冷场开关同步给主进程。
   *
   * 开关存在渲染层（和其余偏好设置一处），判断和播报在主进程 —— 主进程读不到
   * 渲染层的存储，所以只能推。`immediate` 那一次覆盖开语音之前的情况，
   * 之后用户在设置里改了也立刻生效（不用重开语音）。
   */
  watch(
    () => aiConfigStore.voiceAntiSilenceEnabled,
    // 可选链：语音这一路在不少测试里只桩了用到的那几个 API，
    // 而这条 watcher 是建单例时就跑的，硬调会把不相干的用例一起带崩
    (enabled) => window.api?.realtimeVoice?.setAntiSilence?.(enabled),
    { immediate: true }
  )
  watch(
    () => aiConfigStore.voiceAutoHangupEnabled,
    (enabled) => window.api?.realtimeVoice?.setAutoHangup?.(enabled),
    { immediate: true }
  )

  /*
   * 「打断语音助手」那个全局快捷键。
   *
   * 挂在这儿而不是某个页面上：语音是应用级的一路，用这个键的场景恰恰是
   * 「窗口在后台、手在别处」—— 挂在页面上的话，切走页面键就失灵了。
   * 默认没有配按键（见 `models/shortcut.ts`），要用得自己去设置里配一个。
   */
  window.api.realtimeVoice.onInterruptShortcut(() => shared?.interrupt())

  return shared
}

/** 只给测试用：把单例、宿主表和绑定清掉，让下一个用例从零开始 */
export function resetVoiceAssistantForTests(): void {
  voiceScope?.stop()
  voiceScope = null
  shared = null
  hosts.splice(0, hosts.length)
  voiceAssistantMessageId = ''
  boundSid = ''
  workerOrder = []
  workerLabels.clear()
  setVoiceCallActive(false)
}
