/**
 * 工具选择 A/B 的判定。
 *
 * 和 `tool-selection-metrics.mjs` 的分工：那份量的是「一次运行里模型的工具选择
 * 表现如何」，两臂通用；这份量的是**两臂之间的差**，并且负责一件那份做不到的事——
 * 把失败拆成检索缺口和混淆缺口。
 *
 * ## 为什么必须拆
 *
 * 那份文件的头注写着：
 *
 * > 我们目前一次性把全部工具都给模型，所以**检索缺口按定义为零，所有选择失败
 * > 都是混淆缺口**。
 *
 * **B 臂让这句话失效。** 收窄之后，模型可能压根没把正确工具所在的那组取出来 ——
 * 它不是「挑错了」，是「手里没有」。两种失败的修法相反：
 *
 *   - 没取到组（检索缺口）→ 改 finder 的那句摘要，让这类问题指得过去
 *   - 取到组却挑错工具（混淆缺口）→ 改工具描述、或者合并两个长得太像的工具
 *
 * 合成一个「命中率下降」，照着它去改，多半会改错那一头。
 *
 * ## 一个必须先排除的误读
 *
 * `tool-selection-metrics.mjs` 里记着的那条同样适用：**兜底 ≠ 混淆**。
 * 主工具坏掉时改用 Python 是正确的恢复行为。这里的台架把工具全桩掉了、
 * 一个都不会真失败，所以那条误报在这份数据里**不该出现** —— 真出现了，
 * 先怀疑桩没生效，别急着下「模型分不清工具」的结论。
 */

import { FALLBACK_TOOLS, ORIENTATION_TOOLS } from './tool-selection-metrics.mjs'

/** finder 工具名的形状。跟 `tools/builtin/toolFinder.ts` 的命名约定绑在一起 */
export const FINDER_PATTERN = /^find_[a-z_]+_tools$/

/**
 * `accept` 的两种写法统一成 { tool, action?, params? }。
 *
 * 字符串 = 只看工具名（老写法）。对象 = 还要核 `action` 和给定的参数。
 * 合并后的工具（如 `ue_insights_trace(action)`）只看名字会把「把 capture 错选成
 * analyze」也算命中 —— 2026-09-11 Codex 复查指出的那条。
 */
export function acceptEntries(spec) {
  return (spec?.accept ?? []).map((a) => (typeof a === 'string' ? { tool: a } : a))
}

export function acceptNames(spec) {
  return [...new Set(acceptEntries(spec).map((a) => a.tool))]
}

/** 路径比较：斜杠方向和大小写不算差别 */
function normalizeValue(v) {
  return typeof v === 'string' ? v.replace(/\\/g, '/').toLowerCase() : v
}

/** 一次调用是否满足一条 accept：名字对、action 对（若要求）、给定参数都对（若要求） */
export function matchesAccept(call, entry) {
  if (!call || call.name !== entry.tool) return false
  const args = call.args ?? {}
  if (entry.action !== undefined && args.action !== entry.action) return false
  for (const [k, v] of Object.entries(entry.params ?? {})) {
    if (JSON.stringify(normalizeValue(args[k])) !== JSON.stringify(normalizeValue(v))) return false
  }
  return true
}

export function isFinderCall(name) {
  return FINDER_PATTERN.test(String(name ?? ''))
}

/**
 * finder 名 → 组 id。
 *
 * 和主进程那份表**刻意不共享代码**：台架从 HTTP 拿结果，跨进程；
 * 而且如果两边共用一份映射，映射本身写错时两边会一起错，实验反而看不出来。
 * 形状是稳定的（`find_<id>_tools`），`tool-choice-cases.test.ts` 会断言
 * 这份推导和真实的组 id 对得上。
 */
export function groupOfFinder(name) {
  const m = /^find_(.+)_tools$/.exec(String(name ?? ''))
  if (!m) return undefined
  // find_asset_library_tools → assetlib、find_engine_ops_tools → engineops
  return m[1].replace(/_/g, '').replace(/^assetlibrary$/, 'assetlib')
}

/**
 * 判一次运行。
 *
 * @param run `/api/debug/agent` 的返回
 * @param spec 用例
 * @param arm 'A' | 'B'
 */
export function judge(run, spec, arm, toolIndex = {}, neutralTools = []) {
  const calls = (run?.toolCalls ?? []).filter((c) => c && typeof c.name === 'string')
  const finderCalls = calls.filter((c) => isFinderCall(c.name))
  const business = calls.filter((c) => !isFinderCall(c.name))
  const names = business.map((c) => c.name)

  /*
   * **只判第一手。**
   *
   * v1 判的是「整轮有没有调到期望工具」，而台架把执行桩掉了 —— 模型做完第一次
   * 定位查询拿不到真数据，正确地停下来问用户，于是第二步永远到不了。
   * 两臂被同一堵墙挡住，量到的是墙的高度（详见 `tool-choice-cases.mjs` 头注）。
   *
   * 第一个领域动作伸向哪个工具，在模型拿到任何返回**之前**就决定了，
   * 所以这个判据完全不受桩影响。它也正是「工具选择」这件事本身的定义。
   *
   * 定位工具（`neutralTools`）跳过：开工前问一句「这资产在不在」既不是答案，
   * 也不该算失败 —— 台架那边也不拿它收工。
   */
  const firstDomainCall = business.find((c) => !neutralTools.includes(c.name))
  const entries = acceptEntries(spec)
  const accept = acceptNames(spec)
  const hit = Boolean(firstDomainCall && entries.some((e) => matchesAccept(firstDomainCall, e)))
  // 名字对了但 action / 参数不对：合并工具最该盯的那种失手，单独记
  const actionMismatch = Boolean(firstDomainCall && !hit && accept.includes(firstDomainCall.name))
  // 「挑错了」和「压根没出手」要分得开：后者多半是模型讲了一通就结束，
  // 那既不是混淆也不是检索缺口，是这条样本没测到东西
  const noDomainCall = !firstDomainCall

  const loadedGroups = new Set(finderCalls.map((c) => groupOfFinder(c.name)).filter(Boolean))

  /*
   * 检索缺口：这道题该用的组一个都没取出来。
   *
   * 只在 B 臂成立 —— A 臂全部工具都在眼前，「没取到」这件事不存在。
   * `spec.group` 是 null（纯常驻例）时也不成立：答案本来就在常驻集里。
   */
  const neededGroups = spec.crossGroups
    ? spec.crossGroups.filter((g) => !g.startsWith('ue.'))
    : spec.group
      ? [spec.group]
      : []
  const retrievalGap =
    arm === 'B' && !hit && neededGroups.length > 0 && neededGroups.some((g) => !loadedGroups.has(g))

  /*
   * 混淆缺口：工具就在眼前，还是挑了别的。
   *
   * A 臂的每一次失败都是它；B 臂只有「组取到了才算」。
   */
  const confusionGap = !hit && !retrievalGap

  /*
   * 多取的组：**这道题不需要、却取了**的每一个。
   *
   * 第一版只数 `nearbyGroups` 里那些 —— 也就是「我预先想到的混淆」。
   * 那漏掉了最贵的一类：2026-09-11 冒烟里 `bp-door` 一道纯蓝图题，
   * B 臂顺手取了 `material`，而 material 不在我给它写的邻域名单里，
   * 于是「取错了组」报 0。**那一次多取花了 54,341 个未缓存 token**
   * （同一批里只取一组的样本是 624）。
   *
   * 判据只能是「需不需要」，不能是「我有没有预料到」—— 预料不到的那些，
   * 恰恰是这份数据最该告诉我们的东西。
   *
   * `nearbyGroups` 仍然有用，但降级成**标注**：多取的组里，哪些是预先
   * 认定容易混的。它回答「混淆是不是可预测的」，不参与计数。
   */
  const extraGroups = arm === 'B' ? [...loadedGroups].filter((g) => !neededGroups.includes(g)) : []
  const predictedConfusions = extraGroups.filter((g) => (spec.nearbyGroups ?? []).includes(g))

  /*
   * 白花的 finder：纯常驻例里调了任何 finder。
   *
   * 这是渐进式披露最容易被忽略的成本 —— 模型养成「先 find 再说」的习惯之后，
   * 连「这工程叫什么」都要先取一组。汇总里必须看得见。
   */
  const finderWaste = arm === 'B' && spec.residentOnly === true ? finderCalls.length : 0

  /*
   * 跨组例：几个 finder 是不是在**同一次模型响应**里发出去的。
   *
   * 这条是「一次批量取完」那条硬约束的检验（见 docs/工具渐进式披露设计.md §3）。
   * 分两次取 = 两次前缀重写，在不支持原生延迟工具的厂商上直接把收益吃光。
   * `response` 是调试端点记的「第几次模型响应」，不是执行顺序 —— 顺序对不代表
   * 是一批发出来的。
   */
  const finderBatched =
    arm === 'B' && finderCalls.length > 1
      ? new Set(finderCalls.map((c) => c.response)).size === 1
      : null

  const scope = spec.scope ?? []
  const fallbacks = business.filter((c) => FALLBACK_TOOLS.includes(c.name))
  const offScope = scope.length
    ? business.filter((c) => {
        /*
         * 两份「定位工具」名单要合并，不能只认老那份。
         *
         * `ORIENTATION_TOOLS`（`tool-selection-metrics.mjs`）比这套台架早，
         * 里面没有 `ue_get_current_level`。于是台架一边把它当正常定位
         * （不收工、不算答案），一边又按离题记它一笔 —— 2026-09-11 冒烟里
         * 两臂各误报 1 次离题，全是它。
         *
         * 同一个工具在同一份报告里不能既中立又离题。
         */
        if (ORIENTATION_TOOLS.includes(c.name) || neutralTools.includes(c.name)) return false
        if (fallbacks.includes(c)) return false
        const ns = toolIndex[c.name]
        if (!ns) return false
        return !scope.some((s) => ns === s || ns.startsWith(`${s}.`))
      })
    : []

  return {
    tag: spec.tag,
    arm,
    hit,
    /** 第一个领域动作。判定只看它，其余调用只作诊断 */
    firstDomainCall: firstDomainCall?.name ?? null,
    firstDomainArgs: firstDomainCall?.args ?? null,
    actionMismatch,
    noDomainCall,
    accept,
    called: names,
    finderCalls: finderCalls.map((c) => c.name),
    loadedGroups: [...loadedGroups],
    retrievalGap,
    confusionGap,
    extraGroups,
    predictedConfusions,
    finderWaste,
    finderBatched,
    fallbacks: fallbacks.map((c) => c.name),
    offScope: offScope.map((c) => c.name),
    steps: run?.steps ?? 0,
    toolCallCount: calls.length,
    usage: run?.usage ?? null,
    /*
     * 样本有效性。无效样本从分母剔除**并单独报数** ——
     * 静默剔除是预登记里明写禁止的（见技能路由那份 §7）。
     */
    invalid: invalidReason(run, spec)
  }
}

function invalidReason(run, spec) {
  if (!run) return 'no-response'
  // 连不上盒子和模型报错要分开：混在一起的话，盒子被关掉那一次会在报告里
  // 写成「模型报错 N 次」，读的人去查模型和 key，而那台服务根本没在监听
  if (run.benchDown) return 'bench-down'
  if (run.success === false && (run.errors ?? []).length > 0) return 'model-error'
  if (run.hitToolCap) return 'tool-cap'
  if ((run.toolCalls ?? []).length === 0) return 'no-tool-call'
  /*
   * 合法答案**一个都不在**这条会话的工具池里 —— 这道题在物理上就答不对。
   *
   * 只在 A 臂判：B 臂里那些工具本来就该不在起手清单里（要 find 出来），
   * 按 A 臂的标准去判 B 臂会把每一条正例都判成无效。
   */
  if (run.toolMode !== 'finder' && run.toolMode !== 'retrieval') {
    const pool = run.toolNames ?? []
    const names = acceptNames(spec)
    if (names.length > 0 && !names.some((n) => pool.includes(n))) {
      return 'accept-tools-absent'
    }
  }
  return null
}

const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '-')

/** 汇总一臂 */
export function summarizeArm(rows) {
  const valid = rows.filter((r) => !r.invalid)
  const total = {
    n: valid.length,
    invalid: rows.length - valid.length,
    hits: valid.filter((r) => r.hit).length,
    noDomainCall: valid.filter((r) => r.noDomainCall).length,
    actionMismatch: valid.filter((r) => r.actionMismatch).length,
    retrieval: valid.filter((r) => r.retrievalGap).length,
    confusion: valid.filter((r) => r.confusionGap).length,
    // 有多取的样本数，以及一共多取了几组 —— 后者才是花钱的那个数
    extraGroupSamples: valid.filter((r) => r.extraGroups.length > 0).length,
    extraGroupCount: valid.reduce((a, r) => a + r.extraGroups.length, 0),
    predicted: valid.reduce((a, r) => a + r.predictedConfusions.length, 0),
    // 非纯常驻例的 `finderWaste` 按构造就是 0，直接全加即可
    finderWaste: valid.reduce((a, r) => a + r.finderWaste, 0),
    fallbacks: valid.reduce((a, r) => a + r.fallbacks.length, 0),
    offScope: valid.reduce((a, r) => a + r.offScope.length, 0),
    steps: valid.reduce((a, r) => a + r.steps, 0),
    toolCalls: valid.reduce((a, r) => a + r.toolCallCount, 0),
    input: valid.reduce((a, r) => a + (r.usage?.input ?? 0), 0),
    cacheRead: valid.reduce((a, r) => a + (r.usage?.cacheRead ?? 0), 0),
    cacheWrite: valid.reduce((a, r) => a + (r.usage?.cacheWrite ?? 0), 0)
  }
  const batched = valid.filter((r) => r.finderBatched !== null && r.finderBatched !== undefined)
  total.batchedRate =
    batched.length > 0 ? batched.filter((r) => r.finderBatched).length / batched.length : null
  total.invalidReasons = rows
    .filter((r) => r.invalid)
    .reduce((acc, r) => ({ ...acc, [r.invalid]: (acc[r.invalid] ?? 0) + 1 }), {})
  return total
}

/**
 * 配对分析。
 *
 * 比的是同一条用例在两臂下的表现，不是两个边际比例 —— 用例之间难度差别很大
 * （「这工程叫什么」几乎必过，「按坡度筛选散布」可能全挂），比边际比例会把这份
 * 差异全算进噪声。理由同技能路由预登记 §4。
 */
export function pairedDiff(rowsA, rowsB) {
  const byTag = new Map()
  for (const r of rowsA) {
    if (r.invalid) continue
    byTag.set(`${r.tag}#${r.repeat ?? 0}`, { a: r })
  }
  for (const r of rowsB) {
    if (r.invalid) continue
    const key = `${r.tag}#${r.repeat ?? 0}`
    const pair = byTag.get(key)
    if (pair) pair.b = r
  }
  const pairs = [...byTag.values()].filter((p) => p.a && p.b)

  // McNemar 的两个不一致格：只有它们携带配对信息
  const bOnly = pairs.filter((p) => !p.a.hit && p.b.hit).length
  const aOnly = pairs.filter((p) => p.a.hit && !p.b.hit).length
  const both = pairs.filter((p) => p.a.hit && p.b.hit).length
  const neither = pairs.filter((p) => !p.a.hit && !p.b.hit).length

  return {
    pairs: pairs.length,
    both,
    neither,
    /** B 赢的对数 */
    bOnly,
    /** A 赢的对数 */
    aOnly,
    /** 配对差（百分点）。分母是成对的样本数 */
    diffPp: pairs.length > 0 ? ((bOnly - aOnly) / pairs.length) * 100 : 0,
    /**
     * 不一致对太少时任何差都读不出。**这不是可以事后放宽的门槛** ——
     * 预登记里写死：不一致对少于 10，结论直接是「证据不足」，
     * 如实报出所需样本量，不缩小实验去凑一个测不准的结论。
     */
    discordant: bOnly + aOnly
  }
}

/**
 * @param scopeMeasurable 有没有拿到工具索引。没拿到就判不了离题 ——
 *   这时必须印「判不了」，**不能印 0**。那个 0 看着像满分，实际是一次都没检查过
 *   （`tool-selection-metrics.mjs` 早就写着这条，2026-09-11 首跑还是踩了：
 *   索引取错了字段，离题整轮没判，报告里却是一行漂亮的 0）。
 */
export function formatReport(armA, armB, diff, scopeMeasurable = true) {
  const L = []
  L.push('工具选择 A/B')
  L.push('')
  L.push('                     A（全给）      B（finder）')
  const row = (label, a, b) => L.push(`  ${label.padEnd(16)} ${String(a).padEnd(14)} ${b}`)
  row('有效样本', armA.n, armB.n)
  row('无效样本', armA.invalid, armB.invalid)
  row(
    '必需工具命中',
    `${armA.hits} (${pct(armA.hits, armA.n)})`,
    `${armB.hits} (${pct(armB.hits, armB.n)})`
  )
  row('  检索缺口', armA.retrieval, armB.retrieval)
  row('  混淆缺口', armA.confusion, armB.confusion)
  // 「一手都没出」既不是混淆也不是检索缺口 —— 模型讲了一通就结束了。
  // 它高说明题面还是逼着模型先去查，那是 v1 废掉的那个病复发
  row('  一手都没出', armA.noDomainCall, armB.noDomainCall)
  row('多取了组', '-', `${armB.extraGroupSamples} 条 / 共 ${armB.extraGroupCount} 组`)
  // 预料到的那部分单列：它高说明混淆是可预测的（改 finder 摘要能修），
  // 低说明模型是在按我们想不到的方式串门
  row('  其中预料到的', '-', armB.predicted)
  row('白花的 finder', '-', armB.finderWaste)
  row('兜底调用', armA.fallbacks, armB.fallbacks)
  if (scopeMeasurable) row('离题调用', armA.offScope, armB.offScope)
  else L.push('  离题调用         判不了（没拿到工具索引，不知道每个工具属于哪个命名空间）')
  row('模型响应次数', armA.steps, armB.steps)
  row('工具调用次数', armA.toolCalls, armB.toolCalls)
  row('一次取完比例', '-', armB.batchedRate === null ? '(没有多组样本)' : pct(armB.batchedRate, 1))
  L.push('')
  L.push('  token（合计）')
  row('  未缓存 input', armA.input, armB.input)
  row('  缓存读', armA.cacheRead, armB.cacheRead)
  row('  缓存写', armA.cacheWrite, armB.cacheWrite)

  L.push('')
  L.push('配对分析（同一条用例自己跟自己比）')
  L.push(`  成对样本 ${diff.pairs}，两臂都对 ${diff.both}，都错 ${diff.neither}`)
  L.push(`  只有 B 对 ${diff.bOnly}，只有 A 对 ${diff.aOnly} —— 不一致对 ${diff.discordant}`)
  L.push(`  配对差 ${diff.diffPp >= 0 ? '+' : ''}${diff.diffPp.toFixed(1)} 个百分点`)
  if (diff.discordant < 10) {
    L.push('')
    L.push('  ⚠ 不一致对少于 10，这个差读不出来。按预登记，结论是「证据不足」，')
    L.push('    不是「没有改善」，也不是「有改善」。要补样本。')
  }

  // 逐项相加，**不能用展开合并** —— 两臂都有 `model-error` 时，展开会让后一个
  // 盖掉前一个，报出去的条数比实际少一半，而这正是「不许静默剔除」要防的
  const reasons = {}
  for (const src of [armA.invalidReasons, armB.invalidReasons]) {
    for (const [k, v] of Object.entries(src ?? {})) reasons[k] = (reasons[k] ?? 0) + v
  }
  if (Object.keys(reasons).length > 0) {
    L.push('')
    L.push('  无效样本的原因（不许静默剔除）：')
    for (const [k, v] of Object.entries(reasons)) L.push(`    ${k}: ${v}`)
  }

  return L.join('\n')
}
