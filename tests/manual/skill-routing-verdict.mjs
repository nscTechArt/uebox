/**
 * 技能路由判定 —— 「模型有没有先读对技能，再动手」。
 *
 * ## 为什么单独一个纯模块
 *
 * 这里的判定要能在**没有真实模型、不发一次请求**的情况下被反例测住。
 * 三个已确认的漏判都只有构造事件流才验得出来（见下），跟真机跑一遍无关。
 * 所以判定逻辑不能长在 `verify-real-model.mjs` 里 —— 那个文件要拉 Electron。
 *
 * ## 三个被评审复现出来的漏判
 *
 * 原判定是纯位置的：`indexOf('load_skill')` 和第一个业务工具的下标比大小，
 * **不看 `tool-result`、不看调用出自哪一次模型响应**。于是：
 *
 * 1. **加载失败后动手** —— `load_skill` 报错了，模型照样往下做。下标在前，判通过。
 * 2. **加载没返回就动手** —— 调用发出去了但没有配对的结果。同样判通过。
 * 3. **同一次回答里同时派出加载和业务调用** —— 运行时依次执行，日志顺序完全正确，
 *    但业务调用的参数在那一刻**已经生成完了**，模型当时根本没读到技能正文。
 *
 * 第 3 条不是边缘情况：`load_skill` 没有声明 `concurrency`，默认值是 `'parallel'`
 * （`tools/defineTool.ts`），**默认执行策略允许这条路径**。
 * 注意它也修不掉 —— 改成 `sequential` 管的是执行顺序，而参数早就生成完了。
 * 这里只负责**把它认出来**，怎么修是另一件事。
 *
 * ## 响应边界从哪来
 *
 * `agent-v3:step` 就是响应边界：`host/eventBridge.ts` 在每次 `turn_end` 投一条，
 * 而 pi 的一个 turn 就是**一次模型响应加它的工具执行**（pi-agent-core 的
 * `types.d.ts`：`turn_end` 之后、"before the loop decides whether another provider
 * request should start"）。
 *
 * 所以：第一条 `step` 之前的调用属于响应 0，两条 `step` 之间的属于响应 1，以此类推。
 * **不需要给事件加新字段。**
 */

/** 技能体系自身的工具。它们不算「动手」 */
export const SKILL_TOOLS = Object.freeze(['load_skill', 'read_skill_resource', 'list_skills'])

/**
 * 六种判定结果。**只有 `READ_FIRST` 算通过。**
 *
 * 把失败拆成五种而不是记一个「没通过」，是因为它们的修法完全不同：
 * 读错技能要改描述的判别力，同响应派发要改机制，加载失败往往说明用例本身写错了。
 * 汇总成一个数字就把这三条路径混在一起了。
 */
export const VERDICT = Object.freeze({
  /** 先读对了技能，业务调用出自技能成功返回之后的下一次响应 */
  READ_FIRST: 'read-first',
  /** 加载与业务调用出自同一次模型响应 —— 决定早于阅读 */
  SAME_RESPONSE: 'same-response',
  /** 读对了，但业务工具先动了 */
  READ_LATE: 'read-late',
  /** 加载的是别的技能 */
  WRONG_SKILL: 'wrong-skill',
  /** 调了目标技能，但结果报错或压根没有结果 */
  LOAD_FAILED: 'load-failed',
  /** 整轮没调 `load_skill` */
  NOT_READ: 'not-read',
  /** 无技能例专用：确实一个技能都没加载 */
  NO_SKILL_OK: 'no-skill-ok',
  /** 无技能例专用：不该加载却加载了 */
  NO_SKILL_VIOLATED: 'no-skill-violated'
})

/**
 * 被半路叫停之后**仍然作数**的判定：再多跑几轮也不会变成别的结论。
 *
 * 判据是「这条结论会不会被后续事件推翻」，不是「它断言的是有还是无」——
 * 第一版按后者划分，漏掉了两种：
 *
 * - `wrong-skill`：读错了技能、**还没动手**就被截断。继续跑的话模型完全可能
 *   再去读对的那个、然后才动手，最终是 `read-first`。
 * - `load-failed`：加载失败、还没动手就被截断。重试一次成功，同样变成 `read-first`。
 *
 * 剩下三种是稳定的：
 * - `read-first`：正确的技能已经成功读到、且在任何业务调用之前。后面再做什么都改不了这件事。
 * - `same-response` / `read-late`：业务调用已经发生，且相对位置已经定死。
 *
 * `not-read` / `no-skill-ok` 断言「整轮都没发生」，天然要整轮跑完才算数。
 */
export const TRUNCATION_SAFE_VERDICTS = Object.freeze([
  VERDICT.READ_FIRST,
  VERDICT.SAME_RESPONSE,
  VERDICT.READ_LATE
])

/**
 * 把事件流整理成「带响应序号的调用列表」。
 *
 * 只认属于 `sessionId` 的事件。**这不是防御性编程，是必须的**：
 * harness 原来的监听器把所有 `agent-v3:*` 全量推进同一个数组，
 * 上一条用例超时后仍在跑，它的调用会流进下一条用例的样本里。
 */
export function groupCalls(events, sessionId) {
  const calls = []
  const byId = new Map()
  let response = 0

  for (const event of events) {
    if (sessionId !== undefined && event.sessionId !== sessionId) continue

    if (event.type === 'step') {
      // step 投的是「这次响应连同它的工具执行都结束了」，所以先收尾再进位
      response += 1
      continue
    }

    if (event.type === 'tool-call') {
      const call = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        response,
        result: null
      }
      calls.push(call)
      byId.set(event.toolCallId, call)
      continue
    }

    if (event.type === 'tool-result') {
      const call = byId.get(event.toolCallId)
      // 配不上的结果不丢：它意味着事件流本身不完整，样本有效性那一关要看见它
      if (call) call.result = { isError: event.isError === true, text: event.text ?? '' }
    }
  }

  return calls
}

/**
 * `/api/debug/agent` 那条路的适配器。
 *
 * 它已经按 `tool_execution_start/end` 把调用聚好了，并且带着 `response`
 * （出自第几次模型响应），所以不需要再走 `groupCalls` 的事件分组。
 * 两条路进到 `classify` 的形状必须一致 —— 不一致就等于两套判定，
 * 那正是「测的不是产品」的开头。
 */
export function callsFromDebugAgent(toolCalls = []) {
  return toolCalls.map((c) => ({
    // 保留 ID：端点按 toolCallId 配对结果（并发同名调用按工具名会配错），
    // 这边丢掉 ID 就没法回头核对是哪一次调用
    toolCallId: c.toolCallId ?? null,
    toolName: c.name,
    args: c.args,
    response: c.response ?? 0,
    // isError 只在 tool_execution_end 时填。字段缺失 = 这次调用没有结果，
    // 和事件流里「没有配对的 tool-result」是同一件事，不能当成成功
    result: 'isError' in c ? { isError: c.isError === true, text: c.result ?? '' } : null
  }))
}

/** `load_skill` 的参数在不同版本里可能是 `name` 也可能是裸字符串，两种都认 */
function skillNameOf(args) {
  if (typeof args === 'string') return args
  if (args && typeof args === 'object' && typeof args.name === 'string') return args.name
  return null
}

/**
 * 判一条样本。
 *
 * `expect === null` 表示「无技能例」：这一轮不该加载任何技能。
 * `nearby` 是邻域混淆例的相邻技能名，命中了要单独记，因为它和「随便读错一个」
 * 说明的问题不一样 —— 前者是两条描述分不开，后者是压根没找对方向。
 */
export function classify(calls, { expect, nearby = [] } = {}) {
  const skillCalls = calls.filter((c) => c.toolName === 'load_skill')
  const bizCalls = calls.filter((c) => !SKILL_TOOLS.includes(c.toolName))

  if (expect === null || expect === undefined) {
    return skillCalls.length === 0
      ? { verdict: VERDICT.NO_SKILL_OK, pass: true }
      : {
          verdict: VERDICT.NO_SKILL_VIOLATED,
          pass: false,
          loaded: skillCalls.map((c) => skillNameOf(c.args))
        }
  }

  if (skillCalls.length === 0) return { verdict: VERDICT.NOT_READ, pass: false }

  const attempts = skillCalls.filter((c) => skillNameOf(c.args) === expect)
  if (attempts.length === 0) {
    const loaded = skillCalls.map((c) => skillNameOf(c.args))
    const confusedWith = loaded.find((n) => nearby.includes(n)) ?? null
    return { verdict: VERDICT.WRONG_SKILL, pass: false, loaded, confusedWith }
  }

  // 判据锚在**首次成功**加载上，不是首次调用。
  //
  // 原来取的是第一次调用，一失败就直接返回 `load-failed`，后面重试成功也不看了。
  // 于是「加载失败@r0 → 重试成功@r1 → 业务调用@r2」被判成失败，
  // 而模型其实完完整整地先读对了技能才动手 —— 那是 `read-first`。
  //
  // 全部尝试都失败时才是 `load-failed`；理由取**最后一次**失败，
  // 它比第一次更能说明「为什么最终没读到」。
  const hit = attempts.find((c) => c.result && !c.result.isError)
  if (!hit) {
    const last = attempts[attempts.length - 1]
    return {
      verdict: VERDICT.LOAD_FAILED,
      pass: false,
      reason: last.result ? 'error' : 'no-result',
      attempts: attempts.length
    }
  }

  const firstBiz = bizCalls[0]
  // 读对了、也没动手。路由这件事本身是对的 —— 这个指标量的就是路由
  if (!firstBiz) return { verdict: VERDICT.READ_FIRST, pass: true, acted: false }

  if (firstBiz.response === hit.response) {
    return {
      verdict: VERDICT.SAME_RESPONSE,
      pass: false,
      response: hit.response,
      firstBizTool: firstBiz.toolName
    }
  }
  if (firstBiz.response < hit.response) {
    return { verdict: VERDICT.READ_LATE, pass: false, firstBizTool: firstBiz.toolName }
  }
  return { verdict: VERDICT.READ_FIRST, pass: true, acted: true }
}

/**
 * 样本有效性。**与判定分开**，因为两者的处置完全不同：
 * 判定失败进分子，样本无效**要从分母里剔除**。
 *
 * 混淆这两件事会造出最坏的一种假数据：请求 401、模型一个工具都没调，
 * 被记成「没有误触发」。`verify-real-model.mjs` 的前置检查原本要挡住这种情况，
 * 但它多读了一层 `.out`（`execute` 的返回是扁平的），条件恒为 undefined，
 * 从来没生效过 —— 这正是那个文件头部注释里"排查了一整轮"的故障。
 *
 * `requiredCompeting` 是另一回事，所以单独用 `usableFor` 表达：
 * 缺少可动手的工具时，样本对「判别力」仍然有效，只是不能用来回答
 * 「模型会不会跳过技能直接动手」—— 没有可动手的工具，跳过在物理上就出现不了。
 */
export function sampleValidity({
  execResult,
  events = [],
  /** 已经聚好的调用列表（`/api/debug/agent` 那条路）。给了就不再从 events 分组 */
  calls: prebuiltCalls = null,
  sessionId,
  timedOut = false,
  drained,
  /** 这一轮是不是被主动叫停的（撞到工具调用上限之类） */
  truncated = false,
  /** 已经算出的判定。给了才能判「截断有没有影响这条结论」 */
  verdict = null,
  requiredCompeting = [],
  toolNames = null
} = {}) {
  const invalid = (reason, detail) => ({
    ok: false,
    reason,
    ...(detail ? { detail } : {}),
    usableFor: { routing: false, skip: false }
  })

  if (timedOut) {
    // 没停住比单纯超时严重得多：旧 agent 还在跑，它的调用会污染下一条样本
    return invalid(drained === true ? 'timeout' : 'timeout-not-drained')
  }
  if (!execResult || execResult.success !== true) {
    return invalid('model-not-run', execResult?.error ?? '(execute 没有返回 success)')
  }

  const foreign = events.find((e) => e.sessionId !== undefined && e.sessionId !== sessionId)
  if (foreign) return invalid('cross-sample', `收到 ${foreign.sessionId} 的事件`)

  // 半路叫停 ≠ 样本一定有效。要看这条结论会不会被后续事件推翻。
  if (truncated && verdict && !TRUNCATION_SAFE_VERDICTS.includes(verdict)) {
    return invalid('truncated-before-conclusion', `${verdict} 要整轮正常结束才算数`)
  }

  // 缺结果的调用只有**可能改变判定**时才算样本无效。
  //
  // 判定只取决于两件事：每一次 `load_skill`（要看它成没成），以及**第一个**
  // 业务调用（要看它出自哪次响应）。排在这之后的调用缺不缺结果，判定都一样。
  //
  // 这不是放宽，是把检查对准它要防的东西：判定看不到的地方，缺不缺结果都不影响判定。
  //
  // （更正：第一轮真机上那三次"没有结果"的 `web_search` **不是**截断造成的，
  // 是端点当时按**工具名**找回填对象，并发同名调用互相覆盖 —— 落盘的会话记录里
  // 那三次搜索都有结果。端点已改成按 `toolCallId` 配对。）
  const calls = prebuiltCalls ?? groupCalls(events, sessionId)
  const firstBizIndex = calls.findIndex((c) => !SKILL_TOOLS.includes(c.toolName))
  const decisive = calls.filter(
    (c, i) => c.toolName === 'load_skill' || (firstBizIndex >= 0 && i === firstBizIndex)
  )
  const unpaired = decisive.find((c) => !c.result)
  if (unpaired) return invalid('unpaired-call', `${unpaired.toolName} 没有配对的结果`)

  const missing = toolNames
    ? requiredCompeting.filter((name) => !toolNames.includes(name))
    : requiredCompeting.slice()

  if (missing.length > 0) {
    return {
      ok: true,
      reason: 'missing-competing-tools',
      detail: missing.join(', '),
      usableFor: { routing: true, skip: false }
    }
  }

  return { ok: true, usableFor: { routing: true, skip: true } }
}

/**
 * 一批样本的汇总。
 *
 * 无效样本**不进分母**，单独报数。「同响应批量派发率」是**诊断指标**：
 * 它说明的是模型选择了什么形状的调用，说明不了原因 —— 描述本来就在上下文里，
 * 改描述完全可能改变这个选择。所以它跟命中率一起报，但不单独构成任何结论。
 */
export function summarize(samples) {
  const valid = samples.filter((s) => s.validity.ok)
  const invalid = samples.filter((s) => !s.validity.ok)
  const skipUsable = valid.filter((s) => s.validity.usableFor.skip)

  const count = (list, fn) => list.filter(fn).length
  const rate = (n, d) => (d === 0 ? null : n / d)

  const passed = count(valid, (s) => s.result.pass)
  const sameResponse = count(skipUsable, (s) => s.result.verdict === VERDICT.SAME_RESPONSE)
  const confused = count(valid, (s) => s.result.confusedWith)

  const byReason = {}
  for (const s of invalid) byReason[s.validity.reason] = (byReason[s.validity.reason] ?? 0) + 1

  return {
    total: samples.length,
    valid: valid.length,
    invalid: invalid.length,
    invalidByReason: byReason,
    passRate: rate(passed, valid.length),
    confusionRate: rate(confused, valid.length),
    /** 诊断指标，不作结论。分母只算「确实有竞争工具可用」的样本 */
    sameResponseRate: rate(sameResponse, skipUsable.length),
    skipUsable: skipUsable.length,
    byVerdict: Object.fromEntries(
      Object.values(VERDICT).map((v) => [v, count(valid, (s) => s.result.verdict === v)])
    )
  }
}

/**
 * 整批中止的信号。
 *
 * 「超时后没停住」意味着旧 agent 还在后台跑，它的调用会流进后面每一条样本 ——
 * 这时候继续跑只是在造脏数据，还接着花钱。
 */
export class BatchAborted extends Error {}

/**
 * 每次跑完一轮都要过这道闸。**放在所有判定线共用的入口上**，不是各条自己判。
 *
 * 上一版只在判定线 ① 的循环里 `break`：②③④ 各有各的调用点，谁都没检查停止结果。
 * 于是 ② 或 ③ 自己超时没停住时完全没人管 —— 评审复现出 `--only=3,4` 在超时之后
 * 又启动了 10 次。抛异常而不是设标志，是为了立刻打断当前调用链；
 * 调用方在最外层统一 catch，收尾（写结果、截图、退出码）照常走。
 */
export function assertBatchNotStuck({ sessionId, timedOut, drained }) {
  if (timedOut && drained !== true) {
    throw new BatchAborted(`会话 ${sessionId} 超时后没有停住（drained=${drained}）`)
  }
}
