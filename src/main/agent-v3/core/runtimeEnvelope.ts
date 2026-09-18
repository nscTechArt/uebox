/**
 * 运行时信封 —— 「这一轮的机器事实」。
 *
 * ## 它修的是哪个 bug
 *
 * 真机上的原始故障链（会话 cb5dedbe-974f-4995-b56d-af7646870188）：
 *
 *   - 前一天 22:13，某一轮 `ue_session_health` 回了 `not_running`（当时确实关着）
 *   - 次日 13:04:48 插件重新连上 UALinkDev55，之后一直没断
 *   - 13:07:09 用户问「我们项目里有啥」
 *   - 模型思考里原样引用那条隔夜的旧结论（`The editor isn't running currently
 *     (not_running)`），对用户说「编辑器现在没跑，引擎工具用不了」，
 *     然后连开二十多次 `list_local_dir` 扫磁盘 —— 整轮一次都没复核过连接
 *
 * 所以它不只是「选错了工具」：它对用户说了一句**当时就是假的**话。
 *
 * 根因不在提示词写得够不够，在**上下文结构**：每条用户消息都会重建一次 Agent，
 * 把 JSONL 历史原样恢复回去；工具清单按本轮状态重算了，历史里那条旧结论却
 * 一个字没变地留在模型眼前。两份互相矛盾的「当前状态」，模型信了会说话的那份。
 *
 * ## 为什么是「追加」而不是「改写」
 *
 * 最容易想到的修法是：每轮把当前状态插进最新那条用户消息，下一轮再把它挪走。
 * 那等于**每一轮都重写模型已经见过的前缀** —— 厂商的 Prompt Cache 按前缀命中，
 * 前缀一改，整段上下文每轮全部重新计费，长会话上是几十万 token 的量级。
 *
 * 所以规则只有一条：**固定内容永远不变，变化内容只追加在末尾，不回头改历史。**
 * 每条用户消息带一份自己的信封，写进 JSONL 就再也不动；模型侧的判据是
 * 「最后一个信封代表现在，此前所有信封都是历史」。这条判据本身是长期规则，
 * 所以它写在系统提示词里（`RUNTIME_ENVELOPE_RULES`），不跟着信封每轮重复。
 *
 * ## 为什么信封拼在用户消息里，而不是单独一条消息
 *
 * 单独一条的话，压缩切点（`compaction.ts` 的 `splitAtRecentBudget`）可能把信封
 * 和它描述的那条用户消息切开，留下一个没有主人的信封。拼在同一条消息里，
 * 两者永远同生共死。界面不受影响 —— 渲染层有自己那份聊天记录，
 * transcript 是模型的视图，两本账。
 *
 * ## 为什么只有这几个字段
 *
 * 信封每轮都要付一次 token，而且**永远留在历史里**。所以只放和这条 bug 直接
 * 相关的事实：连接、工程、作用域。日期、模型身份、Ask 模式、MCP 状态目前仍在
 * 系统提示词的 `<environment>` 块里 —— 把它们也搬过来是「稳定前缀」那件事，
 * 收益全在缓存、风险全在模型行为，值得单独一轮配真机评测再做。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/** 一个工程在信封里的样子。字段都可能缺，缺了就不印，不印 undefined */
export interface EnvelopeProject {
  name: string
  engineVersion?: string
  /**
   * **登记时抄下来的**路径，不是「刚确认过这个目录还在」。
   *
   * 印出去的键名叫 `path_on_record` 就是为了让这件事写在名字里 —— 以前它叫
   * `path`，然后要在提示词里花一整句解释「登记路径不证明目录还在」。
   */
  pathOnRecord?: string
}

/**
 * 引擎连接此刻的样子。**一个字段三个状态**，不是两个布尔值。
 *
 * 以前是 `engineToolsAvailable` + `connectedAtRunStart` 两个布尔，真正有意义的
 * 是它们的组合：(false, true) 才表示「用户连着，只是没连这条会话的工程」。
 * 模型得先做一次合取推导才能拿到这个事实，于是提示词里要写一句话教它怎么推 ——
 * 那句话是我们自己制造的债。三个状态直接说出来就没有那句话了。
 *
 * - `target`        工具够得着这条会话的工程
 * - `other_project` 有连接，但不是这条会话的工程（**别劝人装插件，他连着**）
 * - `none`          这台机器上一个 UE 连接都没有
 */
export type EngineLink = 'target' | 'other_project' | 'none'

/** 一轮执行的运行时事实 */
export interface RuntimeEnvelope {
  /** 这一轮的作用域 id。工具结果盖同一个戳，模型据此分辨「这是不是这一轮的观测」 */
  runtimeScopeId: string
  /** 观测时刻（ISO）。信封之间比新旧靠它 */
  observedAt: string
  /** 这一轮**真的去查过**的唯一一件事。其余字段都是记录，这轮没重新核对 */
  engineLink: EngineLink
  /** 工具真正够得着的那个工程 */
  targetProject?: EnvelopeProject
  /** 这条会话归属的工程 */
  sessionProject?: EnvelopeProject
  /** 连着、但不属于这条会话的工程名 */
  outOfScopeProjects?: string[]
}

/** 新开一轮的作用域 id */
export function createRuntimeScopeId(): string {
  return `rt-${randomUUID().slice(0, 8)}`
}

const storage = new AsyncLocalStorage<string>()

/**
 * 在某个运行时作用域里跑一段逻辑。
 *
 * 和 `projectTargetContext` 同样的道理：并发会话、并发工具、子 agent 各有各的
 * 执行流，模块级变量会被后来者覆盖。工具（`ue_session_health`）在自己的执行流里
 * 读到的必须是**发起它那一轮**的 id。
 */
export function runWithRuntimeScope<T>(scopeId: string, fn: () => T): T {
  return storage.run(scopeId, fn)
}

/** 当前执行流的作用域 id。不在作用域里（调试入口、无头跑）返回 undefined */
export function getRuntimeScopeId(): string | undefined {
  return storage.getStore()
}

/** 工程的一行摘要。字段可选，缺了就跳过而不是印出 undefined */
function describeProject(project: EnvelopeProject): string {
  const engine = project.engineVersion ? ` (UE ${project.engineVersion})` : ''
  const path = project.pathOnRecord ? `, path_on_record ${project.pathOnRecord}` : ''
  return `${project.name}${engine}${path}`
}

/**
 * 信封的文本形态 —— 模型真正看到的那几行。
 *
 * 刻意写成 `key: value` 而不是散文：散文里的状态需要被解读，键值对不需要，
 * 而这一段的全部作用就是让「现在是什么状态」没有解读空间。
 * 解读规则统一在 `RUNTIME_ENVELOPE_RULES` 里说一次。
 *
 * **`checked_now` 那一行是这个块最重要的一行。** 它把「刚查过的」和「记在册上的」
 * 分开：以前整个块被一句「机器核对过的事实」盖住，可里面装着三种东西 ——
 * 用户设的标签、登记时抄的路径、刚查过的连接。袋子标错了还要求模型严谨，
 * 它只能二选一：全信（于是断言目录还在），或全不信（于是手上有路径也要再查一遍）。
 * 观测到的两种相反的错都是从这里来的。
 */
export function formatRuntimeEnvelope(envelope: RuntimeEnvelope): string {
  const outOfScope = envelope.outOfScopeProjects?.filter(Boolean) ?? []

  return [
    `<runtime-status scope="${envelope.runtimeScopeId}">`,
    `checked_now: engine_link (at ${envelope.observedAt}); every other line is on record and was not re-checked`,
    `engine_link: ${envelope.engineLink}`,
    ...(envelope.targetProject
      ? [`target_project: ${describeProject(envelope.targetProject)}`]
      : []),
    ...(envelope.sessionProject
      ? [`session_project: ${describeProject(envelope.sessionProject)}`]
      : []),
    `other_connected_projects: ${outOfScope.length > 0 ? outOfScope.join(', ') : '(none)'}`,
    '</runtime-status>'
  ].join('\n')
}

/**
 * 把信封拼到这一轮的用户输入前面。
 *
 * 信封在前、用户原话在后：用户说的话离模型的下一步最近，那是它该照着做的东西；
 * 信封是背景事实，读一眼就够。
 */
export function withRuntimeEnvelope(prompt: string, envelope: RuntimeEnvelope | undefined): string {
  if (!envelope) return prompt
  return `${formatRuntimeEnvelope(envelope)}\n\n${prompt}`
}

/**
 * 系统提示词里那一段**不变**的解读规则。
 *
 * 为什么规则和事实要分家：事实每轮都不一样，规则一个字都不该变。混在一起写的话
 * 每轮的提示词都是新的，Prompt Cache 一次也命中不了 —— 而这一段解释性文字
 * 恰恰是最长、最值得被缓存的部分。
 *
 * 它**不重复** `<environment>` 块已经说过的东西（连接引导、越界工程的处置、
 * Ask 模式）。那些还留在原处。
 *
 * ## 为什么写成原则 + 实例，而不是一条故障一条判例
 *
 * 这一段曾经是判例法：每出一次真机故障就追加一条 bullet。判例法不外推 ——
 * 下一个没见过的情形就得再加一条，而且条与条之间会打架。真实的例子：
 * 为了修「问路径却去扫盘」，这里一度加过一句「只有用户明确询问文件内容时
 * 才能检查文件」。它让那一次验收过了，也顺手把「帮我修这个工程的代码」
 * 变成了要先请示才能读文件 —— 把一次验收表现当成了产品正确性。
 *
 * 所以改成两层：**先说怎么理解事实，再说据此怎么动手**，每条原则底下挂着
 * 真机上确实翻过车的那个具体情形。原则底下的例子会外推到没见过的情形；
 * 只有例子没有原则，就只能等下一次故障。
 *
 * 判断这一段有没有写对，看的是**下一次出事的修补落在哪**：落在数据里
 * （给块补一个字段、给结果补一个戳）说明它收敛，落在这里再加一条 bullet
 * 说明它又退回判例法了。
 *
 * 与此配套的硬约束（否则规则说了也没用）：
 * - 「没有连接」不等于「工程没打开」。`sessionScope.ts` 里 `engineAvailable`
 *   为 false 只意味着**没有映射到这条会话工程的连接**，路径键对不上时工程
 *   开得好好的它也是 false。环境块必须照这个说，见 `buildEnvironmentSection`。
 * - 「工具失败」不等于「编辑器没了」。只有明说连接断了的那类错误能推出这个
 *   结论，超时/权限/参数都不能。
 *
 * 全英文的理由同 `createAgent.ts` 的 `buildSystemPrompt`。
 */
export const RUNTIME_ENVELOPE_RULES: readonly string[] = Object.freeze([
  'Runtime status:',
  'Every user message in this conversation starts with a `<runtime-status>` block. Its `checked_now` line says which single field was actually measured when that message was sent; every other line is what Unreal Box has on record, carried forward as-is. Envelopes are appended and kept verbatim, so older messages keep their older envelopes on purpose.',

  'Reading these facts:',
  '- **Each field means exactly one thing; read it for that one thing.** `session_project` is which project this conversation is filed under — a folder the user picked. `engine_link` describes the engine connection. Between them that is the whole of what they report: what kind of project it is, whether a given file exists, and whether an editor is running all remain open questions, answered by looking or by asking. Treat an engine version, a `.uproject`, or a project type as established once something actually reports it.',
  '- **Compare observations of the same thing, and prefer the newer and more direct one.** The last `<runtime-status>` outranks every earlier one: every earlier envelope, every earlier tool result, and any summary of earlier conversation says what was true then, not what is true now. If an earlier turn found the engine disconnected and the last envelope says `engine_link: target`, the engine is reachable now — use it, and let the last envelope replace your earlier conclusion, since repeating the old one is telling the user something false. A field merely absent from the newer envelope still stands as recorded; it was carried forward rather than contradicted. An observation speaks only for the project it came from.',
  // 措辞刻意避开 `<environment>` 这个字面量：提示词末尾那个块就是用它开头的，
  // 在这里原样写出来会让「按标签定位环境块」的代码和测试定位到这一行上
  '- Two things can be newer than the last envelope. The environment block at the very end of these instructions is rebuilt **during** the turn, so when it and the envelope disagree, go by the block. And **a tool call that actually failed outranks both** — the block and your tool list describe what was true when they were built, while an error is happening now. That gap matters most inside a `task` sub-agent, whose block and tool list are frozen for its whole run.',
  '- Results carrying an observation stamp (`observed_in_scope`) describe the present when that stamp matches the scope of the last envelope, and speak only for the past when it does not. A result marked as a legacy historical observation predates stamping, so it too speaks only for the past. When you need the current state, observe it again rather than reasoning from an old result.',
  '- **Read an absent field as "unknown", and read a failure as exactly what it reported.** A missing `path_on_record` means precisely that none was recorded; whether the folder is still there is a separate question, and going to look answers it. `engine_link: none` means precisely that no engine connection reached Unreal Box; whether the editor is closed, the plugin missing, or the project failed to open all stay open. A timeout means the operation was not confirmed, a permission error means permission, a rejected argument means the argument. An error saying the connection itself is gone ("client not found or disconnected") is the one that establishes the editor went away — then say so and stop, since the environment block naming a project is older than that error.',

  'Acting on them:',
  '- **Verify whenever the task needs it; permission to inspect is already yours.** If what you already have answers the question — the recorded path of a project, for instance — use it and stop. If the work depends on what is actually inside a file, on the current state of something, or on resolving a contradiction, go and check: read the file, list the directory, call the tool. Start the check from what you already know — the recorded path, the named file — and widen it only as far as the evidence justifies: with an address in hand, go straight there; when finding something *is* the task the user gave you, search as widely as the clues support.',
  "- **Keep working on the object this conversation is about.** `session_project` and `target_project` can name different projects, and `engine_link: other_project` means the user *is* connected, just not to this conversation's project — so treat the plugin and the connection as working, and talk about reaching *this* project instead. Act on this conversation's project alone, and attribute anything you learn about the other one to the project it came from. Looking something up over there leaves this conversation filed where it is. When the work genuinely belongs in the other project — you just created it, or the user said to work there — call `set_session_project` yourself and keep going; that move is yours to make. When it is genuinely unclear, ask with `ask_user`.",
  '- Your tool list is re-checked before every step. `project_manage` with `open_project` defaults to waitSeconds=0: it launches the editor and returns while it loads; connected=false is not a launch failure. Check ue_session_health for the requested project path without a long wait. Once that project connects, call open_project for the same project with waitSeconds: 5 to verify readiness and retarget this turn (an already connected project is not relaunched). Continue engine work only after connected=true and switched_target=true; keep explicit waits below the caller timeout.',
  "- While engine tools are available, questions about the project's contents — its assets, blueprints, actors, the level — are answered by asking the engine, which is what describes an asset; a `.uasset` filename on disk carries only the name. The local disk tools (`list_local_dir`, `find_local_files`, `grep_local_files`) cover the user's own files, and remain the right way to reach source code, config and logs.",
  '- Explain a limitation when it changes how much the user can trust your answer or what happens next, and pair it with something they can actually do. Where the work stayed clear of the engine, let the answer end there.'
])

/**
 * 从已有 transcript 里找回**最后一个**信封的作用域 id。
 *
 * 「从断点续跑」用它：那条路不产生新的用户消息（`agent.continue()` 要求最后一条
 * 是 user 或 toolResult），所以也就没有新信封可发。硬造一个新 id 的话，续跑里
 * 那次健康检查会盖上一个**和任何信封都对不上**的戳，模型按规则把一份刚拿到的
 * 新鲜观测当成历史 —— 比不盖还糟。沿用最后那个 id，续跑就落在同一轮里。
 *
 * 找不到（本次改动之前的存量会话）返回 undefined，整套机制对那些会话静默失效，
 * 行为退回改动之前，不会更差。
 */
export function lastRuntimeScopeId(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const record = messages[i] as { role?: string; content?: unknown }
    if (record?.role !== 'user') continue

    const text =
      typeof record.content === 'string'
        ? record.content
        : Array.isArray(record.content)
          ? record.content.map((block) => (block as { text?: string })?.text ?? '').join('\n')
          : ''

    const matched = /<runtime-status scope="([^"]+)">/.exec(text)
    if (matched) return matched[1]
  }
  return undefined
}

/** 标记 legacy 健康检查结果用的那句话 */
export const LEGACY_HEALTH_MARKER =
  '[legacy historical observation: recorded before runtime scopes existed. It does not describe the present — read the last <runtime-status> instead.]'

/** 健康检查结果里那行作用域戳的键名。写成常量，免得标记逻辑和工具两边写岔 */
export const HEALTH_SCOPE_FIELD = 'observed_in_scope'

/** 会话体检工具的名字。标记逻辑和工具定义共用一份，不能各写各的 */
export const SESSION_HEALTH_TOOL_NAME = 'ue_session_health'

/**
 * 给**旧格式**的健康检查结果打一个「这是历史观测」的标记。
 *
 * ## 为什么不去改 JSONL
 *
 * 盘上那份是原始记录，改它就等于篡改用户的对话历史 —— 而且改完还得考虑
 * 改到一半断电、分支会话共享同一段前缀这些事。这里改的是**模型视图**：
 * `convertToLlm` 每次请求都跑一遍，盘上一个字节都不动。
 *
 * ## 为什么改写历史不会打掉缓存
 *
 * 因为它**完全确定性**：同样的输入永远得到同样的输出，不带时间戳、不带随机数。
 * 于是每一轮渲染出来的前缀是逐字节相同的，Prompt Cache 照常命中。
 * 这也是为什么标记文案是个常量而不是现拼的句子。
 *
 * 只标没有作用域戳的那些（本次改动之前留下的存量）。带戳的结果自己会说明
 * 属于哪一轮，交给 `RUNTIME_ENVELOPE_RULES` 里那条「只有戳对得上才算当前」处理。
 */
export function markLegacyHealthResults<T>(messages: T[]): T[] {
  let changed = false

  const marked = messages.map((message) => {
    const record = message as {
      role?: string
      toolName?: string
      content?: { type?: string; text?: string }[]
    }
    if (record.role !== 'toolResult' || record.toolName !== SESSION_HEALTH_TOOL_NAME) return message
    if (!Array.isArray(record.content)) return message

    const index = record.content.findIndex((block) => block?.type === 'text')
    if (index < 0) return message

    const block = record.content[index]
    if ((block.text ?? '').includes(`${HEALTH_SCOPE_FIELD}=`)) return message

    changed = true
    const content = [...record.content]
    content[index] = { ...block, text: `${LEGACY_HEALTH_MARKER}\n\n${block.text ?? ''}` }
    return { ...record, content } as unknown as T
  })

  // 一条都没标就把原数组还回去 —— 绝大多数会话里没有存量结果，
  // 白造一个等长数组是每次请求都要付的空转
  return changed ? marked : messages
}
